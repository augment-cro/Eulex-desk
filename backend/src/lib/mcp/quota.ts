// Per-tier daily quota for built-in MCP tool calls.
//
// The `mcpDailyCalls` int entitlement (0 = unlimited) caps how many built-in
// MCP tool calls a user gets per UTC day. Enforcement lives in the loader's
// callTool closures (lib/mcp/builtin.ts) — the single seam every chat,
// project-chat and tabular MCP call passes through. Counters are day-keyed
// rows in `mcp_tool_usage_daily` (migration 211); the house style is
// Postgres, not Redis.
//
// Failure policy: quota checks fail OPEN. A missing table, a DB hiccup or an
// unresolved tier must never take legal research down — worst case a user
// gets free extra calls, which is the cheap side of the trade.

import { query } from "../db";
import { getEntitlements, intEntitlement } from "../entitlements";

/**
 * Resolve the daily built-in MCP call cap for a tier. 0 = unlimited.
 * Unknown tier (missing tierLevelId) or lookup failure → 0 (fail open).
 */
export async function resolveMcpDailyLimit(
    tierLevelId: number | undefined,
): Promise<number> {
    if (typeof tierLevelId !== "number") return 0;
    try {
        return intEntitlement(await getEntitlements(tierLevelId), "mcpDailyCalls");
    } catch (err) {
        console.warn(
            "[mcp-quota] entitlement lookup failed — not limiting:",
            err instanceof Error ? err.message : err,
        );
        return 0;
    }
}

/**
 * Count one MCP tool call and enforce the cap.
 *
 * Returns `null` when the call is allowed, or a tool-result error string when
 * the user is over their daily cap. The string deliberately follows the
 * `MCP tool '<name>' …` shape McpHttpClient uses for failures, so
 * chatTools.ts classifies it as a failed call and the LLM relays it.
 */
export async function checkAndCountMcpCall(
    userId: string,
    limit: number,
    toolName: string,
): Promise<string | null> {
    if (limit <= 0) return null; // unlimited tier
    let calls: number;
    try {
        const res = await query<{ calls: number }>(
            `INSERT INTO mcp_tool_usage_daily (user_id, day, calls)
             VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
             ON CONFLICT (user_id, day)
             DO UPDATE SET calls = mcp_tool_usage_daily.calls + 1
             RETURNING calls`,
            [userId],
        );
        calls = res.rows[0]?.calls ?? 0;
    } catch (err) {
        console.warn(
            "[mcp-quota] counter write failed — not limiting:",
            err instanceof Error ? err.message : err,
        );
        return null; // fail open
    }
    if (calls > limit) {
        return (
            `MCP tool '${toolName}' unavailable: daily MCP tool-call limit ` +
            `reached (${limit} calls/day on the current plan; resets at ` +
            `00:00 UTC). Upgrading the plan raises or removes this limit.`
        );
    }
    return null;
}
