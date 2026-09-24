/**
 * Mike AdminMax MCP server (FastMCP).
 *
 * ADMIN-ONLY. A thin Model-Context-Protocol wrapper over the existing
 * AdminMax REST API (`/adminmax/*`). It holds NO database of its own — every
 * tool calls the backend, which already enforces all the business rules,
 * idempotency and audit logging. This service only adds:
 *
 *   1. Inbound auth: the MCP client MUST send `Authorization: Bearer
 *      <EULEX_ADMIN_MCP_TOKEN>`. Anyone without it is rejected (401). This is
 *      the admin gate — there is no per-user identity, exactly like AdminMax.
 *   2. Outbound auth: the server logs into AdminMax once with
 *      `ADMIN_MAX_PASSWORD`, caches the short-lived JWT, and refreshes it on
 *      expiry / 401.
 *
 * Transport: HTTP streaming (Cloud Run friendly, stateless), endpoint `/mcp`.
 *
 * Env:
 *   EULEX_ADMIN_MCP_TOKEN  — required; the inbound bearer secret.
 *   ADMIN_API_BASE         — backend base URL (default https://api.eulex.ai).
 *   ADMIN_MAX_PASSWORD     — required; AdminMax password used to mint a JWT.
 *   ADMIN_MCP_REDACT       — "0"/"off"/"false" disables PII redaction (ON by
 *                            default; see the redaction section below).
 *   PORT                   — listen port (default 8080; Cloud Run sets it).
 */
import { FastMCP, UserError } from "fastmcp";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

const ADMIN_API_BASE = (
    process.env.ADMIN_API_BASE ?? "https://api.eulex.ai"
).replace(/\/+$/, "");
const INBOUND_TOKEN = process.env.EULEX_ADMIN_MCP_TOKEN ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_MAX_PASSWORD ?? "";
const PORT = Number(process.env.PORT ?? 8080);

if (!INBOUND_TOKEN) {
    console.error("[admin-mcp] FATAL: EULEX_ADMIN_MCP_TOKEN is not set");
    process.exit(1);
}
if (!ADMIN_PASSWORD) {
    console.error("[admin-mcp] FATAL: ADMIN_MAX_PASSWORD is not set");
    process.exit(1);
}

// ── inbound auth (admin gate) ───────────────────────────────────────────────

function constantTimeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    const len = Math.max(ab.length, bb.length);
    const pa = Buffer.alloc(len);
    const pb = Buffer.alloc(len);
    ab.copy(pa);
    bb.copy(pb);
    return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

function bearerFrom(headers: Record<string, unknown>): string {
    const raw = headers["authorization"] ?? headers["Authorization"];
    const h = Array.isArray(raw) ? raw[0] : raw;
    if (typeof h !== "string") return "";
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : "";
}

// ── outbound auth (AdminMax JWT, cached) ────────────────────────────────────

let cachedToken: { jwt: string; expMs: number } | null = null;

async function adminLogin(): Promise<string> {
    const res = await fetch(`${ADMIN_API_BASE}/adminmax/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    if (!res.ok) {
        throw new Error(
            `AdminMax login failed (${res.status}): ${await res.text()}`,
        );
    }
    const data = (await res.json()) as { token: string; expiresAt?: string };
    // Refresh a minute before the JWT's stated expiry (default 8h).
    const expMs = data.expiresAt
        ? new Date(data.expiresAt).getTime() - 60_000
        : Date.now() + 7 * 60 * 60 * 1000;
    cachedToken = { jwt: data.token, expMs };
    return data.token;
}

async function adminToken(): Promise<string> {
    if (cachedToken && cachedToken.expMs > Date.now()) return cachedToken.jwt;
    return adminLogin();
}

// ── redaction (identifying data must not reach the LLM) ─────────────────────
//
// AdminMax responses carry personal data — email, name, IP, free-text payment
// notes. The dashboard shows those to a human operator; here they would land
// in an MCP client's context, so they are stripped on the way out.
//
// ON by default: this is a safety default, and an env var that has to be
// remembered to be safe is not one. Set ADMIN_MCP_REDACT=0 (or off/false) to
// disable, deliberately.
//
// Uuids survive redaction, so every tool still works: look a user up by email
// (input is never redacted — only what we return), then act on the id.

const REDACT = !["0", "off", "false"].includes(
    (process.env.ADMIN_MCP_REDACT ?? "").trim().toLowerCase(),
);

/** Field names whose value is identifying regardless of content. */
const REDACT_KEYS = new Set([
    "email",
    "display_name",
    "ip",
    "actor",
    "notes",
    "external_reference",
]);

// Catch-all for addresses embedded in free text the key list can't predict —
// audit `payload` jsonb, backend error strings, a name typed into notes.
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

const REDACTED = "[redacted]";

function scrubString(s: string): string {
    return s.replace(EMAIL_RE, REDACTED);
}

/** Recursively blank identifying fields. Structure and all numbers survive. */
function redact(node: unknown): unknown {
    if (typeof node === "string") return scrubString(node);
    if (Array.isArray(node)) return node.map(redact);
    if (node && typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
            out[k] = REDACT_KEYS.has(k) && v !== null ? REDACTED : redact(v);
        }
        return out;
    }
    return node;
}

/**
 * Call an AdminMax endpoint with the cached admin JWT. Re-logs in once on a
 * 401 (token rotated / expired). Returns parsed JSON; throws UserError with
 * the backend's detail on a non-2xx so the MCP client sees a clean message.
 *
 * The response is redacted unless `raw` is set. `raw` is for values consumed
 * inside this process only — never for anything a tool returns.
 */
async function adminFetch<T = unknown>(
    path: string,
    init: {
        method?: string;
        body?: unknown;
        query?: Record<string, string | number | boolean | undefined>;
        raw?: boolean;
    } = {},
): Promise<T> {
    const url = new URL(`${ADMIN_API_BASE}/adminmax${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
        if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const doCall = async (jwt: string) =>
        fetch(url, {
            method: init.method ?? "GET",
            headers: {
                Authorization: `Bearer ${jwt}`,
                ...(init.body !== undefined
                    ? { "Content-Type": "application/json" }
                    : {}),
            },
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });

    let res = await doCall(await adminToken());
    if (res.status === 401) {
        cachedToken = null;
        res = await doCall(await adminLogin());
    }
    const text = await res.text();
    if (!res.ok) {
        let detail = text;
        try {
            detail = (JSON.parse(text) as { detail?: string }).detail ?? text;
        } catch {
            /* keep raw text */
        }
        throw new UserError(
            `AdminMax ${path} → ${res.status}: ${
                REDACT ? scrubString(String(detail)) : detail
            }`,
        );
    }
    const parsed: unknown = text ? JSON.parse(text) : {};
    return (REDACT && !init.raw ? redact(parsed) : parsed) as T;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Resolve a user reference (uuid or email) to a uuid via the search list.
 *
 * Reads the list `raw` — it has to compare the real email to pick the exact
 * match. Only the uuid escapes this function, so nothing identifying reaches
 * the caller.
 */
async function resolveUserId(ref: string): Promise<string> {
    const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ref,
        );
    if (isUuid) return ref;
    const r = await adminFetch<{ users: Array<{ id: string; email: string }> }>(
        "/users",
        { query: { q: ref, limit: 5 }, raw: true },
    );
    const exact = r.users.find(
        (u) => u.email.toLowerCase() === ref.toLowerCase(),
    );
    const hit = exact ?? r.users[0];
    if (!hit) throw new UserError(`No user found matching "${ref}"`);
    return hit.id;
}

// ── shared parameter shapes ─────────────────────────────────────────────────
//
// The AdminMax list endpoints all take the same date window
// (`parseDateRange`, default last 30 days) and pagination
// (`parsePagination`, limit 1–500 default 50). Declared once so every tool
// exposes the same names and bounds the backend actually honours.

const rangeShape = {
    from: z.string().optional().describe("ISO start of the window"),
    to: z.string().optional().describe("ISO end of the window"),
};

const pageShape = {
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
};

// ── server + tools ──────────────────────────────────────────────────────────

const server = new FastMCP({
    name: "Mike AdminMax",
    version: "0.1.0",
    // Admin gate: reject anyone without the shared admin token.
    authenticate: async (request) => {
        const headers = (request.headers ?? {}) as Record<string, unknown>;
        const token = bearerFrom(headers);
        if (!token || !constantTimeEq(token, INBOUND_TOKEN)) {
            throw new Response("Unauthorized", { status: 401 });
        }
        return { admin: true };
    },
});

// ---- READ ----

server.addTool({
    name: "get_overview",
    description:
        "High-level AdminMax overview: total & new users, request/cost/token totals, and subscription run-rate (MRR, ARR, ARPU, NRR). Optional ISO date range (defaults to last 30 days for usage totals).",
    parameters: z.object({
        from: z.string().optional().describe("ISO start (usage range)"),
        to: z.string().optional().describe("ISO end (usage range)"),
    }),
    execute: async (args) => {
        const [users, analytics] = await Promise.all([
            adminFetch<{ totals: Record<string, number> }>("/users", {
                query: { from: args.from, to: args.to, limit: 1 },
            }),
            adminFetch<{ revenue_metrics: unknown; totals: unknown }>(
                "/analytics",
                { query: { from: args.from, to: args.to } },
            ),
        ]);
        return json({
            users_totals: users.totals,
            analytics_totals: analytics.totals,
            revenue_metrics: analytics.revenue_metrics,
        });
    },
});

server.addTool({
    name: "list_users",
    description:
        "List users with rolled-up usage/cost. Search by email or name; filter by tier_level_id; sort and paginate.",
    parameters: z.object({
        q: z.string().optional().describe("email or name substring"),
        tier: z.number().int().optional().describe("filter by tier_level_id"),
        only_active: z.boolean().optional().describe("only users with ≥1 request"),
        created_after: z
            .string()
            .optional()
            .describe("ISO — only users registered on/after this instant"),
        sort: z
            .enum(["cost", "requests", "errors", "last_used", "email", "created", "last_login", "tier"])
            .optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        ...pageShape,
        ...rangeShape,
    }),
    execute: async (a) => {
        const r = await adminFetch("/users", {
            query: {
                q: a.q,
                tier: a.tier,
                only_active: a.only_active,
                created_after: a.created_after,
                sort: a.sort,
                dir: a.dir,
                limit: a.limit ?? 25,
                offset: a.offset,
                from: a.from,
                to: a.to,
            },
        });
        return json(r);
    },
});

server.addTool({
    name: "get_user",
    description:
        "Full detail for one user (by uuid or email): identity, tier, login, Supabase auth, and usage totals in the range.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        ...rangeShape,
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        const r = await adminFetch(`/users/${id}`, {
            query: { from: a.from, to: a.to },
        });
        return json(r);
    },
});

server.addTool({
    name: "get_analytics",
    description:
        "Growth/usage/revenue time series + tier distribution + subscription run-rate metrics for a date range.",
    parameters: z.object({ ...rangeShape }),
    execute: async (a) => {
        const r = await adminFetch("/analytics", {
            query: { from: a.from, to: a.to },
        });
        return json(r);
    },
});

server.addTool({
    name: "list_tiers",
    description:
        "List subscription tiers (tier_limits): id, slug, label, daily token quota, user_count, entitlements.",
    parameters: z.object({}),
    execute: async () => json(await adminFetch("/tiers")),
});

server.addTool({
    name: "new_users",
    description:
        "Count + recent signups since the operator's last login (the AdminMax new-users badge feed).",
    parameters: z.object({}),
    execute: async () => json(await adminFetch("/new-users")),
});

server.addTool({
    name: "get_entitlement_catalog",
    description:
        "The entitlement catalog: every gate key, its type (bool/int), group, labels, and per-tier defaults. Read this before calling update_tier_limit with `entitlements` — only catalog keys are accepted, everything else is silently dropped.",
    parameters: z.object({}),
    execute: async () => json(await adminFetch("/entitlement-catalog")),
});

server.addTool({
    name: "get_tier_history",
    description:
        "Audit trail of tier changes for one user: old/new tier, old/new expiry, source (admin, stripe, ump…) and when.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        return json(await adminFetch(`/users/${id}/tier-history`));
    },
});

server.addTool({
    name: "get_user_usage",
    description:
        "Per-request LLM usage rows for one user (provider, model, chat id, iterations, tokens, cost, status). The place to look when diagnosing spend or errors for a specific account.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        ...rangeShape,
        ...pageShape,
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        return json(
            await adminFetch(`/users/${id}/usage`, {
                query: { from: a.from, to: a.to, limit: a.limit, offset: a.offset },
            }),
        );
    },
});

server.addTool({
    name: "get_user_credits",
    description:
        "Bonus token packs granted to a user — every grant (including voided and Stripe-sourced ones) plus the live remaining balance.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        return json(await adminFetch(`/users/${id}/credits`));
    },
});

server.addTool({
    name: "get_audit",
    description:
        "Admin action audit trail, newest first. `q` matches the action, actor, target type or target id (e.g. \"tier.update\", \"credits.grant\", a user uuid).",
    parameters: z.object({
        q: z.string().optional().describe("substring: action / actor / target"),
        ...rangeShape,
        ...pageShape,
    }),
    execute: async (a) =>
        json(
            await adminFetch("/audit", {
                query: { q: a.q, from: a.from, to: a.to, limit: a.limit, offset: a.offset },
            }),
        ),
});

// DELIBERATELY NOT EXPOSED — conversation content.
//
//   GET /adminmax/chats            (titles + message-content search)
//   GET /adminmax/chats/:id/full   (the whole thread)
//   GET /adminmax/users/:id/messages
//
// These return end-user legal questions and answers. The AdminMax dashboard
// shows them to a human operator; an MCP tool would instead pipe them into an
// LLM client's context, which is a different thing entirely and not something
// our users consented to. Read them in the dashboard.
//
// Do not "restore missing coverage" here — the omission is the point.
// `get_user_usage` already covers per-request diagnostics (model, tokens,
// cost, status, chat_id) without any message bodies.

// ---- WRITE (the backend logs an audit trail + enforces guards) ----

server.addTool({
    name: "set_user_tier",
    description:
        "Set or clear a user's subscription tier (manual override). tier_level_id null → clear the override, back to Free. Optional 'until' ISO expiry (must be in the future) and audit 'reason'. Mirrors to UMP like the dashboard.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        tier_level_id: z
            .number()
            .int()
            .nullable()
            .describe("target tier id (positive); null = clear override → Free"),
        until: z.string().nullable().optional().describe("ISO expiry; null = no expiry"),
        reason: z.string().optional().describe("audit reason"),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        // The backend rejects 0 (`tier_level_id <= 0` → 400); clearing an
        // override is expressed as null, exactly like the dashboard sends it.
        const level = a.tier_level_id === 0 ? null : a.tier_level_id;
        const r = await adminFetch(`/users/${id}/tier`, {
            method: "PATCH",
            body: {
                tier_level_id: level,
                until: a.until ?? null,
                reason: a.reason,
            },
        });
        return json(r);
    },
});

server.addTool({
    name: "update_user_profile",
    description:
        "Edit a user's display name and/or country. Send a field to change it (empty string clears it); omit to leave unchanged.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        display_name: z.string().optional(),
        country: z.string().optional(),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        const body: Record<string, string> = {};
        if (a.display_name !== undefined) body.display_name = a.display_name;
        if (a.country !== undefined) body.country = a.country;
        return json(await adminFetch(`/users/${id}/profile`, { method: "PATCH", body }));
    },
});

server.addTool({
    name: "grant_credits",
    description:
        "Grant a bonus token pack to a user (bank_transfer or admin_manual). Optional EUR amount, expiry, external reference, notes. Stripe purchases arrive via the webhook, not here.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        tokens_granted: z.number().int().positive(),
        payment_method: z.enum(["bank_transfer", "admin_manual"]).default("admin_manual"),
        amount_eur: z.number().nonnegative().optional().describe("EUR amount (not cents)"),
        expires_at: z
            .string()
            .optional()
            .describe("ISO expiry; omit for a pack that never expires"),
        external_reference: z.string().optional(),
        notes: z.string().optional(),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        const r = await adminFetch(`/users/${id}/credits`, {
            method: "POST",
            body: {
                tokens_granted: a.tokens_granted,
                payment_method: a.payment_method,
                amount_eur_cents:
                    a.amount_eur !== undefined
                        ? Math.round(a.amount_eur * 100)
                        : undefined,
                expires_at: a.expires_at,
                external_reference: a.external_reference,
                notes: a.notes,
            },
        });
        return json(r);
    },
});

server.addTool({
    name: "void_credit",
    description:
        "Void a bonus token pack by its grant id (from get_user_credits). Non-destructive: the row is kept for audit but stops counting toward the balance. Already-voided grants return 404.",
    parameters: z.object({
        credit_id: z.string().describe("grant id from get_user_credits"),
        reason: z.string().optional().describe("audit reason"),
    }),
    execute: async (a) =>
        json(
            await adminFetch(`/credits/${a.credit_id}/void`, {
                method: "POST",
                body: { reason: a.reason },
            }),
        ),
});

server.addTool({
    name: "suspend_user",
    description:
        "Ban or unban a user's Supabase account (blocks/restores login). Requires the user to have a Supabase identity.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        action: z.enum(["ban", "unban"]),
        hours: z.number().int().positive().optional().describe("ban duration; omit ≈ permanent"),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        const r = await adminFetch(`/users/${id}/suspend`, {
            method: "POST",
            body: { action: a.action, ...(a.hours ? { hours: a.hours } : {}) },
        });
        return json(r);
    },
});

// Entitlement values are booleans or non-negative ints, per the catalog.
// Unknown keys and wrong types are dropped by the backend — call
// get_entitlement_catalog first rather than guessing key names.
const entitlementsSchema = z
    .record(z.string(), z.union([z.boolean(), z.number()]))
    .describe("partial map of entitlement key → value; merged, not replaced");

// Marketing copy is replaced wholesale and BOTH locales must be complete —
// the backend drops the whole object otherwise, which would look like a
// silent no-op. Modelled strictly here so that fails at the tool boundary.
const planLocaleCopy = z.object({
    name: z.string(),
    tagline: z.string(),
    price: z.string(),
    period: z.string(),
    intro: z.string().optional(),
    cta: z.string(),
    features: z.array(z.string()),
});
const marketingSchema = z.object({
    order: z.number().int().optional(),
    popular: z.boolean().optional(),
    locales: z.object({ hr: planLocaleCopy, en: planLocaleCopy }),
});

server.addTool({
    name: "update_tier_limit",
    description:
        "Update a tier's editable fields: daily_tokens quota, display_label, tier_slug, entitlement gates, and public marketing copy. Takes effect within seconds (rate limiter and feature gates read tier_limits live). `entitlements` is shallow-merged — send only the keys you change; `marketing` replaces the whole object and needs both hr and en complete.",
    parameters: z.object({
        tier_level_id: z.number().int().positive(),
        daily_tokens: z.number().int().nonnegative().optional(),
        display_label: z.string().optional(),
        tier_slug: z.string().optional(),
        entitlements: entitlementsSchema.optional(),
        marketing: marketingSchema.optional().describe("full per-locale plan copy"),
    }),
    execute: async (a) => {
        const body: Record<string, unknown> = {};
        if (a.daily_tokens !== undefined) body.daily_tokens = a.daily_tokens;
        if (a.display_label !== undefined) body.display_label = a.display_label;
        if (a.tier_slug !== undefined) body.tier_slug = a.tier_slug;
        if (a.entitlements !== undefined) body.entitlements = a.entitlements;
        if (a.marketing !== undefined) body.marketing = a.marketing;
        const r = await adminFetch(`/tiers/${a.tier_level_id}`, {
            method: "PATCH",
            body,
        });
        return json(r);
    },
});

server.addTool({
    name: "create_tier",
    description:
        "Create a tier row up front (rare — the normal flow lazy-upserts on first login with that tier). Use to pre-configure a tier_level_id before any user has it.",
    parameters: z.object({
        tier_level_id: z.number().int().positive(),
        tier_slug: z.string().describe("stable machine key, e.g. \"legal_pro\""),
        display_label: z.string(),
        daily_tokens: z.number().int().nonnegative(),
        entitlements: entitlementsSchema.optional(),
    }),
    execute: async (a) =>
        json(
            await adminFetch("/tiers", {
                method: "POST",
                body: {
                    tier_level_id: a.tier_level_id,
                    tier_slug: a.tier_slug,
                    display_label: a.display_label,
                    daily_tokens: a.daily_tokens,
                    entitlements: a.entitlements,
                },
            }),
        ),
});

// ---- promo codes (Stripe-backed; 503 when Stripe is not configured) ----

server.addTool({
    name: "list_promos",
    description:
        "All Stripe promotion codes with their coupon terms (percent off, duration, which plans, expiry, redemption cap) and per-code revenue stats from the billing ledger.",
    parameters: z.object({}),
    execute: async () => json(await adminFetch("/promos")),
});

server.addTool({
    name: "create_promo",
    description:
        "Create a Stripe coupon + promotion code. Codes are uppercased; a code that already exists in Stripe is rejected (409). `plans` limits the coupon to specific plan slugs — omit for all plans; an unknown slug is a hard error.",
    parameters: z.object({
        code: z.string().describe("3–30 chars, letters/digits/_/- only"),
        percent_off: z.number().min(1).max(100),
        duration: z
            .enum(["forever", "once", "repeating"])
            .optional()
            .describe("default forever"),
        duration_in_months: z
            .number()
            .int()
            .min(1)
            .max(60)
            .optional()
            .describe("required when duration=repeating"),
        plans: z
            .array(z.string())
            .optional()
            .describe("plan slugs; omit = every plan"),
        expires_at: z.string().optional().describe("ISO — must be in the future"),
        max_redemptions: z.number().int().positive().optional(),
    }),
    execute: async (a) =>
        json(
            await adminFetch("/promos", {
                method: "POST",
                body: {
                    code: a.code,
                    percent_off: a.percent_off,
                    duration: a.duration,
                    duration_in_months: a.duration_in_months,
                    plans: a.plans,
                    expires_at: a.expires_at,
                    max_redemptions: a.max_redemptions,
                },
            }),
        ),
});

server.addTool({
    name: "set_promo_active",
    description:
        "Activate or deactivate a promotion code. Stripe codes cannot be deleted, only deactivated — and an expired code cannot be reactivated.",
    parameters: z.object({
        promo_id: z.string().describe("Stripe promotion code id (promo_…)"),
        active: z.boolean(),
    }),
    execute: async (a) =>
        json(
            await adminFetch(`/promos/${a.promo_id}`, {
                method: "PATCH",
                body: { active: a.active },
            }),
        ),
});

// ── start ───────────────────────────────────────────────────────────────────

server
    .start({
        transportType: "httpStream",
        httpStream: { port: PORT, host: "0.0.0.0", endpoint: "/mcp", stateless: true },
    })
    .then(() => {
        console.log(
            `[admin-mcp] FastMCP httpStream on :${PORT}/mcp → ${ADMIN_API_BASE} ` +
                `(admin-only, redaction ${REDACT ? "ON" : "OFF"})`,
        );
        if (!REDACT) {
            console.warn(
                "[admin-mcp] WARNING: ADMIN_MCP_REDACT is off — responses carry " +
                    "email, name, IP and payment notes into the MCP client's context.",
            );
        }
    })
    .catch((err) => {
        console.error("[admin-mcp] failed to start:", err);
        process.exit(1);
    });
