/**
 * Brevo contact-list sync for the newsletter list.
 *
 * Every registered Eulex Desk user lands in one of two Brevo lists,
 * picked by the UI language stored on `user_profiles.preferred_language`:
 *
 *   • `hr` (the DB default) → `BREVO_SIGNUP_LIST_ID`    (prod: 50 "EulexDesk")
 *   • `en`                  → `BREVO_SIGNUP_LIST_ID_EN` (prod: 51 "Eulex_en")
 *
 * Entry points:
 *
 *   • `syncSignupContact()` — fire-and-forget upsert into the list for the
 *     given language, unlinking the contact from the other one so a
 *     language switch MOVES the contact. Called from the auth middleware
 *     when a brand-new `public.users` row is created (both the Supabase
 *     and the legacy WordPress path) and from PATCH /user/profile when
 *     preferred_language changes. NEVER throws and NEVER rejects:
 *     newsletter sync is a side effect and must not delay or break auth.
 *   • `backfillSignupContacts()` — one-shot bulk import of every existing
 *     user into the list for their language (and removal from the other
 *     list), exposed via POST /adminmax/cron/brevo-backfill.
 *
 * Feature gate: unset/invalid `BREVO_SIGNUP_LIST_ID` or missing
 * `BREVO_API_KEY` → no-op (logged once). When the EN list id is unset,
 * every language falls back to the default (hr) list. Uses the Brevo REST API directly
 * via global fetch rather than the SDK so the transactional-email
 * provider (lib/email/brevo.ts) stays untouched.
 *
 * Contact attributes: Brevo accounts differ in which attributes exist
 * (FIRSTNAME/LASTNAME on most, localized names on some, none on a bare
 * account). We fetch the attribute list once per process and only send
 * the ones that exist, since Brevo rejects an import that references an
 * unknown attribute.
 */

import { getPool } from "./db";

const BREVO_API = "https://api.brevo.com/v3";
const IMPORT_CHUNK = 1000;
/** Brevo caps /contacts/lists/{id}/contacts/remove at 150 emails per call. */
const REMOVE_CHUNK = 150;

export type ContactLanguage = "hr" | "en";

export type SignupContact = {
    email: string;
    displayName?: string | null;
    /** UI language from user_profiles.preferred_language; defaults to hr. */
    language?: string | null;
};

type Config = {
    apiKey: string;
    /** hr / default list. */
    listId: number;
    /** en list; null → en users go to the default list too. */
    listIdEn: number | null;
};

function parseListId(raw: string | undefined): number | null {
    const v = Number.parseInt((raw ?? "").trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : null;
}

export function normalizeLanguage(lang: string | null | undefined): ContactLanguage {
    return (lang ?? "").trim().toLowerCase() === "en" ? "en" : "hr";
}

/** Target list for a language, plus the list(s) the contact must leave. */
export function listsFor(cfg: Config, lang: string | null | undefined): {
    target: number;
    unlink: number[];
} {
    const l = normalizeLanguage(lang);
    if (cfg.listIdEn === null || cfg.listIdEn === cfg.listId) {
        return { target: cfg.listId, unlink: [] };
    }
    return l === "en"
        ? { target: cfg.listIdEn, unlink: [cfg.listId] }
        : { target: cfg.listId, unlink: [cfg.listIdEn] };
}

let warnedDisabled = false;

/** Resolve API key + list id from env, or null when the feature is off. */
export function getBrevoContactsConfig(): Config | null {
    const apiKey = (process.env.BREVO_API_KEY ?? "").trim();
    const listId = parseListId(process.env.BREVO_SIGNUP_LIST_ID);
    if (!apiKey || listId === null) {
        if (!warnedDisabled) {
            console.warn(
                "[brevo/contacts] disabled — set BREVO_API_KEY and BREVO_SIGNUP_LIST_ID to sync signups to a Brevo list",
            );
            warnedDisabled = true;
        }
        return null;
    }
    return { apiKey, listId, listIdEn: parseListId(process.env.BREVO_SIGNUP_LIST_ID_EN) };
}

async function brevoFetch(
    cfg: Config,
    path: string,
    init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${BREVO_API}${path}`, {
        method: init.method ?? "GET",
        headers: {
            "api-key": cfg.apiKey,
            accept: "application/json",
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
        try {
            json = JSON.parse(text);
        } catch {
            json = { raw: text };
        }
    }
    return { status: res.status, json };
}

function errMessage(status: number, json: unknown): string {
    const j = json as { code?: string; message?: string } | null;
    const detail = j?.message ?? j?.code ?? "";
    return `Brevo ${status}${detail ? `: ${detail}` : ""}`;
}

// ── attribute discovery ───────────────────────────────────────────────

let knownAttrs: Set<string> | null = null;
let knownAttrsPromise: Promise<Set<string>> | null = null;

/**
 * Names of "normal" contact attributes present in the Brevo account,
 * uppercased. Cached for the process lifetime; a failed lookup yields an
 * empty set (email-only sync) and is retried on the next call.
 */
async function getKnownAttributes(cfg: Config): Promise<Set<string>> {
    if (knownAttrs) return knownAttrs;
    if (knownAttrsPromise) return knownAttrsPromise;
    knownAttrsPromise = (async () => {
        try {
            const { status, json } = await brevoFetch(cfg, "/contacts/attributes");
            if (status !== 200) {
                console.warn(`[brevo/contacts] attribute lookup failed: ${errMessage(status, json)}`);
                return new Set<string>();
            }
            const list =
                (json as { attributes?: Array<{ name?: string; category?: string }> })
                    ?.attributes ?? [];
            const names = new Set<string>();
            for (const a of list) {
                if (typeof a.name === "string" && (a.category ?? "normal") === "normal") {
                    names.add(a.name.toUpperCase());
                }
            }
            knownAttrs = names;
            return names;
        } catch (err) {
            console.warn(
                "[brevo/contacts] attribute lookup threw:",
                err instanceof Error ? err.message : err,
            );
            return new Set<string>();
        } finally {
            knownAttrsPromise = null;
        }
    })();
    return knownAttrsPromise;
}

/** For tests. */
export function _resetBrevoContactsCacheForTesting(): void {
    knownAttrs = null;
    knownAttrsPromise = null;
    warnedDisabled = false;
}

/**
 * Split a display name into FIRSTNAME / LASTNAME the way Brevo expects.
 * "Ivana Horvat" → {FIRSTNAME: "Ivana", LASTNAME: "Horvat"}; a single
 * token (or an email-local-part fallback) goes to FIRSTNAME only.
 * Only attributes that exist in the account are emitted.
 */
export function buildAttributes(
    displayName: string | null | undefined,
    known: Set<string>,
): Record<string, string> {
    const out: Record<string, string> = {};
    const name = (displayName ?? "").trim().replace(/\s+/g, " ");
    if (!name) return out;
    const sp = name.indexOf(" ");
    const first = sp === -1 ? name : name.slice(0, sp);
    const last = sp === -1 ? "" : name.slice(sp + 1);
    if (known.has("FIRSTNAME")) out.FIRSTNAME = first;
    if (last && known.has("LASTNAME")) out.LASTNAME = last;
    return out;
}

function normalizeEmail(email: string): string | null {
    const e = (email ?? "").trim().toLowerCase();
    // Cheap sanity check — Brevo rejects malformed addresses with a 400
    // and we don't want that noise for placeholder/legacy rows.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// ── single contact (signup hook) ──────────────────────────────────────

export type SyncResult =
    | { ok: true; created: boolean }
    | { ok: false; skipped: true; reason: string }
    | { ok: false; error: string };

/**
 * Upsert one contact into the list for its language. `updateEnabled:
 * true` makes Brevo merge into an existing contact (adding the list
 * membership) instead of failing with `duplicate_parameter`, and
 * `unlinkListIds` drops it from the other language's list so this is
 * also the "language changed" path.
 *
 * Never throws. Safe to call as `void syncSignupContact(...)`.
 */
export async function syncSignupContact(c: SignupContact): Promise<SyncResult> {
    try {
        const cfg = getBrevoContactsConfig();
        if (!cfg) return { ok: false, skipped: true, reason: "not configured" };
        const email = normalizeEmail(c.email);
        if (!email) return { ok: false, skipped: true, reason: "invalid email" };

        const known = await getKnownAttributes(cfg);
        const { target, unlink } = listsFor(cfg, c.language);
        const { status, json } = await brevoFetch(cfg, "/contacts", {
            method: "POST",
            body: {
                email,
                attributes: buildAttributes(c.displayName, known),
                listIds: [target],
                ...(unlink.length ? { unlinkListIds: unlink } : {}),
                updateEnabled: true,
            },
        });
        // 201 = created, 204 = existing contact updated.
        if (status === 201 || status === 204) {
            console.log(`[brevo/contacts] synced contact to list ${target} (${normalizeLanguage(c.language)}, ${status === 201 ? "created" : "updated"})`);
            return { ok: true, created: status === 201 };
        }
        const error = errMessage(status, json);
        console.error(`[brevo/contacts] signup sync failed: ${error}`);
        return { ok: false, error };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error(`[brevo/contacts] signup sync threw: ${error}`);
        return { ok: false, error };
    }
}

// ── bulk backfill ─────────────────────────────────────────────────────

export type BackfillResult = {
    lists: { hr: number; en: number | null };
    users: number;
    byLanguage: { hr: number; en: number };
    skippedInvalid: number;
    chunks: number;
    /** Brevo async import process ids (one per chunk). */
    processIds: number[];
    /** Contacts removed from the *other* language's list. */
    unlinked: { hr: number; en: number };
    errors: string[];
};

type ImportContact = { email: string; attributes: Record<string, string> };

/**
 * Import every `public.users` row into the list for its language via
 * Brevo's bulk import endpoint (async on Brevo's side — returns process
 * ids; existing contacts are updated, not duplicated), then remove each
 * group from the other language's list so users who moved languages (or
 * were imported before the split) end up in exactly one list. Throws
 * only on config errors; per-call API failures are collected in `errors`.
 */
export async function backfillSignupContacts(): Promise<BackfillResult> {
    const cfg = getBrevoContactsConfig();
    if (!cfg) {
        throw new Error("BREVO_API_KEY / BREVO_SIGNUP_LIST_ID not configured");
    }
    const pool = await getPool();
    const { rows } = await pool.query<{
        email: string;
        display_name: string | null;
        preferred_language: string | null;
    }>(
        `SELECT DISTINCT ON (lower(u.email))
                u.email, u.display_name, p.preferred_language
           FROM public.users u
           LEFT JOIN public.user_profiles p ON p.user_id = u.id
          WHERE u.email IS NOT NULL AND u.email <> ''
          ORDER BY lower(u.email), u.created_at ASC`,
    );
    const known = await getKnownAttributes(cfg);

    const groups: Record<ContactLanguage, ImportContact[]> = { hr: [], en: [] };
    let skippedInvalid = 0;
    for (const r of rows) {
        const email = normalizeEmail(r.email);
        if (!email) {
            skippedInvalid++;
            continue;
        }
        groups[normalizeLanguage(r.preferred_language)].push({
            email,
            attributes: buildAttributes(r.display_name, known),
        });
    }

    const result: BackfillResult = {
        lists: { hr: cfg.listId, en: cfg.listIdEn },
        users: groups.hr.length + groups.en.length,
        byLanguage: { hr: groups.hr.length, en: groups.en.length },
        skippedInvalid,
        chunks: 0,
        processIds: [],
        unlinked: { hr: 0, en: 0 },
        errors: [],
    };

    for (const lang of ["hr", "en"] as const) {
        const contacts = groups[lang];
        if (!contacts.length) continue;
        const { target, unlink } = listsFor(cfg, lang);

        for (let i = 0; i < contacts.length; i += IMPORT_CHUNK) {
            const chunk = contacts.slice(i, i + IMPORT_CHUNK);
            result.chunks++;
            try {
                const { status, json } = await brevoFetch(cfg, "/contacts/import", {
                    method: "POST",
                    body: {
                        jsonBody: chunk,
                        listIds: [target],
                        updateExistingContacts: true,
                        emptyContactsAttributes: false,
                        emailBlacklist: false,
                        smsBlacklist: false,
                    },
                });
                const pid = (json as { processId?: number } | null)?.processId;
                if ((status === 202 || status === 200) && typeof pid === "number") {
                    result.processIds.push(pid);
                } else {
                    result.errors.push(`import ${lang} chunk ${result.chunks}: ${errMessage(status, json)}`);
                }
            } catch (err) {
                result.errors.push(
                    `import ${lang} chunk ${result.chunks}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }

        // Leave the other language's list. Brevo answers 204 for the
        // removal and 400 when none of the emails were in the list —
        // we treat that 400 as "nothing to do", not an error.
        for (const otherList of unlink) {
            for (let i = 0; i < contacts.length; i += REMOVE_CHUNK) {
                const emails = contacts.slice(i, i + REMOVE_CHUNK).map((c) => c.email);
                try {
                    const { status, json } = await brevoFetch(
                        cfg,
                        `/contacts/lists/${otherList}/contacts/remove`,
                        { method: "POST", body: { emails } },
                    );
                    if (status === 201 || status === 200 || status === 204) {
                        const j = json as { contacts?: { success?: string[] } } | null;
                        result.unlinked[lang] += j?.contacts?.success?.length ?? emails.length;
                    } else if (status !== 400) {
                        result.errors.push(`unlink ${lang} from list ${otherList}: ${errMessage(status, json)}`);
                    }
                } catch (err) {
                    result.errors.push(
                        `unlink ${lang} from list ${otherList}: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }
        }
    }

    console.log(
        `[brevo/contacts] backfill → hr ${result.byLanguage.hr} (list ${cfg.listId}), en ${result.byLanguage.en} (list ${cfg.listIdEn ?? cfg.listId}), ${result.chunks} chunks, ${result.errors.length} errors`,
    );
    return result;
}
