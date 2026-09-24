-- 211: daily counters for built-in MCP tool calls (per-tier MCP rate limits).
-- Pairs with the `mcpDailyCalls` int entitlement (0 = unlimited): every
-- built-in MCP tool call increments (user_id, UTC day); the loader rejects
-- calls past the tier's cap. Old rows are harmless (day-keyed, tiny) and can
-- be pruned opportunistically later.
--
-- Same ownership rule as 208/210: this file owns the DDL, NOT ensureSchema.ts.
-- Idempotent. Apply as the owner role before deploying the code that writes
-- to it (writes fail open, so a missing table only warns).

CREATE TABLE IF NOT EXISTS public.mcp_tool_usage_daily (
    user_id uuid    NOT NULL,
    day     date    NOT NULL,
    calls   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

GRANT SELECT, INSERT, UPDATE ON public.mcp_tool_usage_daily TO mike_app;
