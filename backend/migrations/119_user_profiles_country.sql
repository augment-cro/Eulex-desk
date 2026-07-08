-- 119_user_tier_state_country.sql (renumbered from earlier 119_user_profiles_country.sql)
--
-- Add ISO-3166-1 alpha-2 country code to user_tier_state. Required so
-- the Plus checkout can pre-fill Stripe customer.address.country and
-- automatic_tax can resolve a tax location on the very first invoice.
-- Without this column, Stripe rejects sub.create with "the customer's
-- location isn't recognized" and we silently fall back to no-VAT
-- pricing (see backend/src/routes/billing.ts → createSubscriptionWithTaxFallback).
--
-- Why user_tier_state and not user_profiles?
--   public.user_profiles is owned by the postgres role (Cloud SQL
--   superuser) and the IAM DB user our backend runs as cannot ALTER
--   it. user_tier_state is created and owned by that same IAM user
--   (see migration 118), so adding columns there is unrestricted.
--   This is the same split that drove the Stripe-customer-id move
--   off of public.users in 118.
--
-- The column is also the landing spot for UMP profile pulls — when
-- the partner site (eulex.ai / WordPress UMP) returns a country in
-- /eulex-internal/v1/membership-status, applyPulledStatus backfills
-- it here without overwriting any value the user typed in /account
-- (see backend/src/lib/membership.ts).
--
-- Idempotent: the application also asserts this column at startup
-- via ensureSchema (`user_tier_state.country`), so this migration
-- only exists for environments that run SQL migrations directly.

ALTER TABLE public.user_tier_state
    ADD COLUMN IF NOT EXISTS country text;
