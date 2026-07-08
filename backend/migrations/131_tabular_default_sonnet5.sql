-- 131_tabular_default_sonnet5.sql
--
-- Make Claude Sonnet 5 the tabular-review (Analiza) model for everyone.
--
-- Why: Analiza columns are open-ended legal questions (governing law,
-- deadlines, clause interpretation), not simple field extraction — Sonnet 5
-- is near-Opus on that class of work while Gemini 3 Flash was chosen purely
-- for cost. Product decision 2026-07-01: accuracy is the selling point, so
-- Sonnet 5 becomes the default AND existing default-holders are moved over.
--
-- Two parts:
--   1. Column default: new profiles get claude-sonnet-5. Must stay in sync
--      with DEFAULT_TABULAR_MODEL in backend/src/lib/llm/models.ts.
--   2. Backfill: rows still holding the old default gemini-3-flash-preview
--      are flipped. We cannot distinguish "deliberately picked Gemini" from
--      "never touched the setting" (the column default was written at
--      profile creation), so per the product decision all of them move.
--      Users who explicitly picked GPT/Mistral/LocalLLM are untouched.
--      (claude-sonnet-4-6 rows resolve forward via MODEL_ALIASES and the
--      GET /user/profile normalisation; no backfill needed for those.)
--
-- Requires table-owner privileges for the ALTER (user_profiles is owned by
-- the built-in postgres role) — apply via break-glass, not the app role.

ALTER TABLE public.user_profiles
  ALTER COLUMN tabular_model SET DEFAULT 'claude-sonnet-5';

UPDATE public.user_profiles
   SET tabular_model = 'claude-sonnet-5'
 WHERE tabular_model = 'gemini-3-flash-preview';

-- localllm-main cannot run in prod (no VLLM_BASE_URL) — the one row still
-- holding it was a guaranteed-broken Analiza, so it moves too.
UPDATE public.user_profiles
   SET tabular_model = 'claude-sonnet-5'
 WHERE tabular_model = 'localllm-main';

-- Product follow-up: opus-4-7 rows were initially left in place (alias ->
-- opus-4-8, a stronger model), but the call is Sonnet 5 for literally
-- everyone — tabular is the mid tier and Opus pricing doesn't fit it.
UPDATE public.user_profiles
   SET tabular_model = 'claude-sonnet-5'
 WHERE tabular_model = 'claude-opus-4-7';

-- Applied to LIVE mike-db 2026-07-02 via break-glass (postgres role,
-- password rotated afterwards): 418 gemini + 1 localllm + 4 opus-4-7 rows
-- flipped. Final state: 425x claude-sonnet-5, 13x claude-sonnet-4-6 (left
-- in place — MODEL_ALIASES resolves them to sonnet-5).
