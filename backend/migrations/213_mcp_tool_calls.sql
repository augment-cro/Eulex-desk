-- 213: per-tool daily counters for built-in MCP tool calls made from inside
-- Eulex Desk (chat, project chat, tabular) — the "who uses MCP" signal for
-- AdminMax. Complements 211 (`mcp_tool_usage_daily`, quota counter that only
-- runs for tiers with a cap): this table is written for EVERY built-in MCP
-- call regardless of tier, keyed by (user, UTC day, server slug, tool).
--
-- The external connector side (mcp.eulex.ai via portal keys / OAuth) is
-- tracked by the portal service (`usage_daily`) and joined in AdminMax over
-- the network — nothing from that side lands here.
--
-- Same ownership rule as 208/210/211: this file owns the DDL, NOT
-- ensureSchema.ts. Idempotent. Apply as the owner role before deploying the
-- code that writes to it (writes are fire-and-forget; a missing table only
-- warns, throttled to once a minute).

CREATE TABLE IF NOT EXISTS public.mcp_tool_calls_daily (
    user_id uuid    NOT NULL,
    day     date    NOT NULL,
    server  text    NOT NULL,   -- built-in server slug, e.g. sys-eulex
    tool    text    NOT NULL,   -- raw MCP tool name, e.g. search
    calls   integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, server, tool)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_daily_day
    ON public.mcp_tool_calls_daily (day DESC);

GRANT SELECT, INSERT, UPDATE ON public.mcp_tool_calls_daily TO mike_app;
