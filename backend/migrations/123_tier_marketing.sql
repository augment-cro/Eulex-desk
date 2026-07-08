-- 123: Bilingual plan marketing copy per tier.
--
-- Adds a jsonb `marketing` column to public.tier_limits holding the
-- public-facing plan copy (name, tagline, price string, period, intro,
-- feature bullets) per locale, plus display `order` and `popular` flag.
--
-- The code-default catalog lives in backend src/lib/planCatalog.ts and is
-- written into empty rows by seedPlanMarketingDefaults() at boot (so SQL
-- and code never drift, and AdminMax edits are never clobbered). This is
-- the single source the public GET /billing/plans endpoint serves to BOTH
-- Max's PlanCards and the eulex.ai pricing page.
--
-- Shape:
--   { "order": 1, "popular": true,
--     "locales": {
--       "hr": { "name","tagline","price","period","intro","cta","features":[] },
--       "en": { ... } } }
--
-- Idempotent.

ALTER TABLE public.tier_limits
    ADD COLUMN IF NOT EXISTS marketing jsonb NOT NULL DEFAULT '{}'::jsonb;
