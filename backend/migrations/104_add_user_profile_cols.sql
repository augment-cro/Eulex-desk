-- 104: Add columns to user_profiles that were present in the canonical
-- Supabase schema (000) but omitted from the Cloud SQL bootstrap (100).
--
-- Missing `tabular_model` causes getUserModelSettings() to receive a pg
-- error, fall back to data=null, resolve all api_keys as null, and then
-- crash in completeText() when the default Gemini model is selected but
-- no Gemini API key is available — producing a 500 on every
-- /chat/:id/generate-title and /tabular-review/prompt request.
--
-- Safe to run multiple times (ADD COLUMN IF NOT EXISTS).

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS tabular_model text NOT NULL DEFAULT 'gemini-3-flash-preview',
  ADD COLUMN IF NOT EXISTS organisation   text;
