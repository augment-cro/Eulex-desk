/**
 * Admin data routes of this deployment — served as /operator/v1/* by
 * routes/operator.ts (auth: requireOperatorCaller; contract:
 * contracts/operator.openapi.json). The operator console itself is a
 * separate program; nothing here renders UI or holds console logic.
 *
 * Routes (relative to /operator/v1)
 * ------
 *   GET   /users                         — totals across all users
 *   GET   /users/:userId                 — totals + meta for one user
 *   GET   /users/:userId/usage           — paginated llm_usage rows
 *   GET   /users/:userId/messages        — paginated chat_messages
 *   GET   /users/:userId/usage.csv       — CSV export per user
 *   GET   /users/:userId/mcp             — MCP usage, both legs (Desk chat + portal connector)
 *   GET   /mcp/desk                      — Desk-side MCP tool calls overview (mcp_tool_calls_daily)
 *   GET   /usage.csv                     — global CSV export
 *   GET   /chats                         — global searchable chat list
 *   GET   /audit                         — admin action audit trail
 *   GET   /promos                        — Stripe promo codes + usage stats
 *   POST  /promos                        — create coupon + promotion code
 *   PATCH /promos/:id                    — (de)activate a promotion code
 *   …     tiers, credits, analytics, features, new-users, manual sends —
 *         see the contract for the full list.
 *
 * Filters
 * -------
 *  ?from=ISO8601 &to=ISO8601    inclusive lower / exclusive upper bound on
 *                                created_at. Defaults: last 30 days, now.
 *  ?limit=int    &offset=int     paginated endpoints (default 50, max 500).
 *
 * Every mutating handler (and each CSV export) appends a row to
 * public.admin_audit via logAdminAudit — see lib/adminAudit.ts.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { query } from "../lib/db";
import {
    bustEntitlementsCache,
    entitlementCatalog,
    sanitizeEntitlementsInput,
    tierKeyForLevelId,
} from "../lib/entitlements";
import {
    bustPlanCatalogCache,
    getPlanCatalog,
    sanitizeMarketingInput,
} from "../lib/planCatalog";
import { getNewUsersSince, markNewUsersSeen } from "../lib/adminState";
import { getStripe, isStripeConfigured } from "../lib/stripe";
import { backfillSubscriptionRevenue } from "./billing";
import {
    banSupabaseUser,
    getSupabaseAuthInfo,
    isSupabaseAdminConfigured,
    unbanSupabaseUser,
    type SupabaseAuthInfo,
} from "../lib/supabaseAdmin";
import {
    clearLocalTierOverride,
    pushMembershipChange,
    setLocalTierActive,
    type MembershipPushPayload,
} from "../lib/membership";
import {
    getAllTierLimits,
    getTierLimitsRow,
    updateTierDefinition,
    upsertTierDefinition,
    type TierDefinitionPatch,
} from "../lib/tierLimitsStore";
import { getFreeTierLevelId, getPlanDefs } from "../lib/stripe";
import { sendWeeklyAdminSummary } from "../lib/adminSummary";
import { sendExpiryReminders } from "../lib/expiryReminders";
import { sendContextAlertDigests } from "../lib/contextAlertDigest";
import { auditMeta, logAdminAudit } from "../lib/adminAudit";
import { clampInt } from "../lib/portalManage";
import {
    loadDeskMcpOverview,
    loadUserMcpDetail,
    loadUserMcpSummaries,
} from "../lib/mcp/adminUsage";
import { describeTierGrant, expiryHistoryEntry } from "../lib/tierGrant";


/**
 * The data routes — every handler that reads or changes this deployment's
 * own data (users, tiers, credits, usage, chats, audit, promos, MCP usage).
 * No auth of its own: mounted behind requireOperatorCaller in
 * routes/operator.ts (/operator/v1).
 */
export const adminDataRouter = Router();

// ── helpers ───────────────────────────────────────────────────────────────

function parseDateRange(req: Request): { from: Date; to: Date } {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromStr = typeof req.query.from === "string" ? req.query.from : "";
    const toStr = typeof req.query.to === "string" ? req.query.to : "";
    const from = fromStr ? new Date(fromStr) : defaultFrom;
    const to = toStr ? new Date(toStr) : now;
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        return { from: defaultFrom, to: now };
    }
    return { from, to };
}

function parsePagination(req: Request): { limit: number; offset: number } {
    const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
    const rawOffset = parseInt(String(req.query.offset ?? ""), 10);
    const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 500)
        : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
    return { limit, offset };
}

// CSV escape per RFC 4180 — quote everything that contains comma, quote,
// or newline; double-up internal quotes.
function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    const s = typeof value === "string" ? value : String(value);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function csvRow(cells: unknown[]): string {
    return cells.map(csvCell).join(",");
}

function isUuid(s: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        s,
    );
}

/**
 * Shape the raw revenue-metrics row (all cents, as text) into the response
 * object the Analitika page renders. MRR/ARR are NOW-anchored run-rate
 * figures from the invoice ledger; the bridge + NRR compare the last 30
 * days against the prior 30 (per paying user). NRR is null when there is
 * no prior-window revenue to retain (avoids a divide-by-zero "0%").
 */
type RevenueMetricsRow = {
    mrr_cents: string;
    arr_cents: string;
    active_payers: string;
    new_cents: string;
    expansion_cents: string;
    contraction_cents: string;
    churned_cents: string;
    base_cents: string;
    retained_cents: string;
};

function buildRevenueMetrics(row: RevenueMetricsRow | undefined) {
    const n = (v: string | undefined) => Number(v ?? 0);
    const mrr = n(row?.mrr_cents);
    const arr = n(row?.arr_cents);
    const payers = n(row?.active_payers);
    const base = n(row?.base_cents);
    const retained = n(row?.retained_cents);
    return {
        // cents (EUR) — the frontend formats.
        mrr_cents: mrr,
        arr_cents: arr,
        active_payers: payers,
        // ARPU over paying users this month (cents). 0 payers → 0.
        arpu_cents: payers > 0 ? Math.round(mrr / payers) : 0,
        // Net revenue retention (%) of the prior 30d paying cohort; null if
        // there was no prior revenue (can't compute a ratio).
        nrr_pct: base > 0 ? Math.round((retained / base) * 1000) / 10 : null,
        // 30d-vs-prior-30d MRR movement (cents).
        bridge: {
            new_cents: n(row?.new_cents),
            expansion_cents: n(row?.expansion_cents),
            contraction_cents: n(row?.contraction_cents),
            churned_cents: n(row?.churned_cents),
        },
    };
}


// ── paying-users counter ──────────────────────────────────────────────────
//
// Distinct Stripe customers with an ≥1 active subscription, straight from
// the Stripe API (source of truth for "who is actually paying right now",
// independent of tier grants in mike-db). Cached in-memory: the dashboard
// polls /users on every filter change and Stripe pagination is not free.

const PAID_COUNT_TTL_MS = 5 * 60 * 1000;
let _paidCountCache: {
    at: number;
    count: number;
    subs: number;
    mrrCents: number;
} | null = null;

async function getPaidUsersCount(): Promise<{
    count: number;
    subs: number;
    mrrCents: number;
} | null> {
    if (!isStripeConfigured()) return null;
    if (_paidCountCache && Date.now() - _paidCountCache.at < PAID_COUNT_TTL_MS) {
        const { count, subs, mrrCents } = _paidCountCache;
        return { count, subs, mrrCents };
    }
    try {
        const stripe = getStripe();
        const customers = new Set<string>();
        let subs = 0;
        let mrrCents = 0;
        for await (const sub of stripe.subscriptions.list({
            status: "active",
            limit: 100,
        })) {
            subs += 1;
            const c = sub.customer;
            customers.add(typeof c === "string" ? c : c.id);
            // Monthly run-rate: normalize each item's recurring price to a
            // month (year/12, week×4.348, day×30.437). Amounts are cents.
            for (const item of sub.items?.data ?? []) {
                const price = item.price;
                const unit = price?.unit_amount ?? 0;
                const qty = item.quantity ?? 1;
                const rec = price?.recurring;
                if (!unit || !rec) continue;
                const per = unit * qty;
                const count = rec.interval_count ?? 1;
                const monthly =
                    rec.interval === "month"
                        ? per / count
                        : rec.interval === "year"
                          ? per / (12 * count)
                          : rec.interval === "week"
                            ? (per * 4.348) / count
                            : (per * 30.437) / count;
                mrrCents += monthly;
            }
        }
        mrrCents = Math.round(mrrCents);
        _paidCountCache = { at: Date.now(), count: customers.size, subs, mrrCents };
        return { count: customers.size, subs, mrrCents };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/paid-users]", msg);
        // Serve a stale value over a hole in the dashboard.
        if (_paidCountCache) {
            const { count, subs, mrrCents } = _paidCountCache;
            return { count, subs, mrrCents };
        }
        return null;
    }
}

// ── revenue ledger backfill ──────────────────────────────────────────────

/**
 * POST /adminmax/billing/backfill-revenue?days=365 — idempotent repair:
 * re-inserts paid Stripe subscription invoices missing from
 * billing_revenue (the Basil API shape change silently disabled the
 * webhook's ledger insert for a while). Safe to re-run any time.
 */
adminDataRouter.post(
    "/billing/backfill-revenue",
    async (req: Request, res: Response) => {
        if (!isStripeConfigured()) {
            res.status(503).json({ detail: "Stripe not configured" });
            return;
        }
        const days = Math.min(
            Math.max(Number(req.query.days ?? 365) || 365, 1),
            1095,
        );
        try {
            const result = await backfillSubscriptionRevenue(days);
            res.json({ ok: true, days, ...result });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/backfill-revenue]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// ── new-users badge ───────────────────────────────────────────────────────
//
// Powers the persistent corner badge in the AdminMax shell: how many
// users registered since the operator's previous login (a more recent
// "mark seen" dismissal wins). State is global (AdminMax has no per-admin
// identity) and lives in public.admin_state.

/**
 * GET /adminmax/new-users — count + a peek at the most recent signups
 * since the operator's last login (or "seen" dismissal, whichever is later).
 */
adminDataRouter.get("/new-users", async (_req: Request, res: Response) => {
    try {
        const since = await getNewUsersSince();
        const count = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM public.users
              WHERE created_at > $1`,
            [since.toISOString()],
        );
        const recent = await query<{
            id: string;
            email: string;
            display_name: string | null;
            created_at: string;
        }>(
            `SELECT id, email, display_name, created_at
               FROM public.users
              WHERE created_at > $1
           ORDER BY created_at DESC
              LIMIT 10`,
            [since.toISOString()],
        );
        res.json({
            since: since.toISOString(),
            count: Number(count.rows[0]?.count ?? 0),
            recent: recent.rows,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/new-users]", msg);
        res.status(500).json({ detail: msg });
    }
});

/**
 * POST /adminmax/new-users/seen — reset the badge to "now".
 */
adminDataRouter.post(
    "/new-users/seen",
    async (_req: Request, res: Response) => {
        try {
            const at = new Date();
            await markNewUsersSeen(at);
            res.json({ ok: true, last_checked_at: at.toISOString() });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/new-users/seen]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/weekly-summary/send — manual trigger of the same email
 * the cron sends; lets the operator test it from the dashboard.
 */
adminDataRouter.post(
    "/weekly-summary/send",
    async (req: Request, res: Response) => {
        try {
            const result = await sendWeeklyAdminSummary();
            void logAdminAudit({
                action: "email.weekly_summary.send",
                targetType: "email",
                ...auditMeta(req, res),
            });
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/weekly-summary/send]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/context-alerts/send — manual trigger of the context-alert
 * digest sweep (same logic the cron runs).
 */
adminDataRouter.post(
    "/context-alerts/send",
    async (req: Request, res: Response) => {
        try {
            const result = await sendContextAlertDigests();
            void logAdminAudit({
                action: "email.context_alerts.send",
                targetType: "email",
                ...auditMeta(req, res),
            });
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/context-alerts/send]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/expiry-reminders/send — manual trigger of the daily
 * expiry-reminder sweep (same logic the cron runs).
 */
adminDataRouter.post(
    "/expiry-reminders/send",
    async (req: Request, res: Response) => {
        try {
            const result = await sendExpiryReminders();
            void logAdminAudit({
                action: "email.expiry_reminders.send",
                targetType: "email",
                ...auditMeta(req, res),
            });
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/expiry-reminders/send]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// A paid grant that still applies (same rule auth uses).
const LIVE_GRANT_SQL = `s.active_tier_level_id IS NOT NULL
    AND (s.active_tier_until IS NULL OR s.active_tier_until > now())`;

// The newest tier_change_history row = the write behind the current grant
// (lib/tierGrant.ts reads source + reason as who granted it). Needs
// `s` = user_tier_state and `u` = users in scope.
const LATEST_GRANT_JOIN_SQL = `LEFT JOIN LATERAL (
                SELECT hh.source, hh.reason, hh.created_at
                  FROM public.tier_change_history hh
                 WHERE hh.user_id = u.id
                 ORDER BY hh.created_at DESC
                 LIMIT 1
            ) h ON s.active_tier_level_id IS NOT NULL`;

/**
 * GET /adminmax/users
 *
 * Returns one row per user with rolled-up usage in the requested date
 * range. Server-side paginated + searchable + sortable so the admin
 * dashboard scales beyond a few hundred users.
 *
 * Query params (all optional):
 *   - from, to        ISO timestamps (default last 30 days)
 *   - limit           1..500 (default 50)
 *   - offset          >=0  (default 0)
 *   - q               case-insensitive substring match on email OR display_name
 *   - sort            cost | requests | errors | last_used | email   (default created)
 *   - dir             asc | desc                                     (default desc)
 *   - only_active     "true" → drop users with 0 llm_usage rows in window
 *                     (default false — show every user, even idle)
 *   - grant           manual | external | stripe — live paid grants by who
 *                     granted them; expired — grants past their end date
 *
 * Response shape:
 *   {
 *     range: { from, to },
 *     pagination: { limit, offset, total },
 *     filter: { q, sort, dir, only_active },
 *     users: AdminUserSummary[],        // page slice
 *     totals: { cost_usd_total, request_count, input_tokens_total,
 *               output_tokens_total, cache_read_input_tokens_total,
 *               cache_creation_input_tokens_total, error_count }
 *   }
 *
 * `totals` is computed across the FULL filter set (not just the page
 * slice) so the top SummaryCards keep showing range-wide aggregates.
 */
adminDataRouter.get("/users", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const { limit, offset } = parsePagination(req);
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const q = rawQ.slice(0, 200); // hard cap; ILIKE pattern length safety

    const SORT_MAP: Record<string, string> = {
        cost: "cost_usd_total",
        requests: "request_count",
        questions: "question_count",
        errors: "error_count",
        last_used: "last_used",
        email: "email",
        created: "created_at",
        last_login: "last_login_at",
        tier: "effective_tier_level_id",
        documents: "documents_uploaded",
    };
    const sortKey =
        typeof req.query.sort === "string" && req.query.sort in SORT_MAP
            ? (req.query.sort as keyof typeof SORT_MAP)
            : "created";
    const sortCol = SORT_MAP[sortKey];
    const dir =
        typeof req.query.dir === "string" &&
        req.query.dir.toLowerCase() === "asc"
            ? "ASC"
            : "DESC";
    const onlyActive =
        typeof req.query.only_active === "string" &&
        ["true", "1", "yes"].includes(req.query.only_active.toLowerCase());

    // Optional subscription filters: ?tier=<tier_level_id> matches the
    // EFFECTIVE tier (expired/absent override counts as free), and
    // ?created_after=ISO narrows to fresh signups (the new-users badge
    // deep-links here).
    const tierFilterRaw = Number(req.query.tier);
    const tierFilter =
        Number.isInteger(tierFilterRaw) && tierFilterRaw > 0
            ? tierFilterRaw
            : null;
    // ?grant= narrows to how the paid tier was granted (live grants), or
    // to grants whose end date has passed. Fixed SQL per key — never
    // interpolate the raw query value.
    const GRANT_FILTERS: Record<string, string> = {
        manual: `${LIVE_GRANT_SQL} AND h.source = 'admin' AND COALESCE(h.reason, '') NOT LIKE 'ext:%'`,
        external: `${LIVE_GRANT_SQL} AND h.source = 'admin' AND h.reason LIKE 'ext:%'`,
        stripe: `${LIVE_GRANT_SQL} AND h.source = 'stripe'`,
        expired: `s.active_tier_level_id IS NOT NULL AND s.active_tier_until <= now()`,
    };
    const grantKey =
        typeof req.query.grant === "string" && req.query.grant in GRANT_FILTERS
            ? req.query.grant
            : null;
    const grantFilterSql = grantKey ? `AND (${GRANT_FILTERS[grantKey]})` : "";
    const createdAfterRaw =
        typeof req.query.created_after === "string"
            ? new Date(req.query.created_after)
            : null;
    const createdAfter =
        createdAfterRaw && !isNaN(createdAfterRaw.getTime())
            ? createdAfterRaw.toISOString()
            : null;
    const freeLevelId = getFreeTierLevelId();

    // ILIKE pattern is built server-side with parameter binding; the
    // wildcard wrapping is on us so the client sends a bare term.
    const qPattern = q ? `%${q}%` : null;

    // Two CTEs, two queries — Postgres planner caches the inner
    // aggregate plan, and we keep the SQL readable instead of trying
    // to substring-edit it. Parameter order is locked across both:
    // $1=from, $2=to, $3=qPattern, $4=freeLevelId, $5=tierFilter,
    // $6=createdAfter. Page query appends $7/$8 for limit/offset.
    //
    // "Effective tier" folds the expiry in: an override past its
    // active_tier_until renders (and filters) as free, matching what the
    // auth middleware enforces on real requests.
    //
    // Uploads are counted from the audit trail (migration 208), not from
    // public.documents: it keeps documents the user later deleted, includes
    // connector imports, and leaves out files the assistant generated or
    // copied. It starts on 2026-08-18. Pre-aggregated in its own CTE so the
    // join does not multiply the llm_usage rows summed below.
    //
    // Questions are the user's own messages in regular and project chats —
    // what an operator means by "how much does this person use Max". The
    // llm_usage row count (request_count) also includes title generation,
    // tabular cells and other background calls, so it stays as a cost metric.
    const perUserCte = `
        WITH doc_uploads AS (
            SELECT user_id, COUNT(*) AS documents_uploaded
              FROM public.audit_events
             WHERE event_type = 'document.uploaded'
               AND created_at >= $1
               AND created_at <  $2
             GROUP BY user_id
        ),
        questions AS (
            SELECT c.user_id::text AS user_id, COUNT(*) AS question_count
              FROM public.chat_messages cm
              JOIN public.chats c ON c.id = cm.chat_id
             WHERE cm.role = 'user'
               AND cm.created_at >= $1
               AND cm.created_at <  $2
             GROUP BY c.user_id
        ),
        per_user AS (
            SELECT
                u.id, u.email, u.display_name, u.wp_user_id, u.created_at,
                COALESCE(
                    CASE WHEN s.active_tier_level_id IS NOT NULL
                          AND (s.active_tier_until IS NULL OR s.active_tier_until > now())
                         THEN s.active_tier_level_id END,
                    $4::bigint
                )                                                AS effective_tier_level_id,
                s.active_tier_until,
                tl.display_label                                 AS tier_label,
                tl.tier_slug                                     AS tier_slug,
                s.active_tier_level_id                           AS granted_tier_level_id,
                tlg.display_label                                AS granted_tier_label,
                h.source                                         AS grant_source,
                h.reason                                         AS grant_reason,
                ls.last_login_at,
                ls.login_count,
                COALESCE(SUM(lu.iterations), 0)                  AS iterations_total,
                COALESCE(SUM(lu.input_tokens), 0)                AS input_tokens_total,
                COALESCE(SUM(lu.output_tokens), 0)               AS output_tokens_total,
                COALESCE(SUM(lu.cache_creation_input_tokens), 0) AS cache_creation_input_tokens_total,
                COALESCE(SUM(lu.cache_read_input_tokens), 0)     AS cache_read_input_tokens_total,
                COALESCE(SUM(lu.cost_usd), 0)                    AS cost_usd_total,
                COUNT(lu.id)                                     AS request_count,
                COUNT(lu.id) FILTER (WHERE lu.status = 'error')  AS error_count,
                MAX(lu.created_at)                               AS last_used,
                COALESCE(du.documents_uploaded, 0)               AS documents_uploaded,
                COALESCE(qc.question_count, 0)                   AS question_count
            FROM public.users u
            LEFT JOIN public.user_tier_state s ON s.user_id = u.id
            LEFT JOIN public.tier_limits tl
                   ON tl.tier_level_id = COALESCE(
                        CASE WHEN s.active_tier_level_id IS NOT NULL
                              AND (s.active_tier_until IS NULL OR s.active_tier_until > now())
                             THEN s.active_tier_level_id END,
                        $4::bigint)
            LEFT JOIN public.tier_limits tlg
                   ON tlg.tier_level_id = s.active_tier_level_id
            ${LATEST_GRANT_JOIN_SQL}
            LEFT JOIN public.user_login_state ls ON ls.user_id = u.id
            LEFT JOIN doc_uploads du ON du.user_id = u.id
            LEFT JOIN questions qc ON qc.user_id = u.id::text
            LEFT JOIN public.llm_usage lu
                   ON lu.user_id = u.id
                  AND lu.created_at >= $1
                  AND lu.created_at <  $2
            WHERE ($3::text IS NULL
                   OR u.email ILIKE $3
                   OR COALESCE(u.display_name, '') ILIKE $3)
              AND ($5::bigint IS NULL
                   OR COALESCE(
                        CASE WHEN s.active_tier_level_id IS NOT NULL
                              AND (s.active_tier_until IS NULL OR s.active_tier_until > now())
                             THEN s.active_tier_level_id END,
                        $4::bigint) = $5::bigint)
              AND ($6::timestamptz IS NULL OR u.created_at >= $6::timestamptz)
              ${grantFilterSql}
            GROUP BY u.id, u.email, u.display_name, u.wp_user_id, u.created_at,
                     s.active_tier_level_id, s.active_tier_until,
                     tl.display_label, tl.tier_slug, tlg.display_label,
                     h.source, h.reason,
                     ls.last_login_at, ls.login_count,
                     du.documents_uploaded, qc.question_count
        )
    `;
    const activeFilter = onlyActive ? "WHERE request_count > 0" : "";

    // Reference point for the "new users since last login" card — global
    // (not affected by the date-range / search filters above).
    const newUsersSince = await getNewUsersSince();

    try {
        // 1) Totals — counts + sums across the FULL filtered set so the
        // SummaryCards on top stay consistent with the page that
        // follows (same range, same search term, same active filter).
        // `new_users_count` is a standalone scalar (bound as $7) counting
        // signups since the operator's last login, independent of filters.
        const totalsRes = await query<{
            user_count: string;
            cost_usd_total: string | null;
            input_tokens_total: string | null;
            output_tokens_total: string | null;
            cache_creation_input_tokens_total: string | null;
            cache_read_input_tokens_total: string | null;
            request_count: string;
            error_count: string;
            documents_uploaded: string | null;
            question_count: string | null;
            new_users_count: string;
            total_users: string;
        }>(
            `${perUserCte}
            SELECT
                COUNT(*)::bigint                                    AS user_count,
                COALESCE(SUM(cost_usd_total), 0)                    AS cost_usd_total,
                COALESCE(SUM(input_tokens_total), 0)                AS input_tokens_total,
                COALESCE(SUM(output_tokens_total), 0)               AS output_tokens_total,
                COALESCE(SUM(cache_creation_input_tokens_total), 0) AS cache_creation_input_tokens_total,
                COALESCE(SUM(cache_read_input_tokens_total), 0)     AS cache_read_input_tokens_total,
                COALESCE(SUM(request_count), 0)                     AS request_count,
                COALESCE(SUM(error_count), 0)                       AS error_count,
                COALESCE(SUM(documents_uploaded), 0)                AS documents_uploaded,
                COALESCE(SUM(question_count), 0)                    AS question_count,
                (SELECT COUNT(*) FROM public.users
                   WHERE created_at > $7::timestamptz)::text        AS new_users_count,
                (SELECT COUNT(*) FROM public.users)::text           AS total_users
            FROM per_user
            ${activeFilter}`,
            [
                from.toISOString(),
                to.toISOString(),
                qPattern,
                freeLevelId,
                tierFilter,
                createdAfter,
                newUsersSince.toISOString(),
            ],
        );

        // 2) Page slice — same CTE, sort + limit + offset.
        const pageRes = await query<{
            id: string;
            email: string;
            display_name: string | null;
            wp_user_id: number | null;
            created_at: string | null;
            effective_tier_level_id: string | number | null;
            active_tier_until: string | null;
            tier_label: string | null;
            tier_slug: string | null;
            granted_tier_level_id: string | number | null;
            granted_tier_label: string | null;
            grant_source: string | null;
            grant_reason: string | null;
            last_login_at: string | null;
            login_count: string | number | null;
            iterations_total: string | null;
            input_tokens_total: string | null;
            output_tokens_total: string | null;
            cache_creation_input_tokens_total: string | null;
            cache_read_input_tokens_total: string | null;
            cost_usd_total: string | null;
            request_count: string;
            error_count: string;
            last_used: string | null;
            documents_uploaded: string | null;
            question_count: string | null;
        }>(
            `${perUserCte}
            SELECT * FROM per_user
            ${activeFilter}
            ORDER BY ${sortCol} ${dir} NULLS LAST, email ASC
            LIMIT $7 OFFSET $8`,
            [
                from.toISOString(),
                to.toISOString(),
                qPattern,
                freeLevelId,
                tierFilter,
                createdAfter,
                limit,
                offset,
            ],
        );

        const t = totalsRes.rows[0];
        const paid = await getPaidUsersCount();
        // "MCP" badge data for the page slice — Desk counters + portal
        // connector join; both legs fail soft (see lib/mcp/adminUsage.ts).
        const mcpByUser = await loadUserMcpSummaries(pageRes.rows.map((r) => r.id));

        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            pagination: {
                limit,
                offset,
                total: Number(t?.user_count ?? 0),
            },
            filter: {
                q,
                sort: sortKey,
                dir: dir.toLowerCase(),
                only_active: onlyActive,
                tier: tierFilter,
                created_after: createdAfter,
                grant: grantKey,
            },
            totals: {
                cost_usd_total: Number(t?.cost_usd_total ?? 0),
                request_count: Number(t?.request_count ?? 0),
                input_tokens_total: Number(t?.input_tokens_total ?? 0),
                output_tokens_total: Number(t?.output_tokens_total ?? 0),
                cache_read_input_tokens_total: Number(
                    t?.cache_read_input_tokens_total ?? 0,
                ),
                cache_creation_input_tokens_total: Number(
                    t?.cache_creation_input_tokens_total ?? 0,
                ),
                error_count: Number(t?.error_count ?? 0),
                documents_uploaded: Number(t?.documents_uploaded ?? 0),
                question_count: Number(t?.question_count ?? 0),
                new_users_count: Number(t?.new_users_count ?? 0),
                new_users_since: newUsersSince.toISOString(),
                total_users: Number(t?.total_users ?? 0),
                paid_users_count: paid?.count ?? null,
                paid_subs_count: paid?.subs ?? null,
                paid_mrr_cents: paid?.mrrCents ?? null,
            },
            users: pageRes.rows.map((r) => {
                const grant = describeTierGrant({
                    level:
                        r.granted_tier_level_id == null
                            ? null
                            : Number(r.granted_tier_level_id),
                    until: r.active_tier_until,
                    source: r.grant_source,
                    reason: r.grant_reason,
                });
                return {
                id: r.id,
                email: r.email,
                display_name: r.display_name,
                wp_user_id: r.wp_user_id,
                created_at: r.created_at,
                tier_level_id:
                    r.effective_tier_level_id == null
                        ? null
                        : Number(r.effective_tier_level_id),
                tier_label: r.tier_label,
                tier_slug: r.tier_slug,
                active_tier_until: r.active_tier_until,
                grant_kind: grant.kind,
                grant_expired: grant.expired,
                grant_reason: grant.kind ? r.grant_reason : null,
                granted_tier_label: grant.kind ? r.granted_tier_label : null,
                last_login_at: r.last_login_at,
                login_count:
                    r.login_count == null ? 0 : Number(r.login_count),
                iterations_total: Number(r.iterations_total ?? 0),
                input_tokens_total: Number(r.input_tokens_total ?? 0),
                output_tokens_total: Number(r.output_tokens_total ?? 0),
                cache_creation_input_tokens_total: Number(
                    r.cache_creation_input_tokens_total ?? 0,
                ),
                cache_read_input_tokens_total: Number(
                    r.cache_read_input_tokens_total ?? 0,
                ),
                cost_usd_total: Number(r.cost_usd_total ?? 0),
                request_count: Number(r.request_count ?? 0),
                error_count: Number(r.error_count ?? 0),
                last_used: r.last_used,
                documents_uploaded: Number(r.documents_uploaded ?? 0),
                question_count: Number(r.question_count ?? 0),
                mcp: mcpByUser.get(r.id) ?? null,
                };
            }),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/users] failed:", msg);
        res.status(500).json({ detail: "Failed to load users" });
    }
});

/**
 * GET /adminmax/users/:userId
 * Per-user totals + identity. 404 if user does not exist.
 */
adminDataRouter.get(
    "/users/:userId",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const { from, to } = parseDateRange(req);
        try {
            const userRow = await query<{
                id: string;
                email: string;
                display_name: string | null;
                wp_user_id: number | null;
                created_at: string | null;
                active_tier_level_id: number | null;
                active_tier_until: string | null;
                stripe_customer_id: string | null;
                country: string | null;
                tier_label: string | null;
                tier_slug: string | null;
                last_login_at: string | null;
                login_count: string | number | null;
                supabase_user_id: string | null;
                grant_source: string | null;
                grant_reason: string | null;
                grant_at: string | null;
                free_tier_label: string | null;
            }>(
                `SELECT u.id, u.email, u.display_name, u.wp_user_id, u.created_at,
                        s.active_tier_level_id, s.active_tier_until, s.stripe_customer_id,
                        s.country,
                        tl.display_label AS tier_label, tl.tier_slug,
                        ls.last_login_at, ls.login_count,
                        sb.supabase_user_id::text AS supabase_user_id,
                        h.source AS grant_source, h.reason AS grant_reason,
                        h.created_at AS grant_at,
                        tlf.display_label AS free_tier_label
                   FROM public.users u
                   LEFT JOIN public.user_tier_state s ON s.user_id = u.id
                   LEFT JOIN public.tier_limits tl
                          ON tl.tier_level_id = s.active_tier_level_id
                   LEFT JOIN public.tier_limits tlf
                          ON tlf.tier_level_id = $2
                   ${LATEST_GRANT_JOIN_SQL}
                   LEFT JOIN public.user_login_state ls ON ls.user_id = u.id
                   LEFT JOIN public.user_supabase_identity sb ON sb.user_id = u.id
                  WHERE u.id = $1`,
                [userId, getFreeTierLevelId()],
            );
            if (userRow.rows.length === 0) {
                res.status(404).json({ detail: "User not found" });
                return;
            }
            const u = userRow.rows[0];

            // Supabase auth facts (provider, last sign-in, ban state) —
            // best-effort: a Supabase hiccup must not break the page.
            let supabaseAuth: SupabaseAuthInfo | null = null;
            let supabaseAuthError: string | null = null;
            if (u.supabase_user_id && isSupabaseAdminConfigured()) {
                try {
                    supabaseAuth = await getSupabaseAuthInfo(u.supabase_user_id);
                } catch (err) {
                    supabaseAuthError =
                        err instanceof Error ? err.message : String(err);
                }
            }
            const totals = await query<{
                iterations_total: string | null;
                input_tokens_total: string | null;
                output_tokens_total: string | null;
                cache_creation_input_tokens_total: string | null;
                cache_read_input_tokens_total: string | null;
                cost_usd_total: string | null;
                request_count: string;
                error_count: string;
                first_used: string | null;
                last_used: string | null;
            }>(
                `
                SELECT
                    COALESCE(SUM(iterations), 0)                  AS iterations_total,
                    COALESCE(SUM(input_tokens), 0)                AS input_tokens_total,
                    COALESCE(SUM(output_tokens), 0)               AS output_tokens_total,
                    COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens_total,
                    COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens_total,
                    COALESCE(SUM(cost_usd), 0)                    AS cost_usd_total,
                    COUNT(*)                                      AS request_count,
                    COUNT(*) FILTER (WHERE status = 'error')      AS error_count,
                    MIN(created_at)                               AS first_used,
                    MAX(created_at)                               AS last_used
                FROM public.llm_usage
                WHERE user_id = $1
                  AND created_at >= $2
                  AND created_at <  $3
                `,
                [userId, from.toISOString(), to.toISOString()],
            );
            const t = totals.rows[0];
            // Questions = the user's own chat messages (regular + project
            // chats), same definition as the users list.
            const qRes = await query<{ question_count: string }>(
                `SELECT COUNT(*) AS question_count
                   FROM public.chat_messages cm
                   JOIN public.chats c ON c.id = cm.chat_id
                  WHERE c.user_id::text = $1::text
                    AND cm.role = 'user'
                    AND cm.created_at >= $2
                    AND cm.created_at <  $3`,
                [userId, from.toISOString(), to.toISOString()],
            );
            const questionCount = Number(qRes.rows[0]?.question_count ?? 0);
            // Uploads in the range come from the audit trail (since
            // 2026-08-18, same source as the users list); "stored" is what
            // the user keeps right now in public.documents, any origin.
            const docs = await query<{
                uploaded: string;
                last_uploaded_at: string | null;
                stored_count: string;
                stored_bytes: string;
            }>(
                `
                SELECT
                    (SELECT COUNT(*) FROM public.audit_events
                      WHERE user_id = $1 AND event_type = 'document.uploaded'
                        AND created_at >= $2 AND created_at < $3)       AS uploaded,
                    (SELECT MAX(created_at) FROM public.audit_events
                      WHERE user_id = $1 AND event_type = 'document.uploaded') AS last_uploaded_at,
                    (SELECT COUNT(*) FROM public.documents
                      WHERE user_id = $1)                               AS stored_count,
                    (SELECT COALESCE(SUM(size_bytes), 0) FROM public.documents
                      WHERE user_id = $1)                               AS stored_bytes
                `,
                [userId, from.toISOString(), to.toISOString()],
            );
            const d = docs.rows[0];
            const mcpSummary =
                (await loadUserMcpSummaries([userId])).get(userId) ?? null;
            res.json({
                mcp: mcpSummary,
                documents: {
                    uploaded: Number(d?.uploaded ?? 0),
                    last_uploaded_at: d?.last_uploaded_at ?? null,
                    stored_count: Number(d?.stored_count ?? 0),
                    stored_bytes: Number(d?.stored_bytes ?? 0),
                },
                user: {
                    id: u.id,
                    email: u.email,
                    display_name: u.display_name,
                    country: u.country,
                    wp_user_id: u.wp_user_id,
                    created_at: u.created_at,
                },
                // active_tier_* is the stored grant; effective_* is what
                // the user has now (an expired grant folds to free).
                tier: (() => {
                    const grant = describeTierGrant({
                        level: u.active_tier_level_id,
                        until: u.active_tier_until,
                        source: u.grant_source,
                        reason: u.grant_reason,
                    });
                    return {
                        active_tier_level_id: u.active_tier_level_id,
                        active_tier_until: u.active_tier_until,
                        tier_label: u.tier_label,
                        tier_slug: u.tier_slug,
                        stripe_customer_id: u.stripe_customer_id,
                        effective_tier_level_id: grant.effectiveLevelId,
                        effective_tier_label:
                            grant.effectiveLevelId == null
                                ? u.free_tier_label
                                : u.tier_label,
                        expired: grant.expired,
                        grant_kind: grant.kind,
                        grant_reason: grant.kind ? u.grant_reason : null,
                        grant_at: grant.kind ? u.grant_at : null,
                    };
                })(),
                login: {
                    last_login_at: u.last_login_at,
                    login_count:
                        u.login_count == null ? 0 : Number(u.login_count),
                },
                supabase: {
                    configured: isSupabaseAdminConfigured(),
                    supabase_user_id: u.supabase_user_id,
                    auth: supabaseAuth,
                    error: supabaseAuthError,
                },
                range: { from: from.toISOString(), to: to.toISOString() },
                totals: {
                    question_count: questionCount,
                    iterations_total: Number(t.iterations_total ?? 0),
                    input_tokens_total: Number(t.input_tokens_total ?? 0),
                    output_tokens_total: Number(t.output_tokens_total ?? 0),
                    cache_creation_input_tokens_total: Number(
                        t.cache_creation_input_tokens_total ?? 0,
                    ),
                    cache_read_input_tokens_total: Number(
                        t.cache_read_input_tokens_total ?? 0,
                    ),
                    cost_usd_total: Number(t.cost_usd_total ?? 0),
                    request_count: Number(t.request_count ?? 0),
                    error_count: Number(t.error_count ?? 0),
                    first_used: t.first_used,
                    last_used: t.last_used,
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:userId] failed:", msg);
            res.status(500).json({ detail: "Failed to load user" });
        }
    },
);

/**
 * GET /adminmax/users/:userId/tier-history — append-only audit of tier
 * transitions (Stripe webhook, UMP sync, admin manual). Newest first.
 */
adminDataRouter.get(
    "/users/:userId/tier-history",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        try {
            const rows = await query<{
                id: string;
                old_tier_level_id: number | null;
                new_tier_level_id: number | null;
                old_until: string | null;
                new_until: string | null;
                source: string;
                reason: string | null;
                created_at: string;
                old_label: string | null;
                new_label: string | null;
            }>(
                `SELECT h.id, h.old_tier_level_id, h.new_tier_level_id,
                        h.old_until, h.new_until, h.source, h.reason,
                        h.created_at,
                        tlo.display_label AS old_label,
                        tln.display_label AS new_label
                   FROM public.tier_change_history h
                   LEFT JOIN public.tier_limits tlo
                          ON tlo.tier_level_id = h.old_tier_level_id
                   LEFT JOIN public.tier_limits tln
                          ON tln.tier_level_id = h.new_tier_level_id
                  WHERE h.user_id = $1
               ORDER BY h.created_at DESC
                  LIMIT 100`,
                [userId],
            );
            // An expired grant writes nothing, so the "→ Free" step is
            // added here, on read (lib/tierGrant.ts).
            const state = await query<{
                active_tier_level_id: number | null;
                active_tier_until: string | null;
                label: string | null;
            }>(
                `SELECT s.active_tier_level_id, s.active_tier_until,
                        tl.display_label AS label
                   FROM public.user_tier_state s
                   LEFT JOIN public.tier_limits tl
                          ON tl.tier_level_id = s.active_tier_level_id
                  WHERE s.user_id = $1`,
                [userId],
            );
            const st = state.rows[0];
            const expiry = st
                ? expiryHistoryEntry({
                      level: st.active_tier_level_id,
                      until: st.active_tier_until,
                      label: st.label,
                  })
                : null;
            res.json({
                history: expiry ? [expiry, ...rows.rows] : rows.rows,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:id/tier-history]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * PATCH /adminmax/users/:userId/tier — manual tier assignment (the UMP
 * "flexible assignment" replacement). Body:
 *   { tier_level_id: number | null, until?: ISO | null, reason?: string }
 *
 * tier_level_id null (or the free level) clears the override → user is
 * free on the next request. A paid level activates immediately (the auth
 * middleware reads user_tier_state per request). When the user has a
 * wp_user_id and the partner push is configured, the change is mirrored
 * to UMP as well, same as the Stripe webhook does.
 */
adminDataRouter.patch(
    "/users/:userId/tier",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const body = req.body as {
            tier_level_id?: unknown;
            until?: unknown;
            reason?: unknown;
        };
        const reason =
            typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim().slice(0, 500)
                : null;
        const rawLevel = body.tier_level_id;
        const levelId =
            rawLevel == null ? null : Number(rawLevel);
        if (levelId !== null && (!Number.isInteger(levelId) || levelId <= 0)) {
            res.status(400).json({ detail: "Invalid tier_level_id" });
            return;
        }
        let until: Date | null = null;
        if (typeof body.until === "string" && body.until.trim()) {
            until = new Date(body.until);
            if (isNaN(until.getTime())) {
                res.status(400).json({ detail: "Invalid until date" });
                return;
            }
        }
        try {
            const userRow = await query<{
                id: string;
                wp_user_id: number | null;
            }>(`SELECT id, wp_user_id FROM public.users WHERE id = $1`, [
                userId,
            ]);
            if (userRow.rows.length === 0) {
                res.status(404).json({ detail: "User not found" });
                return;
            }
            const wpUserId = userRow.rows[0].wp_user_id;
            const freeLevel = getFreeTierLevelId();
            const clearing = levelId === null || levelId === freeLevel;

            // A paid grant with `until` in the past is instantly-expired —
            // the effective tier folds it to free, so the operator sees the
            // user "revert to Free" right after assigning. Only guarded for
            // grants: clears ignore `until`, and rejecting there would break
            // clearing while a stale date sits in the form.
            if (!clearing && until && until.getTime() <= Date.now()) {
                res.status(400).json({
                    detail: "until must be in the future",
                });
                return;
            }

            if (!clearing) {
                // Definition existence check via tierLimitsStore (creates
                // invalidate its cache, so a just-created tier is visible).
                const tierRow = await getTierLimitsRow(levelId as number);
                if (!tierRow) {
                    res.status(400).json({
                        detail: `Unknown tier_level_id ${levelId} — create it under /adminmax/tiers first`,
                    });
                    return;
                }
                await setLocalTierActive(userId, levelId as number, until, {}, {
                    source: "admin",
                    reason: reason ?? "AdminMax manual assignment",
                });
            } else {
                await clearLocalTierOverride(userId, {
                    source: "admin",
                    reason: reason ?? "AdminMax manual clear",
                });
            }

            // Mirror to the partner site (UMP) while it is still alive —
            // best-effort, same contract as the Stripe webhook push.
            if (wpUserId) {
                const payload: MembershipPushPayload = {
                    wp_user_id: wpUserId,
                    level_id: clearing ? freeLevel : (levelId as number),
                    action: clearing ? "revoke" : "assign",
                    expires_at: until ? until.toISOString() : null,
                    reason: `adminmax manual ${reason ?? ""}`.trim(),
                    request_id: `adminmax-tier-${userId}-${Date.now()}`,
                    sent_at: new Date().toISOString(),
                };
                await pushMembershipChange(payload);
            }

            const state = await query<{
                active_tier_level_id: number | null;
                active_tier_until: string | null;
            }>(
                `SELECT active_tier_level_id, active_tier_until
                   FROM public.user_tier_state WHERE user_id = $1`,
                [userId],
            );
            console.log(
                `[adminmax/tier] user=${userId} → ${clearing ? "free (cleared)" : levelId} until=${until?.toISOString() ?? "—"} reason=${reason ?? "-"}`,
            );
            void logAdminAudit({
                action: clearing ? "user.tier.clear" : "user.tier.set",
                targetType: "user",
                targetId: userId,
                payload: {
                    tier_level_id: clearing ? null : levelId,
                    until: until?.toISOString() ?? null,
                    reason,
                },
                ...auditMeta(req, res),
            });
            res.json({
                ok: true,
                tier: {
                    active_tier_level_id:
                        state.rows[0]?.active_tier_level_id ?? null,
                    active_tier_until:
                        state.rows[0]?.active_tier_until ?? null,
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:id/tier PATCH]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * PATCH /adminmax/users/:userId/profile — edit operator-managed profile
 * fields. Body: { display_name?, country? }. `display_name` lives on
 * public.users; `country` (ISO-3166-1 alpha-2, free-form here) lives on
 * user_tier_state and is upserted. Send `null`/"" to clear a field.
 * Omitting a field leaves it unchanged.
 */
adminDataRouter.patch(
    "/users/:userId/profile",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const body = req.body as {
            display_name?: unknown;
            country?: unknown;
        };

        // Normalize: a present string (trimmed; "" → null) updates the
        // field; `undefined` (key absent) leaves it unchanged.
        function norm(v: unknown, max: number): string | null | undefined {
            if (v === undefined) return undefined;
            if (v === null) return null;
            if (typeof v !== "string") return undefined;
            const t = v.trim().slice(0, max);
            return t.length === 0 ? null : t;
        }
        const displayName = norm(body.display_name, 200);
        const country = norm(body.country, 120);

        if (displayName === undefined && country === undefined) {
            res.status(400).json({ detail: "Nothing to update" });
            return;
        }

        try {
            const userRow = await query<{ id: string }>(
                `SELECT id FROM public.users WHERE id = $1`,
                [userId],
            );
            if (userRow.rows.length === 0) {
                res.status(404).json({ detail: "User not found" });
                return;
            }

            if (displayName !== undefined) {
                await query(
                    `UPDATE public.users SET display_name = $2 WHERE id = $1`,
                    [userId, displayName],
                );
            }
            if (country !== undefined) {
                await query(
                    `INSERT INTO public.user_tier_state (user_id, country)
                     VALUES ($1, $2)
                     ON CONFLICT (user_id)
                     DO UPDATE SET country = EXCLUDED.country`,
                    [userId, country],
                );
            }

            const updated = await query<{
                display_name: string | null;
                country: string | null;
            }>(
                `SELECT u.display_name, s.country
                   FROM public.users u
                   LEFT JOIN public.user_tier_state s ON s.user_id = u.id
                  WHERE u.id = $1`,
                [userId],
            );
            console.log(
                `[adminmax/profile] user=${userId} display_name=${displayName === undefined ? "(unchanged)" : displayName} country=${country === undefined ? "(unchanged)" : country}`,
            );
            void logAdminAudit({
                action: "user.profile.update",
                targetType: "user",
                targetId: userId,
                payload: {
                    ...(displayName !== undefined
                        ? { display_name: displayName }
                        : {}),
                    ...(country !== undefined ? { country } : {}),
                },
                ...auditMeta(req, res),
            });
            res.json({
                ok: true,
                user: {
                    display_name: updated.rows[0]?.display_name ?? null,
                    country: updated.rows[0]?.country ?? null,
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:id/profile PATCH]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/users/:userId/suspend — ban/unban the user's Supabase
 * account. Body: { action: "ban" | "unban", hours?: number } (default
 * ban ≈ permanent). Requires the user to have a Supabase identity and
 * SUPABASE_SECRET_KEY configured; legacy WP-only users get a 409.
 */
adminDataRouter.post(
    "/users/:userId/suspend",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const action =
            req.body?.action === "unban" ? "unban" : ("ban" as const);
        const hoursRaw = Number(req.body?.hours);
        // Default ~100 years — GoTrue has no "forever", so this is it.
        const hours =
            Number.isFinite(hoursRaw) && hoursRaw > 0
                ? Math.min(hoursRaw, 876_000)
                : 876_000;
        if (!isSupabaseAdminConfigured()) {
            res.status(503).json({
                detail: "Supabase admin nije konfiguriran (SUPABASE_SECRET_KEY)",
            });
            return;
        }
        try {
            const ident = await query<{ supabase_user_id: string }>(
                `SELECT supabase_user_id::text AS supabase_user_id
                   FROM public.user_supabase_identity WHERE user_id = $1`,
                [userId],
            );
            const supabaseId = ident.rows[0]?.supabase_user_id;
            if (!supabaseId) {
                res.status(409).json({
                    detail: "Korisnik nema Supabase račun (legacy WP login)",
                });
                return;
            }
            if (action === "ban") {
                await banSupabaseUser(supabaseId, hours);
            } else {
                await unbanSupabaseUser(supabaseId);
            }
            console.log(
                `[adminmax/suspend] user=${userId} action=${action} hours=${action === "ban" ? hours : "-"}`,
            );
            void logAdminAudit({
                action:
                    action === "ban" ? "user.suspend" : "user.unsuspend",
                targetType: "user",
                targetId: userId,
                payload: action === "ban" ? { hours } : null,
                ...auditMeta(req, res),
            });
            res.json({ ok: true, action });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:id/suspend]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * GET /adminmax/analytics — growth time series + tier distribution for
 * the dashboard charts. Honors ?from/?to (default last 30 days).
 *
 * Response:
 *   {
 *     range,
 *     daily: [{ day, signups, active_users, requests, cost_usd,
 *               tokens, revenue_eur_cents }],
 *     tiers: [{ tier_level_id, label, users }],     // current snapshot
 *     totals: { new_users, active_users, requests, cost_usd,
 *               revenue_eur_cents }
 *   }
 */
adminDataRouter.get("/analytics", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    try {
        const [
            signups,
            usage,
            revenue,
            tiers,
            activeTotal,
            revMetrics,
            surfaces,
            questions,
        ] = await Promise.all([
                query<{ day: string; signups: string }>(
                    `SELECT date_trunc('day', created_at)::date::text AS day,
                            COUNT(*)::text AS signups
                       FROM public.users
                      WHERE created_at >= $1 AND created_at < $2
                   GROUP BY 1 ORDER BY 1`,
                    [fromIso, toIso],
                ),
                query<{
                    day: string;
                    requests: string;
                    active_users: string;
                    cost_usd: string | null;
                    tokens: string | null;
                }>(
                    `SELECT date_trunc('day', created_at)::date::text AS day,
                            COUNT(*)::text AS requests,
                            COUNT(DISTINCT user_id)::text AS active_users,
                            COALESCE(SUM(cost_usd), 0) AS cost_usd,
                            COALESCE(SUM(
                                input_tokens + output_tokens
                                + cache_creation_input_tokens
                                + cache_read_input_tokens), 0) AS tokens
                       FROM public.llm_usage
                      WHERE created_at >= $1 AND created_at < $2
                   GROUP BY 1 ORDER BY 1`,
                    [fromIso, toIso],
                ),
                // Revenue = token packs (user_token_credits) + subscription
                // invoices (billing_revenue, fed by the Stripe webhook).
                // Both store cents; everything is EUR in practice.
                query<{ day: string; revenue_eur_cents: string | null }>(
                    `SELECT day, COALESCE(SUM(cents), 0) AS revenue_eur_cents
                       FROM (
                            SELECT date_trunc('day', granted_at)::date::text AS day,
                                   amount_eur_cents AS cents
                              FROM public.user_token_credits
                             WHERE granted_at >= $1 AND granted_at < $2
                               AND voided_at IS NULL
                               AND amount_eur_cents IS NOT NULL
                            UNION ALL
                            SELECT date_trunc('day', paid_at)::date::text AS day,
                                   amount_cents AS cents
                              FROM public.billing_revenue
                             WHERE paid_at >= $1 AND paid_at < $2
                       ) r
                   GROUP BY 1 ORDER BY 1`,
                    [fromIso, toIso],
                ),
                query<{
                    tier_level_id: string | number;
                    label: string | null;
                    users: string;
                }>(
                    `SELECT COALESCE(
                                CASE WHEN s.active_tier_level_id IS NOT NULL
                                      AND (s.active_tier_until IS NULL OR s.active_tier_until > now())
                                     THEN s.active_tier_level_id END,
                                $1::bigint) AS tier_level_id,
                            MAX(tl.display_label) AS label,
                            COUNT(*)::text AS users
                       FROM public.users u
                       LEFT JOIN public.user_tier_state s ON s.user_id = u.id
                       LEFT JOIN public.tier_limits tl
                              ON tl.tier_level_id = COALESCE(
                                    CASE WHEN s.active_tier_level_id IS NOT NULL
                                          AND (s.active_tier_until IS NULL OR s.active_tier_until > now())
                                         THEN s.active_tier_level_id END,
                                    $1::bigint)
                   GROUP BY 1 ORDER BY 1`,
                    [getFreeTierLevelId()],
                ),
                query<{ active_users: string }>(
                    `SELECT COUNT(DISTINCT user_id)::text AS active_users
                       FROM public.llm_usage
                      WHERE created_at >= $1 AND created_at < $2`,
                    [fromIso, toIso],
                ),
                // Revenue run-rate metrics from the subscription invoice
                // ledger (billing_revenue). NOW-anchored (independent of the
                // selected range), since MRR/ARR/NRR are point-in-time
                // run-rate figures. We have no billing-interval column, so:
                //   • MRR  = subscription revenue collected in the last 30d
                //   • ARR  = trailing-365d revenue (amortises annual plans)
                //   • bridge/NRR compare the last 30d vs the prior 30d per payer.
                query<{
                    mrr_cents: string;
                    arr_cents: string;
                    active_payers: string;
                    new_cents: string;
                    expansion_cents: string;
                    contraction_cents: string;
                    churned_cents: string;
                    base_cents: string;
                    retained_cents: string;
                }>(
                    `WITH curr AS (
                         SELECT user_id, SUM(amount_cents) AS cents
                           FROM public.billing_revenue
                          WHERE paid_at >= now() - interval '30 days'
                            AND user_id IS NOT NULL
                          GROUP BY user_id
                     ),
                     prev AS (
                         SELECT user_id, SUM(amount_cents) AS cents
                           FROM public.billing_revenue
                          WHERE paid_at >= now() - interval '60 days'
                            AND paid_at <  now() - interval '30 days'
                            AND user_id IS NOT NULL
                          GROUP BY user_id
                     ),
                     bridge AS (
                         SELECT
                             COALESCE(SUM(CASE WHEN p.cents IS NULL THEN c.cents ELSE 0 END), 0)                                       AS new_cents,
                             COALESCE(SUM(CASE WHEN p.cents IS NOT NULL AND c.cents > p.cents THEN c.cents - p.cents ELSE 0 END), 0)   AS expansion_cents,
                             COALESCE(SUM(CASE WHEN p.cents IS NOT NULL AND c.cents IS NOT NULL AND c.cents < p.cents THEN p.cents - c.cents ELSE 0 END), 0) AS contraction_cents,
                             COALESCE(SUM(CASE WHEN p.cents IS NOT NULL AND c.cents IS NULL THEN p.cents ELSE 0 END), 0)               AS churned_cents
                           FROM prev p
                           FULL OUTER JOIN curr c ON c.user_id = p.user_id
                     ),
                     nrr AS (
                         SELECT
                             COALESCE(SUM(p.cents), 0)                                              AS base_cents,
                             COALESCE(SUM(CASE WHEN c.cents IS NOT NULL THEN c.cents ELSE 0 END), 0) AS retained_cents
                           FROM prev p
                           LEFT JOIN curr c ON c.user_id = p.user_id
                     )
                     SELECT
                         (SELECT COALESCE(SUM(cents), 0) FROM curr)::text  AS mrr_cents,
                         (SELECT COALESCE(SUM(amount_cents), 0)
                            FROM public.billing_revenue
                           WHERE paid_at >= now() - interval '365 days')::text AS arr_cents,
                         (SELECT COUNT(*) FROM curr WHERE cents > 0)::text  AS active_payers,
                         b.new_cents::text, b.expansion_cents::text,
                         b.contraction_cents::text, b.churned_cents::text,
                         n.base_cents::text, n.retained_cents::text
                       FROM bridge b, nrr n`,
                ),
                // Usage split by product surface. `client` is the surface
                // tag on llm_usage ("web", "word", "tabular", …); rows
                // written before call sites tagged themselves group under
                // "unknown".
                query<{
                    surface: string;
                    requests: string;
                    users: string;
                    cost_usd: string | null;
                    tokens: string | null;
                }>(
                    `SELECT COALESCE(client, 'unknown') AS surface,
                            COUNT(*)::text AS requests,
                            COUNT(DISTINCT user_id)::text AS users,
                            COALESCE(SUM(cost_usd), 0) AS cost_usd,
                            COALESCE(SUM(
                                input_tokens + output_tokens
                                + cache_creation_input_tokens
                                + cache_read_input_tokens), 0) AS tokens
                       FROM public.llm_usage
                      WHERE created_at >= $1 AND created_at < $2
                   GROUP BY 1
                   ORDER BY SUM(cost_usd) DESC NULLS LAST`,
                    [fromIso, toIso],
                ),
                // Questions = users' own chat messages (regular + project
                // chats); llm_usage rows also count background calls.
                query<{ day: string; questions: string }>(
                    `SELECT date_trunc('day', created_at)::date::text AS day,
                            COUNT(*)::text AS questions
                       FROM public.chat_messages
                      WHERE role = 'user'
                        AND created_at >= $1 AND created_at < $2
                   GROUP BY 1 ORDER BY 1`,
                    [fromIso, toIso],
                ),
            ]);

        // Merge the three day-keyed series into one dense array (fill
        // gaps with zeroes so charts don't skip quiet days).
        const byDay = new Map<
            string,
            {
                day: string;
                signups: number;
                active_users: number;
                requests: number;
                questions: number;
                cost_usd: number;
                tokens: number;
                revenue_eur_cents: number;
            }
        >();
        const dayCursor = new Date(
            Date.UTC(
                from.getUTCFullYear(),
                from.getUTCMonth(),
                from.getUTCDate(),
            ),
        );
        while (dayCursor.getTime() < to.getTime()) {
            const key = dayCursor.toISOString().slice(0, 10);
            byDay.set(key, {
                day: key,
                signups: 0,
                active_users: 0,
                requests: 0,
                questions: 0,
                cost_usd: 0,
                tokens: 0,
                revenue_eur_cents: 0,
            });
            dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
        }
        for (const r of signups.rows) {
            const d = byDay.get(r.day);
            if (d) d.signups = Number(r.signups);
        }
        for (const r of usage.rows) {
            const d = byDay.get(r.day);
            if (d) {
                d.requests = Number(r.requests);
                d.active_users = Number(r.active_users);
                d.cost_usd = Number(r.cost_usd ?? 0);
                d.tokens = Number(r.tokens ?? 0);
            }
        }
        for (const r of questions.rows) {
            const d = byDay.get(r.day);
            if (d) d.questions = Number(r.questions);
        }
        for (const r of revenue.rows) {
            const d = byDay.get(r.day);
            if (d) d.revenue_eur_cents = Number(r.revenue_eur_cents ?? 0);
        }
        const daily = Array.from(byDay.values());

        res.json({
            range: { from: fromIso, to: toIso },
            daily,
            tiers: tiers.rows.map((r) => ({
                tier_level_id: Number(r.tier_level_id),
                label: r.label,
                users: Number(r.users),
            })),
            totals: {
                new_users: daily.reduce((s, d) => s + d.signups, 0),
                active_users: Number(activeTotal.rows[0]?.active_users ?? 0),
                requests: daily.reduce((s, d) => s + d.requests, 0),
                questions: daily.reduce((s, d) => s + d.questions, 0),
                cost_usd: daily.reduce((s, d) => s + d.cost_usd, 0),
                revenue_eur_cents: daily.reduce(
                    (s, d) => s + d.revenue_eur_cents,
                    0,
                ),
            },
            revenue_metrics: buildRevenueMetrics(revMetrics.rows[0]),
            surfaces: surfaces.rows.map((r) => ({
                surface: r.surface,
                requests: Number(r.requests),
                users: Number(r.users),
                cost_usd: Number(r.cost_usd ?? 0),
                tokens: Number(r.tokens ?? 0),
            })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/analytics]", msg);
        res.status(500).json({ detail: msg });
    }
});

/**
 * GET /adminmax/users/:userId/usage
 * Paginated llm_usage rows for the user, newest first.
 */
adminDataRouter.get(
    "/users/:userId/usage",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const { from, to } = parseDateRange(req);
        const { limit, offset } = parsePagination(req);
        try {
            const result = await query(
                `
                SELECT id, provider, model, chat_id, project_id,
                       chat_message_id, project_chat_message_id,
                       iterations,
                       input_tokens, output_tokens,
                       cache_creation_input_tokens, cache_read_input_tokens,
                       cost_usd, cost_breakdown, duration_ms, status, error_message,
                       created_at
                  FROM public.llm_usage
                 WHERE user_id = $1
                   AND created_at >= $2
                   AND created_at <  $3
              ORDER BY created_at DESC
                 LIMIT $4 OFFSET $5
                `,
                [
                    userId,
                    from.toISOString(),
                    to.toISOString(),
                    limit,
                    offset,
                ],
            );
            const total = await query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
                   FROM public.llm_usage
                  WHERE user_id = $1
                    AND created_at >= $2
                    AND created_at <  $3`,
                [userId, from.toISOString(), to.toISOString()],
            );
            res.json({
                range: { from: from.toISOString(), to: to.toISOString() },
                limit,
                offset,
                total: Number(total.rows[0]?.count ?? 0),
                rows: result.rows,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:userId/usage] failed:", msg);
            res.status(500).json({ detail: "Failed to load usage" });
        }
    },
);

/**
 * GET /adminmax/users/:userId/messages
 *
 * Paginated chat messages for the user (newest first), joined to
 * the parent chat row so the UI can render context (chat title,
 * project membership). Both regular chats (chats.user_id = uuid::text)
 * and project chats are included — project chats are still rooted in
 * `chats` with project_id set.
 */
adminDataRouter.get(
    "/users/:userId/messages",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const { from, to } = parseDateRange(req);
        const { limit, offset } = parsePagination(req);
        try {
            // chats.user_id is TEXT (legacy column type) — cast both sides
            // for a stable equality regardless of how the row was written.
            const result = await query(
                `
                SELECT cm.id, cm.role, cm.content, cm.files,
                       cm.annotations, cm.is_flagged, cm.created_at,
                       c.id      AS chat_id,
                       c.title   AS chat_title,
                       c.project_id
                  FROM public.chat_messages cm
                  JOIN public.chats c ON c.id = cm.chat_id
                 WHERE c.user_id::text = $1::text
                   AND cm.created_at >= $2
                   AND cm.created_at <  $3
              ORDER BY cm.created_at DESC
                 LIMIT $4 OFFSET $5
                `,
                [
                    userId,
                    from.toISOString(),
                    to.toISOString(),
                    limit,
                    offset,
                ],
            );
            const total = await query<{ count: string }>(
                `SELECT COUNT(*)::text AS count
                   FROM public.chat_messages cm
                   JOIN public.chats c ON c.id = cm.chat_id
                  WHERE c.user_id::text = $1::text
                    AND cm.created_at >= $2
                    AND cm.created_at <  $3`,
                [userId, from.toISOString(), to.toISOString()],
            );
            res.json({
                range: { from: from.toISOString(), to: to.toISOString() },
                limit,
                offset,
                total: Number(total.rows[0]?.count ?? 0),
                rows: result.rows,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:userId/messages] failed:", msg);
            res.status(500).json({ detail: "Failed to load messages" });
        }
    },
);

/**
 * GET /adminmax/chats/:chatId/full
 *
 * Returns the entire conversation thread (every chat_messages row) for
 * a single chat, ordered chronologically — user → assistant → user → …
 * — so admins can audit a complete Q+A exchange in one view. Each
 * assistant message carries a `usage` block (cost_usd + token counts for
 * the turn that produced it, joined from llm_usage); `totals` rolls up
 * the whole conversation's spend. Pulls BOTH regular chats and project
 * chats (they share the same `chats` table). Optional `?userId=`
 * cross-checks ownership so a typo in the URL doesn't leak someone
 * else's chat.
 */
adminDataRouter.get(
    "/chats/:chatId/full",
    async (req: Request, res: Response) => {
        const { chatId } = req.params;
        if (!isUuid(chatId)) {
            res.status(400).json({ detail: "Invalid chat id" });
            return;
        }
        const expectedUserId =
            typeof req.query.userId === "string" ? req.query.userId : null;
        try {
            const chat = await query<{
                id: string;
                title: string | null;
                user_id: string;
                project_id: string | null;
                created_at: string;
            }>(
                `SELECT id, title, user_id::text AS user_id, project_id, created_at
                 FROM public.chats
                 WHERE id = $1
                 LIMIT 1`,
                [chatId],
            );
            if (chat.rows.length === 0) {
                res.status(404).json({ detail: "Chat not found" });
                return;
            }
            const chatRow = chat.rows[0];
            if (
                expectedUserId &&
                isUuid(expectedUserId) &&
                chatRow.user_id !== expectedUserId
            ) {
                res.status(403).json({
                    detail: "Chat does not belong to the requested user",
                });
                return;
            }
            // Per-answer cost: aggregate llm_usage for this chat keyed by
            // the message that produced it. Regular chats link via
            // chat_message_id, project chats via project_chat_message_id —
            // both still live in chat_messages, so COALESCE picks whichever
            // column is set. SUM in case a turn ever logged >1 row.
            const messages = await query<{
                id: string;
                role: string;
                content: unknown;
                files: unknown;
                annotations: unknown;
                is_flagged: boolean | null;
                created_at: string;
                cost_usd: string | null;
                input_tokens: string | null;
                output_tokens: string | null;
                cache_creation_input_tokens: string | null;
                cache_read_input_tokens: string | null;
                iterations: string | null;
                usage_model: string | null;
                duration_ms: string | null;
                usage_rows: string | null;
                had_error: boolean | null;
            }>(
                `SELECT cm.id, cm.role, cm.content, cm.files, cm.annotations,
                        cm.is_flagged, cm.created_at,
                        lu.cost_usd, lu.input_tokens, lu.output_tokens,
                        lu.cache_creation_input_tokens,
                        lu.cache_read_input_tokens, lu.iterations,
                        lu.usage_model, lu.duration_ms, lu.usage_rows,
                        lu.had_error
                 FROM public.chat_messages cm
                 LEFT JOIN (
                     SELECT COALESCE(chat_message_id, project_chat_message_id) AS msg_id,
                            CASE WHEN bool_and(cost_usd IS NOT NULL)
                                 THEN SUM(cost_usd) ELSE NULL END AS cost_usd,
                            SUM(input_tokens)                AS input_tokens,
                            SUM(output_tokens)               AS output_tokens,
                            SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
                            SUM(cache_read_input_tokens)     AS cache_read_input_tokens,
                            SUM(iterations)                  AS iterations,
                            COUNT(*)                         AS usage_rows,
                            MAX(model)                       AS usage_model,
                            SUM(duration_ms)                 AS duration_ms,
                            bool_or(status = 'error')        AS had_error
                     FROM public.llm_usage
                     WHERE chat_id = $1
                       AND COALESCE(chat_message_id, project_chat_message_id) IS NOT NULL
                     GROUP BY COALESCE(chat_message_id, project_chat_message_id)
                 ) lu ON lu.msg_id = cm.id
                 WHERE cm.chat_id = $1
                 ORDER BY cm.created_at ASC, cm.id ASC`,
                [chatId],
            );
            // Conversation-wide total: every llm_usage row for this chat,
            // including any not linked to a surviving message (e.g. a turn
            // whose assistant insert failed) so the footer reflects true
            // spend, not just the sum of the rows we can attribute above.
            const totalsRes = await query<{
                cost_usd_total: string | null;
                input_tokens_total: string | null;
                output_tokens_total: string | null;
                cache_creation_input_tokens_total: string | null;
                cache_read_input_tokens_total: string | null;
                request_count: string;
                error_count: string;
            }>(
                `SELECT COALESCE(SUM(cost_usd), 0)                    AS cost_usd_total,
                        COALESCE(SUM(input_tokens), 0)                AS input_tokens_total,
                        COALESCE(SUM(output_tokens), 0)               AS output_tokens_total,
                        COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens_total,
                        COALESCE(SUM(cache_read_input_tokens), 0)     AS cache_read_input_tokens_total,
                        COUNT(*)                                      AS request_count,
                        COUNT(*) FILTER (WHERE status = 'error')      AS error_count
                 FROM public.llm_usage
                 WHERE chat_id = $1`,
                [chatId],
            );
            const userInfo = await query<{
                id: string;
                email: string;
                display_name: string | null;
            }>(
                `SELECT id, email, display_name
                 FROM public.users
                 WHERE id::text = $1
                 LIMIT 1`,
                [chatRow.user_id],
            );
            const t = totalsRes.rows[0];
            res.json({
                chat: chatRow,
                user: userInfo.rows[0] ?? null,
                messages: messages.rows.map((m) => ({
                    id: m.id,
                    role: m.role,
                    content: m.content,
                    files: m.files,
                    annotations: m.annotations,
                    is_flagged: m.is_flagged,
                    created_at: m.created_at,
                    // null for user turns and any assistant turn with no
                    // usage row; unknown/incomplete costs remain null.
                    usage:
                        m.usage_rows == null
                            ? null
                            : {
                                  cost_usd: m.cost_usd == null ? null : Number(m.cost_usd),
                                  input_tokens: Number(m.input_tokens ?? 0),
                                  output_tokens: Number(m.output_tokens ?? 0),
                                  cache_creation_input_tokens: Number(
                                      m.cache_creation_input_tokens ?? 0,
                                  ),
                                  cache_read_input_tokens: Number(
                                      m.cache_read_input_tokens ?? 0,
                                  ),
                                  iterations: Number(m.iterations ?? 0),
                                  model: m.usage_model,
                                  duration_ms:
                                      m.duration_ms == null
                                          ? null
                                          : Number(m.duration_ms),
                                  had_error: !!m.had_error,
                              },
                })),
                totals: {
                    cost_usd_total: Number(t?.cost_usd_total ?? 0),
                    input_tokens_total: Number(t?.input_tokens_total ?? 0),
                    output_tokens_total: Number(t?.output_tokens_total ?? 0),
                    cache_creation_input_tokens_total: Number(
                        t?.cache_creation_input_tokens_total ?? 0,
                    ),
                    cache_read_input_tokens_total: Number(
                        t?.cache_read_input_tokens_total ?? 0,
                    ),
                    request_count: Number(t?.request_count ?? 0),
                    error_count: Number(t?.error_count ?? 0),
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/chats/:chatId/full]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * GET /adminmax/users/:userId/usage.csv
 * Streams per-row usage as CSV. Honors the same ?from/?to filters.
 */
adminDataRouter.get(
    "/users/:userId/usage.csv",
    async (req: Request, res: Response) => {
        const { userId } = req.params;
        if (!isUuid(userId)) {
            res.status(400).json({ detail: "Invalid user id" });
            return;
        }
        const { from, to } = parseDateRange(req);
        try {
            const result = await query(
                `
                SELECT id, created_at, provider, model,
                       chat_id, project_id,
                       iterations,
                       input_tokens, output_tokens,
                       cache_creation_input_tokens, cache_read_input_tokens,
                       cost_usd, duration_ms, status, error_message
                  FROM public.llm_usage
                 WHERE user_id = $1
                   AND created_at >= $2
                   AND created_at <  $3
              ORDER BY created_at ASC
                `,
                [userId, from.toISOString(), to.toISOString()],
            );
            const fileFromIso = from.toISOString().slice(0, 10);
            const fileToIso = to.toISOString().slice(0, 10);
            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="adminmax_usage_${userId}_${fileFromIso}_${fileToIso}.csv"`,
            );
            res.write(
                csvRow([
                    "id",
                    "created_at",
                    "provider",
                    "model",
                    "chat_id",
                    "project_id",
                    "iterations",
                    "input_tokens",
                    "output_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                    "cost_usd",
                    "duration_ms",
                    "status",
                    "error_message",
                ]) + "\n",
            );
            for (const row of result.rows) {
                res.write(
                    csvRow([
                        row.id,
                        row.created_at,
                        row.provider,
                        row.model,
                        row.chat_id,
                        row.project_id,
                        row.iterations,
                        row.input_tokens,
                        row.output_tokens,
                        row.cache_creation_input_tokens,
                        row.cache_read_input_tokens,
                        row.cost_usd,
                        row.duration_ms,
                        row.status,
                        row.error_message,
                    ]) + "\n",
                );
            }
            res.end();
            void logAdminAudit({
                action: "export.usage_csv",
                targetType: "user",
                targetId: userId,
                payload: {
                    from: from.toISOString(),
                    to: to.toISOString(),
                    rows: result.rows.length,
                },
                ...auditMeta(req, res),
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:userId/usage.csv] failed:", msg);
            res.status(500).json({ detail: "Failed to export usage CSV" });
        }
    },
);

/**
 * GET /adminmax/usage.csv
 * Global CSV — every row across every user. Useful for offline reporting.
 */
adminDataRouter.get("/usage.csv", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    try {
        const result = await query(
            `
            SELECT lu.id, lu.created_at, u.email, lu.user_id,
                   lu.provider, lu.model,
                   lu.chat_id, lu.project_id,
                   lu.iterations,
                   lu.input_tokens, lu.output_tokens,
                   lu.cache_creation_input_tokens, lu.cache_read_input_tokens,
                   lu.cost_usd, lu.duration_ms, lu.status, lu.error_message
              FROM public.llm_usage lu
              LEFT JOIN public.users u ON u.id = lu.user_id
             WHERE lu.created_at >= $1
               AND lu.created_at <  $2
          ORDER BY lu.created_at ASC
            `,
            [from.toISOString(), to.toISOString()],
        );
        const fileFromIso = from.toISOString().slice(0, 10);
        const fileToIso = to.toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="adminmax_usage_all_${fileFromIso}_${fileToIso}.csv"`,
        );
        res.write(
            csvRow([
                "id",
                "created_at",
                "user_email",
                "user_id",
                "provider",
                "model",
                "chat_id",
                "project_id",
                "iterations",
                "input_tokens",
                "output_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
                "cost_usd",
                "duration_ms",
                "status",
                "error_message",
            ]) + "\n",
        );
        for (const row of result.rows) {
            res.write(
                csvRow([
                    row.id,
                    row.created_at,
                    row.email,
                    row.user_id,
                    row.provider,
                    row.model,
                    row.chat_id,
                    row.project_id,
                    row.iterations,
                    row.input_tokens,
                    row.output_tokens,
                    row.cache_creation_input_tokens,
                    row.cache_read_input_tokens,
                    row.cost_usd,
                    row.duration_ms,
                    row.status,
                    row.error_message,
                ]) + "\n",
            );
        }
        res.end();
        void logAdminAudit({
            action: "export.usage_csv",
            targetType: "export",
            targetId: "global",
            payload: {
                from: from.toISOString(),
                to: to.toISOString(),
                rows: result.rows.length,
            },
            ...auditMeta(req, res),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/usage.csv] failed:", msg);
        res.status(500).json({ detail: "Failed to export global CSV" });
    }
});

/**
 * GET /adminmax/chats — workspace-wide chat list, newest activity first.
 *
 * One row per chat with the owner's identity and a cost/message rollup,
 * so the operator can scan ALL conversations without entering each user
 * first (support + PII-compliance oversight). Both regular and project
 * chats are included (project chats live in the same `chats` table).
 *
 * Query params (all optional):
 *   - from, to   window on LAST ACTIVITY (newest message, falling back
 *                to chat creation for empty chats). Default last 30 days.
 *   - q          case-insensitive substring match on chat title, owner
 *                email/display name, OR message content (full-text-ish
 *                forensic search — content is matched as raw text).
 *   - limit/offset — standard pagination.
 */
adminDataRouter.get("/chats", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const { limit, offset } = parsePagination(req);
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const like = `%${rawQ}%`;
    // chats.user_id is TEXT (legacy column type) — cast both sides.
    // Two fragments (joins vs. where) so the list query can slot its
    // llm_usage LATERAL between them while the count query skips it.
    const baseJoins = `
          FROM public.chats c
          LEFT JOIN public.users u ON u.id::text = c.user_id::text
          JOIN LATERAL (
              SELECT COUNT(*)            AS message_count,
                     COUNT(*) FILTER (WHERE cm.role = 'user') AS question_count,
                     MAX(cm.created_at)  AS last_message_at
                FROM public.chat_messages cm
               WHERE cm.chat_id = c.id
          ) m ON TRUE`;
    const baseWhere = `
         WHERE COALESCE(m.last_message_at, c.created_at) >= $1
           AND COALESCE(m.last_message_at, c.created_at) <  $2
           AND ($3 = ''
                OR c.title ILIKE $4
                OR u.email ILIKE $4
                OR u.display_name ILIKE $4
                OR EXISTS (
                       SELECT 1 FROM public.chat_messages cm2
                        WHERE cm2.chat_id = c.id
                          AND cm2.content::text ILIKE $4
                   ))`;
    try {
        const rows = await query(
            `SELECT c.id, c.title, c.project_id, c.created_at,
                    c.user_id::text AS user_id,
                    u.email, u.display_name,
                    m.message_count, m.question_count,
                    COALESCE(m.last_message_at, c.created_at) AS last_activity_at,
                    COALESCE(lu.cost_usd_total, 0) AS cost_usd_total,
                    COALESCE(lu.request_count, 0)  AS request_count,
                    COALESCE(lu.error_count, 0)    AS error_count
             ${baseJoins}
              LEFT JOIN LATERAL (
                  SELECT SUM(l.cost_usd) AS cost_usd_total,
                         COUNT(*)        AS request_count,
                         COUNT(*) FILTER (WHERE l.status = 'error') AS error_count
                    FROM public.llm_usage l
                   WHERE l.chat_id = c.id
              ) lu ON TRUE
             ${baseWhere}
          ORDER BY COALESCE(m.last_message_at, c.created_at) DESC
             LIMIT $5 OFFSET $6`,
            [from.toISOString(), to.toISOString(), rawQ, like, limit, offset],
        );
        const total = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count ${baseJoins} ${baseWhere}`,
            [from.toISOString(), to.toISOString(), rawQ, like],
        );
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            limit,
            offset,
            total: Number(total.rows[0]?.count ?? 0),
            rows: rows.rows.map((r) => ({
                id: r.id,
                title: r.title,
                project_id: r.project_id,
                created_at: r.created_at,
                user_id: r.user_id,
                email: r.email,
                display_name: r.display_name,
                message_count: Number(r.message_count ?? 0),
                question_count: Number(r.question_count ?? 0),
                last_activity_at: r.last_activity_at,
                cost_usd_total: Number(r.cost_usd_total ?? 0),
                request_count: Number(r.request_count ?? 0),
                error_count: Number(r.error_count ?? 0),
            })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/chats]", msg);
        res.status(500).json({ detail: msg });
    }
});

/**
 * GET /adminmax/audit — the admin action audit trail, newest first.
 *
 * Query params (all optional):
 *   - from, to   window on created_at (default last 30 days)
 *   - q          case-insensitive substring match on action, target id
 *                or target type (e.g. "tier", "credits.grant", a user id)
 *   - limit/offset — standard pagination.
 */
/**
 * GET /adminmax/activity-events — read API over the workspace audit trail
 * (audit_events, migration 208 + surface column 210). Feeds the admin MCP's
 * feature-usage and per-user activity tools.
 *
 * Query: user_id?, event_type? (prefix match, e.g. "document."), surface?,
 * from/to (default last 30 days), limit/offset, aggregate=user|day|type|surface.
 * Without `aggregate` returns raw rows (newest first); with it, grouped counts.
 * Metadata is PII-lean by design (ids/enums only) so nothing is redacted here.
 */
adminDataRouter.get("/activity-events", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const { limit, offset } = parsePagination(req);
    const userId = typeof req.query.user_id === "string" && isUuid(req.query.user_id) ? req.query.user_id : null;
    const typePrefix = typeof req.query.event_type === "string" && req.query.event_type.trim() ? req.query.event_type.trim().slice(0, 80) : null;
    const surface = typeof req.query.surface === "string" && req.query.surface.trim() ? req.query.surface.trim().slice(0, 32) : null;
    const aggregate = typeof req.query.aggregate === "string" && ["user", "day", "type", "surface"].includes(req.query.aggregate) ? req.query.aggregate : null;
    const where = `WHERE created_at >= $1 AND created_at < $2
                     AND ($3::uuid IS NULL OR user_id = $3::uuid)
                     AND ($4::text IS NULL OR event_type LIKE $4::text || '%')
                     AND ($5::text IS NULL OR surface = $5::text)`;
    const params = [from.toISOString(), to.toISOString(), userId, typePrefix, surface];
    try {
        if (aggregate) {
            const col = aggregate === "user" ? "user_id" : aggregate === "day" ? "date_trunc('day', created_at)" : aggregate === "type" ? "event_type" : "surface";
            const r = await query<{ key: string | null; events: string; users: string }>(
                `SELECT ${col}::text AS key, COUNT(*)::text AS events, COUNT(DISTINCT user_id)::text AS users
                   FROM public.audit_events ${where}
               GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT $6 OFFSET $7`,
                [...params, limit, offset],
            );
            res.json({
                range: { from: from.toISOString(), to: to.toISOString() },
                aggregate,
                rows: r.rows.map((x) => ({ key: x.key, events: Number(x.events), users: Number(x.users) })),
            });
            return;
        }
        const [rows, total] = await Promise.all([
            query(`SELECT id, user_id, event_type, surface, project_id, document_id, review_id, chat_id, metadata, created_at
                     FROM public.audit_events ${where}
                 ORDER BY created_at DESC LIMIT $6 OFFSET $7`, [...params, limit, offset]),
            query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM public.audit_events ${where}`, params),
        ]);
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            pagination: { limit, offset, total: Number(total.rows[0]?.count ?? 0) },
            events: rows.rows,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/activity-events]", msg);
        res.status(500).json({ detail: "Failed to load activity events" });
    }
});

/**
 * GET /adminmax/features — feature adoption overview (migration 210):
 * per feature how many users ever used it and how many first used it in the
 * window; per event type and per surface counts in the window.
 */
adminDataRouter.get("/features", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const range = [from.toISOString(), to.toISOString()];
    try {
        const [features, byType, bySurface] = await Promise.all([
            query<{ feature: string; users_total: string; first_uses_in_range: string; last_first_use: string | null }>(
                `SELECT feature,
                        COUNT(*)::text AS users_total,
                        COUNT(*) FILTER (WHERE first_used_at >= $1 AND first_used_at < $2)::text AS first_uses_in_range,
                        MAX(first_used_at) AS last_first_use
                   FROM public.user_feature_first_use
               GROUP BY feature ORDER BY COUNT(*) DESC`, range),
            query<{ event_type: string; events: string; users: string }>(
                `SELECT event_type, COUNT(*)::text AS events, COUNT(DISTINCT user_id)::text AS users
                   FROM public.audit_events WHERE created_at >= $1 AND created_at < $2
               GROUP BY event_type ORDER BY COUNT(*) DESC`, range),
            query<{ surface: string | null; events: string; users: string }>(
                `SELECT surface, COUNT(*)::text AS events, COUNT(DISTINCT user_id)::text AS users
                   FROM public.audit_events WHERE created_at >= $1 AND created_at < $2
               GROUP BY surface ORDER BY COUNT(*) DESC`, range),
        ]);
        res.json({
            range: { from: range[0], to: range[1] },
            features: features.rows.map((r) => ({ feature: r.feature, users_total: Number(r.users_total), first_uses_in_range: Number(r.first_uses_in_range), last_first_use: r.last_first_use })),
            events_by_type: byType.rows.map((r) => ({ event_type: r.event_type, events: Number(r.events), users: Number(r.users) })),
            events_by_surface: bySurface.rows.map((r) => ({ surface: r.surface ?? "unknown", events: Number(r.events), users: Number(r.users) })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/features]", msg);
        res.status(500).json({ detail: "Failed to load feature adoption" });
    }
});

/**
 * GET /adminmax/users/:userId/features — one user's feature adoption:
 * first-use rows, event counts by type in the window, and the most recent
 * events (metadata is ids/enums only).
 */
adminDataRouter.get("/users/:userId/features", async (req: Request, res: Response) => {
    const { userId } = req.params;
    if (!isUuid(userId)) {
        res.status(400).json({ detail: "Invalid user id" });
        return;
    }
    const { from, to } = parseDateRange(req);
    try {
        const [first, counts, recent] = await Promise.all([
            query(`SELECT feature, surface, first_used_at FROM public.user_feature_first_use WHERE user_id = $1 ORDER BY first_used_at`, [userId]),
            query<{ event_type: string; count: string; last_at: string }>(
                `SELECT event_type, COUNT(*)::text AS count, MAX(created_at) AS last_at
                   FROM public.audit_events WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
               GROUP BY event_type ORDER BY COUNT(*) DESC`, [userId, from.toISOString(), to.toISOString()]),
            query(`SELECT event_type, surface, project_id, chat_id, review_id, document_id, metadata, created_at
                     FROM public.audit_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [userId]),
        ]);
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            features: first.rows,
            event_counts: counts.rows.map((r) => ({ event_type: r.event_type, count: Number(r.count), last_at: r.last_at })),
            recent_events: recent.rows,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/users/:userId/features]", msg);
        res.status(500).json({ detail: "Failed to load user features" });
    }
});

adminDataRouter.get("/audit", async (req: Request, res: Response) => {
    const { from, to } = parseDateRange(req);
    const { limit, offset } = parsePagination(req);
    const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const like = `%${rawQ}%`;
    const where = `
         WHERE created_at >= $1
           AND created_at <  $2
           AND ($3 = ''
                OR action ILIKE $4
                OR target_id ILIKE $4
                OR target_type ILIKE $4
                OR actor ILIKE $4)`;
    try {
        const rows = await query(
            `SELECT id, actor, action, target_type, target_id,
                    payload, ip, created_at
               FROM public.admin_audit
             ${where}
          ORDER BY created_at DESC
             LIMIT $5 OFFSET $6`,
            [from.toISOString(), to.toISOString(), rawQ, like, limit, offset],
        );
        const total = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM public.admin_audit ${where}`,
            [from.toISOString(), to.toISOString(), rawQ, like],
        );
        res.json({
            range: { from: from.toISOString(), to: to.toISOString() },
            limit,
            offset,
            total: Number(total.rows[0]?.count ?? 0),
            rows: rows.rows,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/audit]", msg);
        res.status(500).json({ detail: msg });
    }
});

// ── tier_limits CRUD ─────────────────────────────────────────────────────
//
// AdminMax operators tune the daily token quota per UMP tier here. All
// reads/writes go through lib/tierLimitsStore (Supabase or the legacy
// mike table, per TIERS_FROM_SUPABASE). The store keeps a ~60s row cache
// that every write invalidates, so a PATCH takes effect immediately on
// this instance and within the TTL on the others.

async function listTierLimitsHandler(_req: Request, res: Response): Promise<void> {
    try {
        // `user_count` = users currently on this tier via a live (non-expired)
        // override. The free tier is the implicit default (most free users have
        // no override row), so it's flagged separately and never counted as
        // empty — the AdminMax filter dropdown uses this to hide leftover/empty
        // tier rows without anyone having to delete them from the catalog.
        //
        // Definitions come from tierLimitsStore; the per-tier user counts are
        // a `user_tier_state` aggregate and stay a mike-DB query (per-user
        // tier assignment is Phase B — not this store's concern).
        const freeLevelId = getFreeTierLevelId();
        const [rows, counts] = await Promise.all([
            getAllTierLimits(),
            query<{ lvl: string | number; cnt: string | number }>(
                `SELECT active_tier_level_id AS lvl, COUNT(*) AS cnt
                   FROM public.user_tier_state
                  WHERE active_tier_level_id IS NOT NULL
                    AND (active_tier_until IS NULL OR active_tier_until > now())
               GROUP BY active_tier_level_id`,
            ),
        ]);
        const countByLevel = new Map<number, number>(
            counts.rows.map((c) => [Number(c.lvl), Number(c.cnt)]),
        );
        // Read-only enrichment: attach the public monthly PRICE string (the
        // exact same source /billing/plans exposes — the plan catalog's hr
        // price) and the env-driven Stripe product id per tier. Both are null
        // for tiers with no public plan / no Stripe product (free, enterprise,
        // foundation, …). This does not touch the write path.
        const catalog = await getPlanCatalog();
        const priceByLevel = new Map<number, string>(
            catalog.map((p) => [p.tierLevelId, p.marketing.locales.hr.price]),
        );
        const productBySlug = new Map<string, string | null>(
            getPlanDefs().map((p) => [p.slug, p.productId]),
        );
        res.json({
            tiers: [...rows]
                .sort((a, b) => a.tier_level_id - b.tier_level_id)
                .map((r) => ({
                    tier_level_id: r.tier_level_id,
                    tier_slug: r.tier_slug,
                    // The catalog column whose defaults apply to this row
                    // (from the level id, as the runtime resolves it).
                    tier_key: tierKeyForLevelId(r.tier_level_id),
                    display_label: r.display_label,
                    daily_tokens: r.daily_tokens,
                    entitlements: r.entitlements,
                    marketing: r.marketing,
                    price: priceByLevel.get(r.tier_level_id) ?? null,
                    stripe_product_id: productBySlug.get(r.tier_slug) ?? null,
                    updated_at: r.updated_at,
                    user_count: countByLevel.get(r.tier_level_id) ?? 0,
                    is_free: r.tier_level_id === freeLevelId,
                })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/tiers GET]", msg);
        res.status(500).json({ detail: msg });
    }
}

/**
 * GET /adminmax/tiers — list every configured tier ordered by id.
 */
adminDataRouter.get("/tiers", listTierLimitsHandler);

/**
 * GET /adminmax/tier-limits — alias for `/tiers` (legacy curl / bookmarks).
 */
adminDataRouter.get("/tier-limits", listTierLimitsHandler);

/**
 * GET /adminmax/entitlement-catalog — the code-defined catalog of every
 * entitlement key (type, group, HR/EN label, per-tier default). The
 * AdminMax tiers editor renders its toggles from this so the form can
 * never drift from the backend's notion of valid keys.
 */
adminDataRouter.get("/entitlement-catalog", (_req: Request, res: Response) => {
    res.json({ catalog: entitlementCatalog() });
});

const MAX_DAILY_TOKENS = 1_000_000_000; // 1B sanity cap

/**
 * PATCH /adminmax/tiers/:tierLevelId — update label and/or quota.
 */
adminDataRouter.patch(
    "/tiers/:tierLevelId",
    async (req: Request, res: Response) => {
        const tierLevelId = Number(req.params.tierLevelId);
        if (!Number.isInteger(tierLevelId) || tierLevelId <= 0) {
            res.status(400).json({ detail: "Invalid tier_level_id" });
            return;
        }
        const { daily_tokens, display_label, tier_slug, entitlements, marketing } =
            req.body as {
                daily_tokens?: unknown;
                display_label?: unknown;
                tier_slug?: unknown;
                entitlements?: unknown;
                marketing?: unknown;
            };
        const patch: TierDefinitionPatch = {};
        if (daily_tokens !== undefined) {
            const n = Number(daily_tokens);
            if (!Number.isFinite(n) || n < 0 || n > MAX_DAILY_TOKENS) {
                res.status(400).json({ detail: "daily_tokens out of range" });
                return;
            }
            patch.daily_tokens = Math.floor(n);
        }
        if (typeof display_label === "string" && display_label.trim()) {
            patch.display_label = display_label.trim();
        }
        if (typeof tier_slug === "string" && tier_slug.trim()) {
            patch.tier_slug = tier_slug.trim();
        }
        // Shallow-merge entitlements so a partial PATCH only touches the
        // keys it sends. sanitizeEntitlementsInput drops unknown keys and
        // wrong types, so the jsonb never accumulates junk.
        if (entitlements !== undefined) {
            const clean = sanitizeEntitlementsInput(entitlements);
            if (Object.keys(clean).length > 0) {
                patch.entitlementsMerge = clean;
            }
        }
        // Marketing copy is a whole structured object (per-locale) — the
        // editor sends it complete, so we replace rather than merge.
        if (marketing !== undefined) {
            const cleanMkt = sanitizeMarketingInput(marketing);
            if (cleanMkt) {
                patch.marketing = cleanMkt as unknown as Record<string, unknown>;
            }
        }
        if (Object.keys(patch).length === 0) {
            res.status(400).json({ detail: "No fields to update" });
            return;
        }
        try {
            const tier = await updateTierDefinition(tierLevelId, patch);
            if (!tier) {
                res.status(404).json({ detail: "Tier not found" });
                return;
            }
            // Feature gates + the public /billing/plans catalog read 30s-TTL
            // caches; bust both so the operator sees changes immediately on
            // this instance (others refresh within the TTL). The store's own
            // row cache is invalidated by the write itself.
            bustEntitlementsCache();
            bustPlanCatalogCache();
            void logAdminAudit({
                action: "tier.update",
                targetType: "tier",
                targetId: String(tierLevelId),
                payload: {
                    ...(patch.daily_tokens !== undefined
                        ? { daily_tokens: patch.daily_tokens }
                        : {}),
                    ...(patch.display_label !== undefined
                        ? { display_label: patch.display_label }
                        : {}),
                    ...(patch.tier_slug !== undefined
                        ? { tier_slug: patch.tier_slug }
                        : {}),
                    // Payload stays small: record WHICH entitlement keys
                    // changed (values are in tier_limits) and whether
                    // marketing copy was replaced.
                    ...(patch.entitlementsMerge
                        ? {
                              entitlement_keys: Object.keys(
                                  patch.entitlementsMerge,
                              ),
                          }
                        : {}),
                    ...(patch.marketing ? { marketing_updated: true } : {}),
                },
                ...auditMeta(req, res),
            });
            res.json({ tier });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/tiers PATCH]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/tiers — create a tier row (rare; lazy-upsert covers
 * the normal flow). Useful when admin wants to pre-configure an UMP
 * tier_level_id before any user with that tier logs in.
 */
adminDataRouter.post("/tiers", async (req: Request, res: Response) => {
    const { tier_level_id, tier_slug, display_label, daily_tokens, entitlements } =
        req.body as {
            tier_level_id?: unknown;
            tier_slug?: unknown;
            display_label?: unknown;
            daily_tokens?: unknown;
            entitlements?: unknown;
        };
    const id = Number(tier_level_id);
    const tokens = Number(daily_tokens);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ detail: "Invalid tier_level_id" });
        return;
    }
    if (typeof tier_slug !== "string" || !tier_slug.trim()) {
        res.status(400).json({ detail: "tier_slug required" });
        return;
    }
    if (typeof display_label !== "string" || !display_label.trim()) {
        res.status(400).json({ detail: "display_label required" });
        return;
    }
    if (!Number.isFinite(tokens) || tokens < 0 || tokens > MAX_DAILY_TOKENS) {
        res.status(400).json({ detail: "daily_tokens out of range" });
        return;
    }
    const cleanEntitlements = sanitizeEntitlementsInput(entitlements);
    try {
        await upsertTierDefinition({
            tier_level_id: id,
            tier_slug: tier_slug.trim(),
            display_label: display_label.trim(),
            daily_tokens: Math.floor(tokens),
            entitlements: cleanEntitlements,
        });
        bustEntitlementsCache();
        void logAdminAudit({
            action: "tier.create",
            targetType: "tier",
            targetId: String(id),
            payload: {
                tier_slug: tier_slug.trim(),
                display_label: display_label.trim(),
                daily_tokens: Math.floor(tokens),
            },
            ...auditMeta(req, res),
        });
        res.status(201).json({ ok: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/tiers POST]", msg);
        res.status(500).json({ detail: msg });
    }
});

// ── user_token_credits (top-up) ──────────────────────────────────────────
//
// AdminMax UI for granting bonus token packs to users. Three sources
// land here, all sharing the same row schema:
//
//   * stripe        — written by the Stripe webhook (NOT by these
//                     routes). Listed here for audit / void only.
//   * bank_transfer — admin sees the bank statement, grants tokens.
//   * admin_manual  — discretionary grant (compensation, marketing).
//
// Voiding is non-destructive: voided_at gets a timestamp and the row
// is excluded from the "active balance" SQL the rate limiter uses.

/**
 * GET /adminmax/users/:userId/credits — list grants and the live
 * balance. Includes voided rows (greyed in UI) for full audit.
 */
adminDataRouter.get(
    "/users/:userId/credits",
    async (req: Request, res: Response) => {
        const userId = req.params.userId;
        try {
            const credits = await query(
                `SELECT id, tokens_granted, tokens_consumed, payment_method,
                        external_reference, stripe_event_id, amount_eur_cents,
                        granted_by_admin_id, granted_at, expires_at,
                        voided_at, voided_reason, notes
                 FROM public.user_token_credits
                 WHERE user_id = $1
                 ORDER BY granted_at DESC`,
                [userId],
            );
            const balance = await query<{
                bonus_remaining: string | number;
                pack_count: string | number;
            }>(
                `SELECT
                    COALESCE(SUM(tokens_granted - tokens_consumed), 0)::bigint AS bonus_remaining,
                    COUNT(*) AS pack_count
                 FROM public.user_token_credits
                 WHERE user_id = $1
                   AND voided_at IS NULL
                   AND tokens_consumed < tokens_granted
                   AND (expires_at IS NULL OR expires_at > NOW())`,
                [userId],
            );
            res.json({
                grants: credits.rows,
                balance: {
                    bonus_remaining: Number(
                        balance.rows[0]?.bonus_remaining ?? 0,
                    ),
                    pack_count: Number(balance.rows[0]?.pack_count ?? 0),
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/users/:id/credits GET]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

const MAX_GRANT_TOKENS = 100_000_000; // 100M sanity cap per pack

/**
 * POST /adminmax/users/:userId/credits — grant a credit pack.
 * Used for bank_transfer (post-statement) and admin_manual paths.
 * Stripe grants come through the webhook, NOT this endpoint.
 */
adminDataRouter.post(
    "/users/:userId/credits",
    async (req: Request, res: Response) => {
        const userId = req.params.userId;
        const {
            tokens_granted,
            payment_method,
            external_reference,
            amount_eur_cents,
            expires_at,
            notes,
        } = req.body as {
            tokens_granted?: unknown;
            payment_method?: unknown;
            external_reference?: unknown;
            amount_eur_cents?: unknown;
            expires_at?: unknown;
            notes?: unknown;
        };
        const tokens = Number(tokens_granted);
        if (
            !Number.isFinite(tokens) ||
            tokens <= 0 ||
            tokens > MAX_GRANT_TOKENS
        ) {
            res.status(400).json({ detail: "tokens_granted out of range" });
            return;
        }
        const allowedMethods = new Set(["bank_transfer", "admin_manual"]);
        const method =
            typeof payment_method === "string" ? payment_method : "admin_manual";
        if (!allowedMethods.has(method)) {
            res.status(400).json({
                detail: "payment_method must be bank_transfer or admin_manual",
            });
            return;
        }
        const amountCents =
            amount_eur_cents == null
                ? null
                : Math.max(0, Math.floor(Number(amount_eur_cents)));
        const expiresIso =
            typeof expires_at === "string" && expires_at.trim()
                ? new Date(expires_at).toISOString()
                : null;
        const reference =
            typeof external_reference === "string"
                ? external_reference.trim()
                : null;
        const notesText =
            typeof notes === "string" && notes.trim().length > 0
                ? notes.trim()
                : null;
        const adminUserId =
            (res.locals.adminUserId as string | undefined) ??
            (res.locals.userId as string | undefined) ??
            null;

        try {
            const ins = await query<{ id: string }>(
                `INSERT INTO public.user_token_credits
                    (user_id, tokens_granted, payment_method, external_reference,
                     amount_eur_cents, granted_by_admin_id, expires_at, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id`,
                [
                    userId,
                    Math.floor(tokens),
                    method,
                    reference,
                    amountCents,
                    adminUserId,
                    expiresIso,
                    notesText,
                ],
            );
            console.log(
                `[adminmax/credits] grant id=${ins.rows[0].id} user=${userId} tokens=${tokens} method=${method} ref=${reference ?? "-"}`,
            );
            void logAdminAudit({
                action: "credits.grant",
                targetType: "user",
                targetId: userId,
                payload: {
                    credit_id: ins.rows[0].id,
                    tokens_granted: Math.floor(tokens),
                    payment_method: method,
                    external_reference: reference,
                    amount_eur_cents: amountCents,
                    expires_at: expiresIso,
                },
                ...auditMeta(req, res),
            });
            res.status(201).json({ id: ins.rows[0].id, tokens_granted: tokens });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/credits POST]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /adminmax/credits/:creditId/void — soft-delete a grant. Adds a
 * voided_at + voided_reason; future balance queries skip the row.
 */
adminDataRouter.post(
    "/credits/:creditId/void",
    async (req: Request, res: Response) => {
        const creditId = req.params.creditId;
        const reason =
            typeof req.body?.reason === "string" && req.body.reason.trim()
                ? req.body.reason.trim()
                : null;
        try {
            const result = await query(
                `UPDATE public.user_token_credits
                 SET voided_at = NOW(), voided_reason = $1
                 WHERE id = $2 AND voided_at IS NULL
                 RETURNING id, user_id, tokens_granted`,
                [reason, creditId],
            );
            if (result.rows.length === 0) {
                res.status(404).json({ detail: "Credit not found or already voided" });
                return;
            }
            console.log(
                `[adminmax/credits] void id=${creditId} reason=${reason ?? "-"}`,
            );
            void logAdminAudit({
                action: "credits.void",
                targetType: "credit",
                targetId: creditId,
                payload: {
                    user_id: result.rows[0].user_id,
                    tokens_granted: Number(result.rows[0].tokens_granted),
                    reason,
                },
                ...auditMeta(req, res),
            });
            res.json({ ok: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[adminmax/credits void]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// ── promo codes (Stripe coupons + promotion codes) ────────────────────────
//
// Promo codes live entirely in Stripe (a percent-off Coupon + a
// customer-facing Promotion Code on top, optionally restricted to
// specific products). Checkout already resolves and applies them
// (billing.ts runCheckout), so these routes only create/list/toggle
// codes and surface usage: Stripe's aggregate times_redeemed plus the
// per-code subscription/revenue attribution the webhook stamps into
// billing_revenue.promo_code.

const PROMO_CODE_RE = /^[A-Za-z0-9_-]{3,30}$/;

type PromoRevenueStat = {
    promo_code: string;
    invoices: string;
    subscribers: string;
    revenue_cents: string;
};

/**
 * GET /adminmax/promos — Stripe promotion codes (newest first) enriched
 * with the plans they're restricted to and billing_revenue stats.
 */
adminDataRouter.get("/promos", async (_req: Request, res: Response) => {
    if (!isStripeConfigured()) {
        res.json({ configured: false, promos: [] });
        return;
    }
    try {
        const stripe = getStripe();
        const [list, stats] = await Promise.all([
            stripe.promotionCodes.list({
                limit: 100,
                expand: ["data.promotion.coupon.applies_to"],
            }),
            query<PromoRevenueStat>(
                `SELECT promo_code,
                        COUNT(*)::text                    AS invoices,
                        COUNT(DISTINCT COALESCE(user_id::text, stripe_customer_id))::text
                                                          AS subscribers,
                        COALESCE(SUM(amount_cents), 0)::text AS revenue_cents
                   FROM public.billing_revenue
                  WHERE promo_code IS NOT NULL
                  GROUP BY promo_code`,
            ),
        ]);
        const statByCode = new Map(
            stats.rows.map((r) => [r.promo_code.toUpperCase(), r]),
        );
        const defs = getPlanDefs();
        const promos = list.data.map((p) => {
            // API ≥ clover nests the coupon under promotion.coupon
            // (expandable — string id unless expanded, see list() above).
            const rawCoupon = p.promotion?.coupon;
            const coupon =
                rawCoupon && typeof rawCoupon === "object" ? rawCoupon : null;
            const products = coupon?.applies_to?.products ?? [];
            const s = statByCode.get(p.code.toUpperCase());
            return {
                id: p.id,
                code: p.code,
                active: p.active,
                coupon_id: coupon?.id ?? null,
                coupon_valid: coupon?.valid ?? null,
                percent_off: coupon?.percent_off ?? null,
                amount_off: coupon?.amount_off ?? null,
                currency: coupon?.currency ?? null,
                duration: coupon?.duration ?? null,
                duration_in_months: coupon?.duration_in_months ?? null,
                // [] ⇒ the coupon applies to every product.
                plans: products.map(
                    (pid: string) =>
                        defs.find((d) => d.productId === pid)?.slug ?? pid,
                ),
                expires_at: p.expires_at
                    ? new Date(p.expires_at * 1000).toISOString()
                    : null,
                max_redemptions: p.max_redemptions ?? null,
                times_redeemed: p.times_redeemed ?? 0,
                created_at: new Date(p.created * 1000).toISOString(),
                stats: s
                    ? {
                          invoices: Number(s.invoices),
                          subscribers: Number(s.subscribers),
                          revenue_cents: Number(s.revenue_cents),
                      }
                    : null,
            };
        });
        res.json({ configured: true, promos });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/promos GET]", msg);
        res.status(500).json({ detail: msg });
    }
});

/**
 * POST /adminmax/promos — create a Coupon + Promotion Code in Stripe.
 *
 * Body: {
 *   code:               "HOK2026"            (3-30 chars, [A-Za-z0-9_-])
 *   percent_off:        20                   (1–100)
 *   duration?:          "forever" | "once" | "repeating"   (default forever)
 *   duration_in_months?: number              (required for "repeating")
 *   plans?:             string[]             (plan keys/slugs; empty = all)
 *   expires_at?:        ISO date             (last day the code can be entered)
 *   max_redemptions?:   number
 * }
 */
adminDataRouter.post("/promos", async (req: Request, res: Response) => {
    if (!isStripeConfigured()) {
        res.status(503).json({ detail: "Stripe nije konfiguriran" });
        return;
    }
    const {
        code,
        percent_off,
        duration,
        duration_in_months,
        plans,
        expires_at,
        max_redemptions,
    } = req.body as {
        code?: unknown;
        percent_off?: unknown;
        duration?: unknown;
        duration_in_months?: unknown;
        plans?: unknown;
        expires_at?: unknown;
        max_redemptions?: unknown;
    };
    if (typeof code !== "string" || !PROMO_CODE_RE.test(code.trim())) {
        res.status(400).json({
            detail: "code: 3–30 znakova, samo slova/brojke/_/-",
        });
        return;
    }
    const normalizedCode = code.trim().toUpperCase();
    const pct = Number(percent_off);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        res.status(400).json({ detail: "percent_off mora biti 1–100" });
        return;
    }
    const dur =
        duration === undefined || duration === "forever"
            ? "forever"
            : duration === "once" || duration === "repeating"
              ? duration
              : null;
    if (!dur) {
        res.status(400).json({
            detail: "duration: forever | once | repeating",
        });
        return;
    }
    let durMonths: number | undefined;
    if (dur === "repeating") {
        durMonths = Number(duration_in_months);
        if (!Number.isInteger(durMonths) || durMonths <= 0 || durMonths > 60) {
            res.status(400).json({
                detail: "duration_in_months: 1–60 (uz duration=repeating)",
            });
            return;
        }
    }
    // Plan keys/slugs → Stripe product ids. Unknown or unconfigured
    // plans are a hard error so a typo can't silently widen the coupon.
    const productIds: string[] = [];
    if (plans !== undefined) {
        if (!Array.isArray(plans) || plans.some((p) => typeof p !== "string")) {
            res.status(400).json({ detail: "plans mora biti lista stringova" });
            return;
        }
        const defs = getPlanDefs();
        for (const p of plans as string[]) {
            const def = defs.find((d) => d.plan === p || d.slug === p);
            if (!def) {
                res.status(400).json({ detail: `Nepoznat plan: ${p}` });
                return;
            }
            if (!def.productId) {
                res.status(400).json({
                    detail: `Plan ${p} nema konfiguriran Stripe product`,
                });
                return;
            }
            if (!productIds.includes(def.productId)) {
                productIds.push(def.productId);
            }
        }
    }
    let expiresAtUnix: number | undefined;
    if (expires_at !== undefined && expires_at !== null && expires_at !== "") {
        const t = new Date(String(expires_at)).getTime();
        if (!Number.isFinite(t) || t <= Date.now()) {
            res.status(400).json({
                detail: "expires_at mora biti valjan budući datum",
            });
            return;
        }
        expiresAtUnix = Math.floor(t / 1000);
    }
    let maxRedemptions: number | undefined;
    if (max_redemptions !== undefined && max_redemptions !== null) {
        maxRedemptions = Number(max_redemptions);
        if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
            res.status(400).json({
                detail: "max_redemptions mora biti pozitivan broj",
            });
            return;
        }
    }
    try {
        const stripe = getStripe();
        // Reject duplicates up front — Stripe allows several promotion
        // codes with the same code string as long as only one is active,
        // which would make stats ambiguous.
        const existing = await stripe.promotionCodes.list({
            code: normalizedCode,
            limit: 1,
        });
        if (existing.data.length > 0) {
            res.status(409).json({
                detail: `Kod ${normalizedCode} već postoji u Stripeu`,
            });
            return;
        }
        const coupon = await stripe.coupons.create({
            name: normalizedCode,
            percent_off: pct,
            duration: dur,
            ...(durMonths ? { duration_in_months: durMonths } : {}),
            ...(productIds.length
                ? { applies_to: { products: productIds } }
                : {}),
        });
        let promo;
        try {
            promo = await stripe.promotionCodes.create({
                promotion: { type: "coupon", coupon: coupon.id },
                code: normalizedCode,
                ...(expiresAtUnix ? { expires_at: expiresAtUnix } : {}),
                ...(maxRedemptions
                    ? { max_redemptions: maxRedemptions }
                    : {}),
            });
        } catch (err) {
            // Don't leave an orphan coupon behind a failed promo create.
            await stripe.coupons.del(coupon.id).catch(() => {});
            throw err;
        }
        void logAdminAudit({
            action: "promo.create",
            targetType: "promo",
            targetId: normalizedCode,
            payload: {
                promotion_code_id: promo.id,
                coupon_id: coupon.id,
                percent_off: pct,
                duration: dur,
                ...(durMonths ? { duration_in_months: durMonths } : {}),
                plans: productIds,
                ...(expiresAtUnix ? { expires_at: expiresAtUnix } : {}),
                ...(maxRedemptions ? { max_redemptions: maxRedemptions } : {}),
            },
            ...auditMeta(req, res),
        });
        res.status(201).json({ ok: true, id: promo.id, code: promo.code });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/promos POST]", msg);
        res.status(500).json({ detail: msg });
    }
});

/**
 * PATCH /adminmax/promos/:id — activate/deactivate a promotion code.
 * (Stripe promotion codes can't be deleted, only deactivated; an
 * expired code can't be reactivated — Stripe rejects it.)
 */
adminDataRouter.patch("/promos/:id", async (req: Request, res: Response) => {
    if (!isStripeConfigured()) {
        res.status(503).json({ detail: "Stripe nije konfiguriran" });
        return;
    }
    const id = String(req.params.id ?? "");
    if (!id.startsWith("promo_")) {
        res.status(400).json({ detail: "Nevaljan promotion code id" });
        return;
    }
    const { active } = req.body as { active?: unknown };
    if (typeof active !== "boolean") {
        res.status(400).json({ detail: "active mora biti boolean" });
        return;
    }
    try {
        const promo = await getStripe().promotionCodes.update(id, { active });
        void logAdminAudit({
            action: "promo.update",
            targetType: "promo",
            targetId: promo.code,
            payload: { promotion_code_id: id, active },
            ...auditMeta(req, res),
        });
        res.json({ ok: true, id: promo.id, active: promo.active });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/promos PATCH]", msg);
        res.status(500).json({ detail: msg });
    }
});

// ── MCP usage (Desk chat counters + portal connector join) ────────────────
//
// Two legs, read-only. Desk chat = mcp_tool_calls_daily (migration 213,
// written by lib/mcp/builtin.ts for every built-in MCP tool call). Connector
// = portal-service "manage" API joined through user_supabase_identity. The
// per-user summary also rides along on /users and /users/:id (`mcp` field)
// for the badge next to "Aktivnost".

// GET /adminmax/mcp/desk?days=30
adminDataRouter.get("/mcp/desk", async (req: Request, res: Response) => {
    const days = clampInt(req.query.days, 30, 1, 365);
    try {
        res.json(await loadDeskMcpOverview(days));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/mcp/desk]", msg);
        res.status(500).json({ detail: msg });
    }
});

// GET /adminmax/users/:userId/mcp?days=30
adminDataRouter.get("/users/:userId/mcp", async (req: Request, res: Response) => {
    const { userId } = req.params;
    if (!isUuid(userId)) {
        res.status(400).json({ detail: "Invalid user id" });
        return;
    }
    const days = clampInt(req.query.days, 30, 1, 365);
    try {
        res.json(await loadUserMcpDetail(userId, days));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[adminmax/users/:id/mcp]", msg);
        res.status(500).json({ detail: msg });
    }
});
