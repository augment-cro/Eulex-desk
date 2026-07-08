-- 122: Tier entitlements — per-tier feature flags.
--
-- Adds a jsonb `entitlements` column to public.tier_limits (the existing
-- per-tier config table the rate limiter already reads) and seeds the
-- Pro (7) / Team (8) rows alongside the existing Free (3) / Plus (2).
--
-- The *catalog* of valid entitlement keys and the per-tier defaults live
-- in backend code (src/lib/entitlements.ts). The *values* are written
-- from that catalog by `seedEntitlementDefaults()` immediately after
-- `ensureSchema()` at boot — so SQL and code never drift, and an admin's
-- later edits in /adminmax/tiers are never overwritten (the seeder only
-- fills rows whose entitlements column is still '{}').
--
-- Canonical tier_level_id mapping (env-overridable in the app via
-- FREE/PLUS/PRO/TEAM_TIER_LEVEL_ID):
--   free = 3, plus = 2, pro = 7, team = 8
--
-- daily_tokens below are PROVISIONAL — operators tune them in
-- /adminmax/tiers (pricing page promises Plus 10x / Pro 30x of Free).
--
-- Safe to run multiple times.

BEGIN;

ALTER TABLE public.tier_limits
    ADD COLUMN IF NOT EXISTS entitlements jsonb NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO public.tier_limits (tier_level_id, tier_slug, display_label, daily_tokens)
VALUES
    (7, 'pro',  'Eulex Pro',  30000000),
    (8, 'team', 'Eulex Team', 30000000)
ON CONFLICT (tier_level_id) DO NOTHING;

COMMIT;
