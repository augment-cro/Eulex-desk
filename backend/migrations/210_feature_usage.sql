-- 210: per-feature usage signals (issue-tracker #28 follow-up, v1.5)
-- Two additions so AdminMax / the admin MCP can answer "which features do
-- users actually use, who has ever used X, where do they hit limits":
--
--   1. audit_events.surface — which client surface an event came from
--      (web | word | tabular | draft | workflow | search | title). Nullable;
--      older rows stay NULL.
--   2. user_feature_first_use — one row per (user, feature) the first time a
--      feature is used. Written with INSERT … ON CONFLICT DO NOTHING
--      RETURNING (xmax = 0), the same race-safe first-insert detector as the
--      users upsert in middleware/auth.ts, so 'feature.first_used' audit
--      events fire exactly once per user per feature.
--
-- Same ownership rule as 208: this file owns the DDL, NOT ensureSchema.ts.
-- Idempotent. Apply as the owner role before deploying the code that
-- writes to it (writes are fire-and-forget, so a missing table only warns).

ALTER TABLE public.audit_events ADD COLUMN IF NOT EXISTS surface text;

CREATE INDEX IF NOT EXISTS idx_audit_events_type_created
    ON public.audit_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.user_feature_first_use (
    user_id       uuid        NOT NULL,
    -- Stable feature key: assistant | projects | document | tabular |
    -- workflow | contexts | word | pii | search | team | checkout
    feature       text        NOT NULL,
    surface       text,
    first_used_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_first_use_feature
    ON public.user_feature_first_use (feature, first_used_at DESC);

GRANT SELECT, INSERT ON public.audit_events TO mike_app;
GRANT SELECT, INSERT ON public.user_feature_first_use TO mike_app;
