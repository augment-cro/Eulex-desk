-- Supabase `tier_limits` — tier DEFINITIONS (daily token quota, feature
-- entitlements, marketing copy) moved out of the AGPL core's mike DB
-- (tracker #15 Phase A: tiers out of the mike DB → Supabase).
--
-- Run once in the Supabase SQL editor (or psql against the Supabase DB).
-- Idempotent — safe to re-run.
--
-- Shape mirrors the mike-DB table exactly (migrations 114 + 122 + 123,
-- kept in sync by backend/src/lib/ensureSchema.ts):
--
--   tier_level_id  bigint PK   — canonical tier id from the JWT / Stripe
--   tier_slug      text        — machine slug ('eulex_free', 'pro', …)
--   display_label  text        — operator-facing label ('Eulex FREE', …)
--   daily_tokens   bigint >= 0 — rolling-24h token quota
--   updated_at     timestamptz — bumped on every AdminMax edit
--   entitlements   jsonb       — runtime overrides; code catalog in
--                                lib/entitlements.ts stays the default layer
--   marketing      jsonb       — bilingual plan copy overrides; code
--                                defaults in lib/planCatalog.ts
--
-- Seed the rows with backend/src/migrations/copy-tier-limits-to-supabase.ts
-- (dry run by default, --execute to write).

CREATE TABLE IF NOT EXISTS public.tier_limits (
    tier_level_id   bigint      PRIMARY KEY,
    tier_slug       text        NOT NULL,
    display_label   text        NOT NULL,
    daily_tokens    bigint      NOT NULL CHECK (daily_tokens >= 0),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    entitlements    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    marketing       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- RLS: enabled with NO policies. The anon / authenticated PostgREST roles
-- can neither read nor write; only the service-role key (the backend's
-- lib/tierLimitsStore.ts via lib/supabaseAdmin.ts) bypasses RLS. Tier
-- definitions are served to clients exclusively through the backend
-- (GET /billing/plans), never read from Supabase directly.
ALTER TABLE public.tier_limits ENABLE ROW LEVEL SECURITY;
