-- 127: Subscription revenue ledger.
--
-- Token-pack purchases already land in user_token_credits (with
-- amount_eur_cents), but subscription payments only existed inside
-- Stripe — AdminMax analytics therefore undercounted income. The Stripe
-- webhook (invoice.paid / invoice.payment_succeeded) now mirrors every
-- PAID subscription invoice here; analytics and the weekly summary sum
-- this table UNION the token-pack grants.
--
-- Idempotency: UNIQUE (stripe_invoice_id) — Stripe sends several events
-- per invoice and retries on non-2xx; only the first insert lands.
-- user_id is nullable (SET NULL on user delete; or customer we could
-- not resolve) so revenue history survives account deletion.
--
-- Safe to run multiple times. Mirrored in backend/src/lib/ensureSchema.ts.

CREATE TABLE IF NOT EXISTS public.billing_revenue (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  stripe_customer_id      text,
  stripe_invoice_id       text        UNIQUE,
  stripe_subscription_id  text,
  plan                    text,
  amount_cents            integer     NOT NULL CHECK (amount_cents > 0),
  currency                text        NOT NULL DEFAULT 'eur',
  paid_at                 timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_revenue_paid
    ON public.billing_revenue (paid_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_revenue_user
    ON public.billing_revenue (user_id, paid_at DESC)
    WHERE user_id IS NOT NULL;
