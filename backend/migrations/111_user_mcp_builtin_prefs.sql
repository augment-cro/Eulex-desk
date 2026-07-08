-- 111: Per-user enable/disable for built-in (mike/mcp.json) MCP connectors.
--
-- Built-in connectors live server-side in mike/mcp.json (URL + auth headers
-- never leave the disk). They are now visible to every user in the standard
-- connectors UI alongside their own connectors, defaulting to ENABLED.
-- This table records *only the deviation* from that default — typically a
-- user opting out of a particular builtin.
--
-- Design notes
-- ------------
-- * Composite PK (user_id, slug). One row per (user, builtin slug).
-- * `slug` is the post-prefix `sys-<key>` value the loader produces. We
--   intentionally store the full prefixed slug so the lookup matches what
--   loadBuiltinMcpServers() iterates over — no string juggling at read time.
-- * Absent row ⇒ default = enabled (true). The row exists only when the
--   user has explicitly toggled the connector at least once. This keeps
--   the table small (only opt-outs / re-opt-ins persist) and means new
--   builtins added to mcp.json automatically light up for every user.
-- * No FK to mcp.json (it is on disk, not in the DB). If the operator
--   removes a slug from mcp.json the orphaned row is harmless: the
--   loader simply never asks about it.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.user_mcp_builtin_prefs (
    user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    slug        text        NOT NULL,
    enabled     boolean     NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_user_mcp_builtin_prefs_user
    ON public.user_mcp_builtin_prefs (user_id);
