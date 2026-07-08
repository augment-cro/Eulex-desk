-- 106: Persist the user's chosen UI language on the user profile so the
-- Word add-in (and any other client that can't read the web frontend's
-- NEXT_LOCALE cookie — Office.js WebViews are sandboxed) can pick up
-- the same locale the user selected in Max on the web.
--
-- Default `hr` matches the frontend's `defaultLocale` in
-- `frontend/src/i18n/request.ts` so existing rows behave identically
-- to the cookie-less default after this migration.
--
-- Safe to run multiple times.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'hr';
