-- 113: Persist the user's chosen reasoning effort on the user profile.
--
-- Mirrors the per-user `tabular_model` and `preferred_language` columns:
-- the picker in the chat composer (Brain icon dropdown) writes here so
-- a user's preference survives reloads, sign-outs, and switching
-- devices — previously this lived only in localStorage and so was per-
-- browser-only.
--
-- Allowed values map 1:1 to provider-native parameters:
--   * Claude 4.x   → output_config.effort
--   * GPT-5 family → reasoning_effort
--   * Gemini 3.x   → thinkingConfig.thinkingLevel  (uppercased server-side)
-- Mistral and LocalLLM ignore it. We default to 'high' to match the
-- value claude.ts hard-coded before this knob was wired up, so existing
-- chats keep their previous depth-of-thought after migration.
--
-- Safe to run multiple times.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS reasoning_effort text NOT NULL DEFAULT 'high';

-- Defensive: drop any old constraint with the same name, then re-add so
-- replays don't accumulate duplicate constraints under a different name.
ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_reasoning_effort_check;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_reasoning_effort_check
  CHECK (reasoning_effort IN ('low', 'medium', 'high'));
