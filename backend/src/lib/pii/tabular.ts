/**
 * PII Shield integration for the tabular-review (Analize) LLM paths.
 *
 * The tabular routes differ from chat in two ways that shape this module:
 *
 *  1. There is no per-chat `pii_mode` — the privacy posture comes from the
 *     REVIEW OWNER's `user_profiles.pii_default_mode`. Documents in a review
 *     are the owner's data, so the owner's setting governs every LLM call a
 *     collaborator triggers on that review.
 *
 *  2. The tabular UI has no placeholder-render hook (chat swaps
 *     `⟦PII:…⟧` tokens client-side via `usePiiRenderedText`). Cell values
 *     and tabular-chat prose must therefore be de-anonymized SERVER-side
 *     before they are stored / streamed, so the owner keeps seeing real
 *     values. De-anonymize failures keep the placeholders (fail-safe).
 *
 * Session-reuse design
 * ====================
 * One shield session per review. We pass the REVIEW id as the shield's
 * `chat_id`: `pii_sessions.chat_id` is an opaque UUID in the shield's own
 * database (no FK to core `chats` since the #14 DB split), and
 * `get_or_create_chat_session` is an atomic upsert keyed on it — so every
 * cell extraction, regenerate, column suggestion and tabular chat of the
 * same review lands in the SAME session and coreference stays stable
 * (⟦PII:PERSON_1⟧ means the same person across all cells and runs).
 * Collision with real chat ids is impossible in practice (both are v4
 * UUIDs from different tables). Routes with no review context
 * (`/tabular-review/prompt`) fall back to a standalone session
 * (chat_id NULL, 30-day TTL) created by the first anonymize call.
 *
 * Failure semantics (approved design)
 * ===================================
 *  - anonymize fails, mode strict / strict_legal → the caller fails the
 *    cell/request (never send raw text to the LLM).
 *  - anonymize fails, mode standard → fail-open with a `[pii]` warn.
 *  - deanonymize fails → keep placeholders in the output + `[pii]` warn.
 */

import { createServerSupabase } from "../supabase";
import { getUserModelSettings } from "../userSettings";
import { effectiveMode, piiActive } from "./gate";
import { piiClient, containsPlaceholder, type PiiMode } from "./client";
import {
    extractPlaceholders,
    replacePlaceholders,
    safeTextForDrip,
} from "./placeholders";

export interface TabularPiiContext {
    /** Review owner — the shield session belongs to them. */
    ownerId: string;
    mode: PiiMode;
    language: "hr" | "en";
    /** Shield session key (sent as `chat_id`); null → standalone session. */
    reviewId: string | null;
    /** Resolved by the first successful anonymize call, then reused. */
    sessionId: string | null;
}

/** strict + strict_legal fail CLOSED on anonymize errors; standard fails open. */
export function tabularPiiFailsClosed(mode: PiiMode): boolean {
    return mode === "strict" || mode === "strict_legal";
}

/**
 * Owner's tier from `user_tier_state` (the only per-user tier source we
 * can read without the owner's JWT). Missing / expired row → null.
 */
async function lookupOwnerTierLevelId(ownerId: string): Promise<number | null> {
    try {
        const { getPool } = await import("../db");
        const pool = await getPool();
        const r = await pool.query<{
            active_tier_level_id: number | null;
            active_tier_until: string | null;
        }>(
            `SELECT active_tier_level_id, active_tier_until
               FROM public.user_tier_state WHERE user_id = $1`,
            [ownerId],
        );
        const row = r.rows[0];
        if (!row || row.active_tier_level_id == null) return null;
        if (row.active_tier_until && new Date(row.active_tier_until) < new Date())
            return null;
        return row.active_tier_level_id;
    } catch (err) {
        console.warn(
            "[pii.tabular] owner tier lookup failed (skipping entitlement gate):",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

/**
 * Resolve the PII context for a tabular LLM call, or null when the shield
 * must stay out of the way (mode off, sidecar not deployed, or the owner's
 * tier lacks the `piiAnonymization` entitlement). Users with PII off — the
 * default — resolve to null before any shield/network traffic, so this
 * path is a zero-cost no-op for them.
 *
 * Entitlement gate mirrors chat.ts: when the requester IS the owner we use
 * the request's `tierLevelId`; for a collaborator on a shared review we
 * look the owner's tier up in `user_tier_state`. An unknown tier skips the
 * gate (same as chat.ts when `tierLevelId` is missing) — the leak-safe
 * direction: better to shield an unentitled run than to leak an entitled one.
 */
export async function resolveTabularPiiContext(args: {
    ownerId: string;
    requesterId: string;
    requesterTierLevelId?: number;
    reviewId: string | null;
    language: "hr" | "en";
    db?: ReturnType<typeof createServerSupabase>;
}): Promise<TabularPiiContext | null> {
    try {
        if (!piiClient.isConfigured()) return null;
        const ownerSettings = await getUserModelSettings(args.ownerId, args.db);
        const mode = effectiveMode(null, ownerSettings);
        if (!piiActive(mode)) return null;

        const tierLevelId =
            args.ownerId === args.requesterId &&
            typeof args.requesterTierLevelId === "number"
                ? args.requesterTierLevelId
                : await lookupOwnerTierLevelId(args.ownerId);
        if (typeof tierLevelId === "number") {
            const { getEntitlements, can } = await import("../entitlements");
            if (!can(await getEntitlements(tierLevelId), "piiAnonymization")) {
                return null;
            }
        }

        return {
            ownerId: args.ownerId,
            mode,
            language: args.language,
            reviewId: args.reviewId,
            sessionId: null,
        };
    } catch (err) {
        console.warn(
            "[pii.tabular] context resolution failed (treating as off):",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

export type TabularAnonymizeResult =
    | { ok: true; text: string }
    | { ok: false; error: string };

/**
 * Anonymize one text through the review's shield session. Mutates
 * `ctx.sessionId` on first success so subsequent calls reuse the session
 * directly. Safe to call concurrently: parallel first calls all resolve to
 * the same session (atomic upsert keyed on `chat_id = reviewId`).
 */
export async function anonymizeTabularText(
    ctx: TabularPiiContext,
    text: string,
    opts: {
        source: "document" | "user_input";
        documentVersionId?: string | null;
    },
): Promise<TabularAnonymizeResult> {
    if (!text.trim()) return { ok: true, text };
    const res = await piiClient.anonymize({
        text,
        userId: ctx.ownerId,
        mode: ctx.mode,
        language: ctx.language,
        sessionId: ctx.sessionId,
        chatId: ctx.sessionId ? null : ctx.reviewId,
        documentVersionId: opts.documentVersionId ?? null,
        source: opts.source,
    });
    if (!res.ok) return { ok: false, error: res.error };
    ctx.sessionId = res.data.session_id;
    return { ok: true, text: res.data.anonymized_text };
}

/**
 * Record-separator sentinel for batching many small texts (cell values,
 * column names/prompts) into few shield round-trips. U+241E (␞, SYMBOL FOR
 * RECORD SEPARATOR) never occurs in extracted legal text, and Presidio
 * only rewrites detected entity spans, so the separators survive the
 * round-trip intact. A split-count mismatch is treated as an anonymize
 * failure (never guess which text is which).
 */
const BATCH_SEP = "\n␞␞\n";
const BATCH_CHUNK_CHARS = 200_000;

export async function anonymizeTabularBatch(
    ctx: TabularPiiContext,
    texts: string[],
    opts: { source: "document" | "user_input" },
): Promise<{ ok: true; texts: string[] } | { ok: false; error: string }> {
    if (texts.length === 0) return { ok: true, texts: [] };
    // Group into size-capped chunks so one call never exceeds what the
    // shield comfortably analyzes within the client timeout.
    const out: string[] = new Array(texts.length);
    let group: number[] = [];
    let groupLen = 0;
    const flush = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
        if (group.length === 0) return { ok: true };
        const joined = group.map((i) => texts[i]).join(BATCH_SEP);
        const res = await anonymizeTabularText(ctx, joined, opts);
        if (!res.ok) return res;
        const parts = res.text.split(BATCH_SEP);
        if (parts.length !== group.length) {
            return { ok: false, error: "batch separator mismatch after anonymize" };
        }
        group.forEach((idx, j) => {
            out[idx] = parts[j];
        });
        group = [];
        groupLen = 0;
        return { ok: true };
    };
    for (let i = 0; i < texts.length; i++) {
        if (groupLen > 0 && groupLen + texts[i].length > BATCH_CHUNK_CHARS) {
            const r = await flush();
            if (!r.ok) return r;
        }
        group.push(i);
        groupLen += texts[i].length + BATCH_SEP.length;
    }
    const r = await flush();
    if (!r.ok) return r;
    return { ok: true, texts: out };
}

/**
 * Fail-safe server-side de-anonymization of an LLM output value (cell
 * JSON, suggested columns, chat title…). Walks every string in `value`
 * through the shield's lenient `/deanonymize-json` (unknown placeholders
 * stay verbatim — exactly the fail-safe the design asks for). On any
 * shield error the INPUT is returned unchanged (placeholders kept) with a
 * `[pii]` warn.
 */
export async function deanonymizeTabularJson<T>(
    ctx: TabularPiiContext,
    value: T,
): Promise<T> {
    if (!ctx.sessionId) return value;
    try {
        if (!containsPlaceholder(JSON.stringify(value) ?? "")) return value;
    } catch {
        return value;
    }
    const res = await piiClient.deanonymizeJson(ctx.sessionId, value);
    if (!res.ok) {
        console.warn(
            "[pii] tabular deanonymize failed — keeping placeholders:",
            res.error,
        );
        return value;
    }
    return res.data as T;
}

/**
 * Resolve a placeholder → original map for a set of anonymized input
 * texts, in ONE shield round-trip. The tabular chat uses this so its SSE
 * writer can restore placeholders in streamed deltas synchronously — the
 * model can only echo placeholders that appeared in its (anonymized)
 * inputs, so the map is complete; anything outside it is a hallucinated
 * placeholder and deliberately stays masked.
 */
export async function buildTabularPlaceholderMap(
    ctx: TabularPiiContext,
    texts: string[],
): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ctx.sessionId) return map;
    const distinct = [
        ...new Set(texts.flatMap((t) => extractPlaceholders(t ?? ""))),
    ];
    if (distinct.length === 0) return map;
    const res = await piiClient.deanonymizeJson(ctx.sessionId, distinct);
    if (!res.ok || !Array.isArray(res.data)) {
        console.warn(
            "[pii] tabular placeholder-map build failed — output stays masked:",
            res.ok ? "unexpected shape" : res.error,
        );
        return map;
    }
    (res.data as unknown[]).forEach((v, i) => {
        if (typeof v === "string" && v !== distinct[i]) map.set(distinct[i], v);
    });
    return map;
}

/**
 * Deep string collect / rebuild pair for anonymizing structured inputs
 * (e.g. a columns_config array) through one `anonymizeTabularBatch` call.
 * Both walk the value in identical order, so
 * `rebuildStringsDeep(v, await batch(collectStringsDeep(v)))` swaps every
 * string in place while leaving the structure untouched.
 */
export function collectStringsDeep(value: unknown, out: string[] = []): string[] {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value))
        for (const v of value) collectStringsDeep(v, out);
    else if (value && typeof value === "object")
        for (const v of Object.values(value as Record<string, unknown>))
            collectStringsDeep(v, out);
    return out;
}

export function rebuildStringsDeep<T>(
    value: T,
    replacements: string[],
    cursor: { i: number } = { i: 0 },
): T {
    const walk = (node: unknown): unknown => {
        if (typeof node === "string") return replacements[cursor.i++] ?? node;
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(node as Record<string, unknown>))
                out[k] = walk(v);
            return out;
        }
        return node;
    };
    return walk(value) as T;
}

/** Recursively restore placeholders in every string of a JSON-ish value. */
export function restorePlaceholdersDeep<T>(
    value: T,
    map: ReadonlyMap<string, string>,
): T {
    if (map.size === 0) return value;
    const walk = (node: unknown): unknown => {
        if (typeof node === "string") return replacePlaceholders(node, map);
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(node as Record<string, unknown>))
                out[k] = walk(v);
            return out;
        }
        return node;
    };
    return walk(value) as T;
}

/**
 * Wrap an SSE `write` so streamed model text reaches the client with real
 * values instead of `⟦PII:…⟧` placeholders (the tabular UI has no
 * client-side render hook). `content_delta` events are buffered just
 * enough to never split a placeholder across deltas (`safeTextForDrip`);
 * every other JSON event gets a deep string restore. Purely synchronous —
 * the map is resolved up front via `buildTabularPlaceholderMap`.
 */
export function makeDeanonymizingSseWriter(
    rawWrite: (line: string) => void,
    map: ReadonlyMap<string, string>,
): (line: string) => void {
    if (map.size === 0) return rawWrite;
    let carry = "";
    const flushCarry = () => {
        if (!carry) return;
        // Turn is moving past prose — an unterminated `⟦PII:` fragment at
        // this point is model noise; emit it restored-as-possible.
        rawWrite(
            `data: ${JSON.stringify({
                type: "content_delta",
                text: replacePlaceholders(carry, map),
            })}\n\n`,
        );
        carry = "";
    };
    return (line: string) => {
        const m = line.match(/^data: (\{[\s\S]*\})\n\n$/);
        if (!m) {
            // "[DONE]" markers and anything non-JSON pass through untouched.
            flushCarry();
            rawWrite(line);
            return;
        }
        let ev: unknown;
        try {
            ev = JSON.parse(m[1]);
        } catch {
            flushCarry();
            rawWrite(line);
            return;
        }
        const evt = ev as { type?: unknown; text?: unknown };
        if (evt?.type === "content_delta" && typeof evt.text === "string") {
            const buffered = carry + evt.text;
            const safe = safeTextForDrip(buffered);
            carry = buffered.slice(safe.length);
            if (!safe) return; // withhold until the placeholder completes
            rawWrite(
                `data: ${JSON.stringify({
                    type: "content_delta",
                    text: replacePlaceholders(safe, map),
                })}\n\n`,
            );
            return;
        }
        flushCarry();
        rawWrite(`data: ${JSON.stringify(restorePlaceholdersDeep(ev, map))}\n\n`);
    };
}
