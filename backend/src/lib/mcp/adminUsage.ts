/**
 * AdminMax "who uses MCP" — read side over the two MCP usage channels.
 *
 *  1. Desk chat: built-in MCP tool calls made from inside Eulex Desk, counted
 *     in `mcp_tool_calls_daily` (migration 213) by (user, day, server, tool).
 *  2. Connector: mcp.eulex.ai traffic through portal API keys / OAuth from
 *     external agents (Claude, ChatGPT, Copilot, Cursor …). That data lives
 *     in the separate portal service; we fetch its `/manage/users/mcp-summary`
 *     map over the network and join it to Max users through
 *     `user_supabase_identity`. Max never stores the portal's rows.
 *
 * Every leg fails soft: a missing table, a portal outage or an unset
 * PORTAL_MANAGE_URL degrades to "no data" for that leg, never to a 500 on
 * the users list.
 */
import { query } from "../db";
import { portalManageConfigured, portalManageFetch } from "../portalManage";

export interface AdminUserMcp {
    /** Window (days) the *_calls counters cover. */
    days: number;
    desk_available: boolean;
    desk_calls: number;
    desk_last_day: string | null;
    desk_top_tool: string | null;
    connector_available: boolean;
    connector_calls: number;
    connector_last_day: string | null;
    connector_calls_all: number;
    connector_last_day_all: string | null;
    connector_top_tool: string | null;
    connector_clients: string[];
    connector_active_keys: number;
}

interface PortalMcpUser {
    calls_range: number;
    last_call_day: string | null;
    calls_all: number;
    last_call_day_all: string | null;
    active_keys: number;
    top_tool: string | null;
    clients: string[];
}

const DEFAULT_DAYS = 30;
const PORTAL_CACHE_TTL_MS = 60_000;
const WARN_INTERVAL_MS = 60_000;

let portalCache: { at: number; days: number; users: Record<string, PortalMcpUser> } | null = null;
let portalInflight: Promise<Record<string, PortalMcpUser> | null> | null = null;
const lastWarnAt: Record<string, number> = {};

function warnThrottled(tag: string, err: unknown): void {
    const now = Date.now();
    if (now - (lastWarnAt[tag] ?? 0) < WARN_INTERVAL_MS) return;
    lastWarnAt[tag] = now;
    console.warn(`[adminmax/mcp] ${tag} (throttled 60 s):`, err instanceof Error ? err.message : err);
}

function isMissingTable(err: unknown): boolean {
    return err instanceof Error && /relation "mcp_tool_calls_daily" does not exist/.test(err.message);
}

function dayStr(v: unknown): string | null {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
}

/** Portal-side summary map, cached 60 s (one fetch serves a whole page walk). */
async function portalSummary(days: number): Promise<Record<string, PortalMcpUser> | null> {
    if (!portalManageConfigured()) return null;
    const now = Date.now();
    if (portalCache && portalCache.days === days && now - portalCache.at < PORTAL_CACHE_TTL_MS) {
        return portalCache.users;
    }
    if (portalInflight) return portalInflight;
    portalInflight = (async () => {
        try {
            const res = await portalManageFetch<{ users?: Record<string, PortalMcpUser> }>(
                `/manage/users/mcp-summary?days=${days}`,
                { timeoutMs: 8_000 },
            );
            const users = res.users ?? {};
            portalCache = { at: Date.now(), days, users };
            return users;
        } catch (err) {
            warnThrottled("portal mcp-summary fetch failed", err);
            return portalCache?.users ?? null;
        } finally {
            portalInflight = null;
        }
    })();
    return portalInflight;
}

async function supabaseIdsFor(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0) return out;
    try {
        const res = await query<{ user_id: string; supabase_user_id: string }>(
            `SELECT user_id::text AS user_id, supabase_user_id::text AS supabase_user_id
               FROM public.user_supabase_identity
              WHERE user_id = ANY($1::uuid[])`,
            [userIds],
        );
        for (const r of res.rows) out.set(r.user_id, r.supabase_user_id);
    } catch (err) {
        warnThrottled("user_supabase_identity lookup failed", err);
    }
    return out;
}

/**
 * Per-user MCP summary for a page of users. Desk leg = one grouped query
 * over the ids; connector leg = cached portal map + identity join.
 */
export async function loadUserMcpSummaries(
    userIds: string[],
    days: number = DEFAULT_DAYS,
): Promise<Map<string, AdminUserMcp>> {
    const out = new Map<string, AdminUserMcp>();
    if (userIds.length === 0) return out;

    const blank = (): AdminUserMcp => ({
        days,
        desk_available: true,
        desk_calls: 0,
        desk_last_day: null,
        desk_top_tool: null,
        connector_available: portalManageConfigured(),
        connector_calls: 0,
        connector_last_day: null,
        connector_calls_all: 0,
        connector_last_day_all: null,
        connector_top_tool: null,
        connector_clients: [],
        connector_active_keys: 0,
    });
    for (const id of userIds) out.set(id, blank());

    // ── Desk leg ──────────────────────────────────────────────────────────
    let deskAvailable = true;
    try {
        const res = await query<{
            user_id: string;
            calls: string;
            last_day: string | null;
            top_tool: string | null;
        }>(
            `WITH agg AS (
                 SELECT user_id, SUM(calls) AS calls, MAX(day) AS last_day
                   FROM public.mcp_tool_calls_daily
                  WHERE user_id = ANY($1::uuid[])
                    AND day > (now() AT TIME ZONE 'utc')::date - $2::int
                  GROUP BY user_id
             ),
             tt AS (
                 SELECT DISTINCT ON (user_id) user_id, tool
                   FROM (SELECT user_id, tool, SUM(calls) AS c
                           FROM public.mcp_tool_calls_daily
                          WHERE user_id = ANY($1::uuid[])
                            AND day > (now() AT TIME ZONE 'utc')::date - $2::int
                          GROUP BY 1, 2) x
                  ORDER BY user_id, c DESC
             )
             SELECT agg.user_id::text AS user_id, agg.calls::text AS calls,
                    agg.last_day::text AS last_day, tt.tool AS top_tool
               FROM agg LEFT JOIN tt USING (user_id)`,
            [userIds, days],
        );
        for (const r of res.rows) {
            const row = out.get(r.user_id);
            if (!row) continue;
            row.desk_calls = Number(r.calls ?? 0);
            row.desk_last_day = dayStr(r.last_day);
            row.desk_top_tool = r.top_tool;
        }
    } catch (err) {
        deskAvailable = false;
        warnThrottled(isMissingTable(err) ? "migration 213 not applied" : "desk usage query failed", err);
    }
    if (!deskAvailable) for (const row of out.values()) row.desk_available = false;

    // ── Connector leg ─────────────────────────────────────────────────────
    const portal = await portalSummary(days);
    if (!portal) {
        for (const row of out.values()) row.connector_available = false;
        return out;
    }
    const sids = await supabaseIdsFor(userIds);
    for (const [userId, sid] of sids) {
        const p = portal[sid];
        const row = out.get(userId);
        if (!p || !row) continue;
        row.connector_calls = Number(p.calls_range ?? 0);
        row.connector_last_day = dayStr(p.last_call_day);
        row.connector_calls_all = Number(p.calls_all ?? 0);
        row.connector_last_day_all = dayStr(p.last_call_day_all);
        row.connector_top_tool = p.top_tool ?? null;
        row.connector_clients = Array.isArray(p.clients) ? p.clients : [];
        row.connector_active_keys = Number(p.active_keys ?? 0);
    }
    return out;
}

// ── per-user detail ───────────────────────────────────────────────────────

export interface AdminUserMcpDetail {
    days: number;
    desk: {
        available: boolean;
        calls: number;
        last_day: string | null;
        by_tool: Array<{ server: string; tool: string; calls: number }>;
        by_day: Array<{ day: string; calls: number }>;
    };
    connector: {
        available: boolean;
        supabase_user_id: string | null;
        calls: number;
        last_day: string | null;
        active_keys: number;
        clients: string[];
        by_tool: Array<{ tool: string; calls: number }>;
        by_day: Array<{ day: string; calls: number }>;
        /** key | supabase | oauth | pat → calls */
        by_scope: Record<string, number>;
    };
}

export async function loadUserMcpDetail(
    userId: string,
    days: number = DEFAULT_DAYS,
): Promise<AdminUserMcpDetail> {
    const detail: AdminUserMcpDetail = {
        days,
        desk: { available: true, calls: 0, last_day: null, by_tool: [], by_day: [] },
        connector: {
            available: portalManageConfigured(),
            supabase_user_id: null,
            calls: 0,
            last_day: null,
            active_keys: 0,
            clients: [],
            by_tool: [],
            by_day: [],
            by_scope: {},
        },
    };

    try {
        const res = await query<{ day: string; server: string; tool: string; calls: string }>(
            `SELECT day::text AS day, server, tool, calls::text AS calls
               FROM public.mcp_tool_calls_daily
              WHERE user_id = $1::uuid
                AND day > (now() AT TIME ZONE 'utc')::date - $2::int
              ORDER BY day`,
            [userId, days],
        );
        const byTool = new Map<string, { server: string; tool: string; calls: number }>();
        const byDay = new Map<string, number>();
        for (const r of res.rows) {
            const n = Number(r.calls ?? 0);
            detail.desk.calls += n;
            const day = dayStr(r.day) ?? "";
            if (!detail.desk.last_day || day > detail.desk.last_day) detail.desk.last_day = day;
            byDay.set(day, (byDay.get(day) ?? 0) + n);
            const k = `${r.server}\u0000${r.tool}`;
            const t = byTool.get(k) ?? { server: r.server, tool: r.tool, calls: 0 };
            t.calls += n;
            byTool.set(k, t);
        }
        detail.desk.by_tool = [...byTool.values()].sort((a, b) => b.calls - a.calls);
        detail.desk.by_day = [...byDay.entries()].map(([day, calls]) => ({ day, calls }));
    } catch (err) {
        detail.desk.available = false;
        warnThrottled(isMissingTable(err) ? "migration 213 not applied" : "desk usage detail failed", err);
    }

    if (!portalManageConfigured()) return detail;
    const sid = (await supabaseIdsFor([userId])).get(userId) ?? null;
    detail.connector.supabase_user_id = sid;
    if (!sid) return detail;
    try {
        const [summary, usage] = await Promise.all([
            portalSummary(days),
            portalManageFetch<{
                usage?: Array<{ day: string; key_id: string; tool: string; scope: string; calls: number }>;
            }>(`/manage/users/${encodeURIComponent(sid)}/usage?days=${days}`, { timeoutMs: 8_000 }),
        ]);
        const p = summary?.[sid];
        if (p) {
            detail.connector.active_keys = Number(p.active_keys ?? 0);
            detail.connector.clients = Array.isArray(p.clients) ? p.clients : [];
        }
        const byTool = new Map<string, number>();
        const byDay = new Map<string, number>();
        for (const r of usage.usage ?? []) {
            const n = Number(r.calls ?? 0);
            detail.connector.calls += n;
            const day = dayStr(r.day) ?? "";
            if (!detail.connector.last_day || day > detail.connector.last_day) {
                detail.connector.last_day = day;
            }
            byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + n);
            byDay.set(day, (byDay.get(day) ?? 0) + n);
            detail.connector.by_scope[r.scope] = (detail.connector.by_scope[r.scope] ?? 0) + n;
        }
        detail.connector.by_tool = [...byTool.entries()]
            .map(([tool, calls]) => ({ tool, calls }))
            .sort((a, b) => b.calls - a.calls);
        detail.connector.by_day = [...byDay.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([day, calls]) => ({ day, calls }));
    } catch (err) {
        detail.connector.available = false;
        warnThrottled("portal user usage fetch failed", err);
    }
    return detail;
}

// ── Desk-wide overview (AdminMax → MCP tab) ───────────────────────────────

export type DeskMcpOverview =
    | {
          available: true;
          days: number;
          totals: { calls: number; users: number; today: number; users_all: number };
          series: Array<{ day: string; calls: number; users: number }>;
          top_tools: Array<{ server: string; tool: string; calls: number }>;
          top_users: Array<{
              user_id: string;
              email: string | null;
              calls: number;
              last_day: string | null;
              top_tool: string | null;
          }>;
      }
    | { available: false; detail: string };

export async function loadDeskMcpOverview(days: number = DEFAULT_DAYS): Promise<DeskMcpOverview> {
    try {
        const [totals, series, tools, users] = await Promise.all([
            query<{ calls: string; users: string; today: string; users_all: string }>(
                `SELECT COALESCE(SUM(calls) FILTER (WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int), 0)::text AS calls,
                        COUNT(DISTINCT user_id) FILTER (WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int)::text AS users,
                        COALESCE(SUM(calls) FILTER (WHERE day = (now() AT TIME ZONE 'utc')::date), 0)::text AS today,
                        COUNT(DISTINCT user_id)::text AS users_all
                   FROM public.mcp_tool_calls_daily`,
                [days],
            ),
            query<{ day: string; calls: string; users: string }>(
                `SELECT day::text AS day, SUM(calls)::text AS calls, COUNT(DISTINCT user_id)::text AS users
                   FROM public.mcp_tool_calls_daily
                  WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int
                  GROUP BY day ORDER BY day`,
                [days],
            ),
            query<{ server: string; tool: string; calls: string }>(
                `SELECT server, tool, SUM(calls)::text AS calls
                   FROM public.mcp_tool_calls_daily
                  WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int
                  GROUP BY server, tool ORDER BY SUM(calls) DESC LIMIT 25`,
                [days],
            ),
            query<{
                user_id: string;
                email: string | null;
                calls: string;
                last_day: string | null;
                top_tool: string | null;
            }>(
                `WITH agg AS (
                     SELECT user_id, SUM(calls) AS calls, MAX(day) AS last_day
                       FROM public.mcp_tool_calls_daily
                      WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int
                      GROUP BY user_id
                 ),
                 tt AS (
                     SELECT DISTINCT ON (user_id) user_id, tool
                       FROM (SELECT user_id, tool, SUM(calls) AS c
                               FROM public.mcp_tool_calls_daily
                              WHERE day > (now() AT TIME ZONE 'utc')::date - $1::int
                              GROUP BY 1, 2) x
                      ORDER BY user_id, c DESC
                 )
                 SELECT agg.user_id::text AS user_id, u.email, agg.calls::text AS calls,
                        agg.last_day::text AS last_day, tt.tool AS top_tool
                   FROM agg
                   LEFT JOIN public.users u ON u.id = agg.user_id
                   LEFT JOIN tt USING (user_id)
                  ORDER BY agg.calls DESC LIMIT 50`,
                [days],
            ),
        ]);
        const t = totals.rows[0];
        return {
            available: true,
            days,
            totals: {
                calls: Number(t?.calls ?? 0),
                users: Number(t?.users ?? 0),
                today: Number(t?.today ?? 0),
                users_all: Number(t?.users_all ?? 0),
            },
            series: series.rows.map((r) => ({
                day: dayStr(r.day) ?? "",
                calls: Number(r.calls ?? 0),
                users: Number(r.users ?? 0),
            })),
            top_tools: tools.rows.map((r) => ({ server: r.server, tool: r.tool, calls: Number(r.calls ?? 0) })),
            top_users: users.rows.map((r) => ({
                user_id: r.user_id,
                email: r.email,
                calls: Number(r.calls ?? 0),
                last_day: dayStr(r.last_day),
                top_tool: r.top_tool,
            })),
        };
    } catch (err) {
        warnThrottled(isMissingTable(err) ? "migration 213 not applied" : "desk overview failed", err);
        return {
            available: false,
            detail: isMissingTable(err)
                ? "mcp_tool_calls_daily ne postoji — primijeni migraciju 213"
                : err instanceof Error
                  ? err.message
                  : String(err),
        };
    }
}
