-- 129_dedup_users_email.sql
--
-- Fixes AdminMax showing each newly-registered user's email 2–6× (10 duplicate
-- groups / 20 surplus rows on LIVE at authoring time).
--
-- Root cause: handleSupabaseAuth (backend/src/middleware/auth.ts) provisioned
-- users with a check-then-INSERT (SELECT by email, INSERT on miss) while
-- public.users had NO unique constraint on email. Under Postgres' default
-- READ COMMITTED isolation, each statement sees only rows committed before it
-- began, so the SPA's concurrent first-login bootstrap requests (profile,
-- chats, MCP lists…) every one missed the lookup and ran its own INSERT,
-- leaving 2–3+ duplicate rows per new user (same email, distinct UUIDs).
--
-- Pairs with the `INSERT ... ON CONFLICT (lower(email)) DO UPDATE` upsert in
-- handleSupabaseAuth. DEPLOY THAT CODE TOGETHER WITH THIS MIGRATION: the upsert
-- targets the unique index created below, and the old check-then-INSERT would
-- raise unique violations against it.
--
-- Canonical row per email = the one referenced by user_supabase_identity (the
-- row auth resolves returning users to, and the only one that accrues data).
-- Loser rows were verified to own no content (no llm_usage / projects /
-- documents / chats / workflows / tabular_reviews / tier / credits / teams /
-- billing, and no ON DELETE NO ACTION authorship rows); their only children
-- are auto-created user_profiles + user_login_state, both ON DELETE CASCADE.
-- Idempotent: re-running is a no-op once uniqueness is enforced.

BEGIN;

-- 1. Collapse duplicates. DISTINCT ON keeps exactly one canonical per email
--    (oldest identity-backed row). Only groups that HAVE a canonical are
--    touched; an email group with no identity row is left intact for manual
--    review (none exist on LIVE as of this migration).
WITH canon AS (
  SELECT DISTINCT ON (lower(u.email))
         lower(u.email) AS e,
         u.id           AS canonical_id
  FROM public.users u
  WHERE EXISTS (
    SELECT 1 FROM public.user_supabase_identity i WHERE i.user_id = u.id
  )
  ORDER BY lower(u.email), u.created_at
)
DELETE FROM public.users u
USING canon c
WHERE lower(u.email) = c.e
  AND u.id <> c.canonical_id;

-- 2. Enforce case-insensitive uniqueness so concurrent first-logins collapse
--    onto one row. Creation fails — rolling back the whole migration — if any
--    duplicates remain, which is a deliberate safety guard.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq
  ON public.users (lower(email));

COMMIT;
