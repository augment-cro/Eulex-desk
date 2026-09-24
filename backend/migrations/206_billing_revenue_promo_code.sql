-- 206: Promo-code attribution on the revenue ledger.
--
-- Promo codes (Stripe coupons + promotion codes, e.g. HOK2026) are
-- created and managed in Stripe via AdminMax (/adminmax/promos). Stripe
-- only exposes an aggregate times_redeemed per promotion code, so to
-- answer "how many subscriptions / how much revenue came through code
-- X" the webhook now stamps each mirrored PAID subscription invoice
-- with the customer-facing promotion code that discounted it (NULL for
-- undiscounted invoices). Rows inserted before this migration stay NULL
-- — attribution starts at deploy time.
--
-- Safe to run multiple times. Mirrored in backend/src/lib/ensureSchema.ts.

ALTER TABLE public.billing_revenue
    ADD COLUMN IF NOT EXISTS promo_code text;

CREATE INDEX IF NOT EXISTS idx_billing_revenue_promo
    ON public.billing_revenue (promo_code)
    WHERE promo_code IS NOT NULL;
