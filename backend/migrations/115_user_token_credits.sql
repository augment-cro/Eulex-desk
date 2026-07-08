-- 115: Per-user bonus token credit packs (top-up).
--
-- A user's effective token budget is daily_tokens (rolling 24h, see
-- tier_limits) PLUS the unused remainder of any active credit packs.
-- Rate limiter consumes daily quota first; once exhausted, it dips
-- into credit packs in FIFO order (oldest pack first).
--
-- Three purchase paths land here, all sharing the same row shape:
--
--   * stripe        — self-service Checkout webhook
--                     (granted_by_admin_id IS NULL, stripe_event_id
--                      uniquely identifies the Stripe event for
--                      idempotency).
--   * bank_transfer — admin manually credits the user after seeing
--                     the bank statement; external_reference holds
--                     the bank reference / invoice number.
--   * admin_manual  — discretionary grant (compensation, marketing,
--                     bug payout). external_reference free-form.
--
-- Voiding (refunds, manual reversal) is non-destructive: voided_at
-- gets a timestamp and the row is excluded from the active-balance
-- query — preserves audit trail.
--
-- Pack expiry is OPTIONAL (NULL = never expires). Defaults set by the
-- granting flow; admin can override in AdminMax. Plus subscriptions
-- typically never expire; promotional grants might.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.user_token_credits (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    tokens_granted      bigint      NOT NULL CHECK (tokens_granted > 0),
    tokens_consumed     bigint      NOT NULL DEFAULT 0
                                    CHECK (tokens_consumed >= 0
                                       AND tokens_consumed <= tokens_granted),
    payment_method      text        NOT NULL
                                    CHECK (payment_method IN
                                          ('stripe', 'bank_transfer', 'admin_manual')),
    external_reference  text,
    stripe_event_id     text        UNIQUE,
    amount_eur_cents    integer,
    granted_by_admin_id uuid        REFERENCES public.users(id) ON DELETE SET NULL,
    granted_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz,
    voided_at           timestamptz,
    voided_reason       text,
    notes               text
);

-- FIFO per-user lookup of active (non-voided, non-expired, non-empty)
-- packs. Partial index keeps it small even after years of voided rows.
CREATE INDEX IF NOT EXISTS idx_user_token_credits_active
    ON public.user_token_credits (user_id, granted_at)
    WHERE voided_at IS NULL;

-- Audit lookup: list everything granted by a specific admin.
CREATE INDEX IF NOT EXISTS idx_user_token_credits_granted_by
    ON public.user_token_credits (granted_by_admin_id, granted_at DESC)
    WHERE granted_by_admin_id IS NOT NULL;
