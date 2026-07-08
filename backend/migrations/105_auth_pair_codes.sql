-- 105: Pairing codes for the Word add-in.
--
-- The Word taskpane cannot run a full OAuth PKCE flow (Office blocks the
-- redirect popup), so the web frontend (already authenticated) generates a
-- short-lived 6-digit code and the user types it into the add-in. The
-- add-in exchanges the code for the same JWT the frontend already holds.
--
-- Design notes:
--   - `code` is the primary key; values are 6 digits (000000–999999) but
--     stored as TEXT to preserve leading zeros.
--   - `token` is the eulex.ai-issued JWT verbatim (no re-signing). Lives
--     only as long as the code does — at most a couple of minutes — and is
--     deleted immediately on redeem.
--   - `expires_at` defaults to 5 minutes from insert; backend can override.
--   - Optional `attempts` counter lets the redeem endpoint enforce a max
--     number of wrong tries before invalidating the code (anti-brute-force).
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.auth_pair_codes (
  code        TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  attempts    INT  NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_pair_codes_expires_at_idx
  ON public.auth_pair_codes (expires_at);

CREATE INDEX IF NOT EXISTS auth_pair_codes_user_id_idx
  ON public.auth_pair_codes (user_id);
