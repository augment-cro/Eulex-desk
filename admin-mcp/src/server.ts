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

/**
 * Call an AdminMax endpoint with the cached admin JWT. Re-logs in once on a
 * 401 (token rotated / expired). Returns parsed JSON; throws UserError with
 * the backend's detail on a non-2xx so the MCP client sees a clean message.
 */
async function adminFetch<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
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
        throw new UserError(`AdminMax ${path} → ${res.status}: ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Resolve a user reference (uuid or email) to a uuid via the search list. */
async function resolveUserId(ref: string): Promise<string> {
    const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            ref,
        );
    if (isUuid) return ref;
    const r = await adminFetch<{ users: Array<{ id: string; email: string }> }>(
        "/users",
        { query: { q: ref, limit: 5 } },
    );
    const exact = r.users.find(
        (u) => u.email.toLowerCase() === ref.toLowerCase(),
    );
    const hit = exact ?? r.users[0];
    if (!hit) throw new UserError(`No user found matching "${ref}"`);
    return hit.id;
}

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
        sort: z
            .enum(["cost", "requests", "errors", "last_used", "email", "created", "last_login", "tier"])
            .optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(200).optional().default(25),
        offset: z.number().int().min(0).optional().default(0),
        from: z.string().optional(),
        to: z.string().optional(),
    }),
    execute: async (a) => {
        const r = await adminFetch("/users", {
            query: {
                q: a.q,
                tier: a.tier,
                only_active: a.only_active,
                sort: a.sort,
                dir: a.dir,
                limit: a.limit,
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
        from: z.string().optional(),
        to: z.string().optional(),
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
    parameters: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
    }),
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

// ---- WRITE (the backend logs an audit trail + enforces guards) ----

server.addTool({
    name: "set_user_tier",
    description:
        "Set or clear a user's subscription tier (manual override). tier_level_id null/0 → back to Free. Optional 'until' ISO expiry and audit 'reason'. Mirrors to UMP like the dashboard.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        tier_level_id: z
            .number()
            .int()
            .nullable()
            .describe("target tier id; null or 0 = Free"),
        until: z.string().nullable().optional().describe("ISO expiry; null = no expiry"),
        reason: z.string().optional().describe("audit reason"),
    }),
    execute: async (a) => {
        const id = await resolveUserId(a.user);
        const r = await adminFetch(`/users/${id}/tier`, {
            method: "PATCH",
            body: {
                tier_level_id: a.tier_level_id,
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
        "Grant a bonus token pack to a user (bank_transfer or admin_manual). Optional EUR amount, external reference, notes.",
    parameters: z.object({
        user: z.string().describe("user uuid or email"),
        tokens_granted: z.number().int().positive(),
        payment_method: z.enum(["bank_transfer", "admin_manual"]).default("admin_manual"),
        amount_eur: z.number().nonnegative().optional().describe("EUR amount (not cents)"),
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
                external_reference: a.external_reference,
                notes: a.notes,
            },
        });
        return json(r);
    },
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

server.addTool({
    name: "update_tier_limit",
    description:
        "Update a tier's editable fields: daily_tokens quota and/or display_label. Takes effect within seconds (rate limiter reads tier_limits live).",
    parameters: z.object({
        tier_level_id: z.number().int().positive(),
        daily_tokens: z.number().int().nonnegative().optional(),
        display_label: z.string().optional(),
    }),
    execute: async (a) => {
        const body: Record<string, unknown> = {};
        if (a.daily_tokens !== undefined) body.daily_tokens = a.daily_tokens;
        if (a.display_label !== undefined) body.display_label = a.display_label;
        const r = await adminFetch(`/tiers/${a.tier_level_id}`, {
            method: "PATCH",
            body,
        });
        return json(r);
    },
});

// ── start ───────────────────────────────────────────────────────────────────

server
    .start({
        transportType: "httpStream",
        httpStream: { port: PORT, host: "0.0.0.0", endpoint: "/mcp", stateless: true },
    })
    .then(() => {
        console.log(
            `[admin-mcp] FastMCP httpStream on :${PORT}/mcp → ${ADMIN_API_BASE} (admin-only)`,
        );
    })
    .catch((err) => {
        console.error("[admin-mcp] failed to start:", err);
        process.exit(1);
    });
