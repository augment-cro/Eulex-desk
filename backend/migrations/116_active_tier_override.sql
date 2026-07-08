-- Per-user tier override that the auth middleware reads on every
-- request. Set by the Stripe webhook after a successful Plus
-- subscription so rate-limits flip to Plus instantly, even before
-- the JWT (issued by an external identity provider) refreshes.
--
-- Cleared by the same webhook on cancellation / non-payment.
--
-- Columns:
--   active_tier_level_id   tier_limits.tier_level_id to apply
--                          (NULL → trust JWT)
--   active_tier_until      hard upper bound — middleware ignores
--                          the override after this timestamp so a
--                          missed cancellation can't keep someone on
--                          a paid tier forever
--   stripe_customer_id     Stripe customer linkage (unique)
--   active_tier_synced_at  diagnostics: last time the override was
--                          touched (set or cleared)
--
-- Idempotent.

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS active_tier_level_id    integer,
    ADD COLUMN IF NOT EXISTS active_tier_until       timestamptz,
    ADD COLUMN IF NOT EXISTS stripe_customer_id      text,
    ADD COLUMN IF NOT EXISTS active_tier_synced_at   timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_uq
    ON public.users (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

COMMIT;
