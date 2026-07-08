-- 125: Supabase Auth identity mapping.
--
-- We are (re)introducing Supabase as the Auth provider — identity only;
-- all business data stays in Cloud SQL. A Supabase access token carries
-- `sub` = Supabase auth.users UUID, which is NOT the same as our
-- public.users.id. We map the two here.
--
-- This lives in a SEPARATE table (not a column on public.users) because
-- public.users is owned by the `postgres` role and the Cloud Run IAM DB
-- user cannot ALTER it — the exact constraint that drove the
-- user_tier_state split (migration 118). A fresh table the IAM role can
-- CREATE sidesteps that, and also models multi-provider identity cleanly
-- (a user may have both a legacy WP login and a Supabase login during the
-- parallel-login transition).
--
-- Lookup order in the auth middleware:
--   1. by supabase_user_id (this table)            — returning user
--   2. by email on public.users (link + backfill)  — WP-migrated / existing
--   3. INSERT a new public.users row               — brand new user
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.user_supabase_identity (
  supabase_user_id uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- One Supabase identity per local user (a user logs in via exactly one
-- Supabase account). The PK already enforces one user_id per supabase id.
CREATE UNIQUE INDEX IF NOT EXISTS user_supabase_identity_user_id_uq
  ON public.user_supabase_identity (user_id);

CREATE INDEX IF NOT EXISTS user_supabase_identity_email_idx
  ON public.user_supabase_identity (email);
