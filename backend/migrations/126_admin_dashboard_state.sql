-- 126: AdminMax dashboard upgrades — new-user tracking, tier audit, login state.
--
-- Three small tables, all CREATE-able by the Cloud Run IAM role (we never
-- ALTER public.users — it is owned by `postgres`, the same constraint that
-- drove user_tier_state / user_supabase_identity into separate tables).
--
--   1. admin_state            — tiny KV store for AdminMax operator state
--                               (e.g. `new_users_last_checked_at` behind the
--                               "new users since last look" corner badge).
--                               AdminMax auth is a shared password, so the
--                               state is global, not per-admin.
--   2. tier_change_history    — append-only audit of every tier transition
--                               (Stripe webhook, UMP pull, admin manual set).
--                               Replaces the UMP "payment history" view we
--                               lose when WordPress is retired.
--   3. user_login_state       — last_login_at / login_count per user.
--                               Updated (throttled) by the auth middleware;
--                               llm_usage only shows users who asked
--                               something, this shows who signed in at all.
--
-- Safe to run multiple times. Mirrored in backend/src/lib/ensureSchema.ts.

CREATE TABLE IF NOT EXISTS public.admin_state (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tier_change_history (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  old_tier_level_id  integer,
  new_tier_level_id  integer,
  old_until          timestamptz,
  new_until          timestamptz,
  source             text        NOT NULL
                                 CHECK (source IN ('stripe', 'ump_sync', 'admin')),
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tier_change_history_user
    ON public.tier_change_history (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tier_change_history_created
    ON public.tier_change_history (created_at DESC);

CREATE TABLE IF NOT EXISTS public.user_login_state (
  user_id       uuid        PRIMARY KEY
      REFERENCES public.users(id) ON DELETE CASCADE,
  last_login_at timestamptz NOT NULL DEFAULT now(),
  login_count   bigint      NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_user_login_state_last_login
    ON public.user_login_state (last_login_at DESC);
