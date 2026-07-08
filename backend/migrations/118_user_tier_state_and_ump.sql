-- Tier override + Stripe customer live in app-owned tables (Cloud Run IAM user
-- can CREATE these even when public.users is owned by postgres).
-- Optional one-time backfill when users.* columns were added via 116/117.

CREATE TABLE IF NOT EXISTS public.user_tier_state (
    user_id     uuid PRIMARY KEY
        REFERENCES public.users(id) ON DELETE CASCADE,
    active_tier_level_id   integer,
    active_tier_until      timestamptz,
    stripe_customer_id     text,
    active_tier_synced_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS user_tier_state_stripe_customer_id_uq
    ON public.user_tier_state (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ump_membership_levels (
    level_id   bigint PRIMARY KEY,
    slug       text,
    label      text,
    synced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ump_user_level_assignments (
    user_id    uuid NOT NULL
        REFERENCES public.users(id) ON DELETE CASCADE,
    wp_user_id bigint NOT NULL,
    level_id   integer NOT NULL,
    expire_at  timestamptz,
    status     text,
    synced_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, level_id)
);

CREATE INDEX IF NOT EXISTS idx_ump_user_level_wp
    ON public.ump_user_level_assignments (wp_user_id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'users'
           AND column_name = 'stripe_customer_id'
    ) THEN
        INSERT INTO public.user_tier_state (
            user_id,
            active_tier_level_id,
            active_tier_until,
            stripe_customer_id,
            active_tier_synced_at
        )
        SELECT u.id,
               u.active_tier_level_id,
               u.active_tier_until,
               u.stripe_customer_id,
               u.active_tier_synced_at
          FROM public.users u
         WHERE u.stripe_customer_id IS NOT NULL
            OR u.active_tier_level_id IS NOT NULL
        ON CONFLICT (user_id) DO UPDATE SET
            active_tier_level_id = COALESCE(
                EXCLUDED.active_tier_level_id,
                public.user_tier_state.active_tier_level_id
            ),
            active_tier_until = COALESCE(
                EXCLUDED.active_tier_until,
                public.user_tier_state.active_tier_until
            ),
            stripe_customer_id = COALESCE(
                EXCLUDED.stripe_customer_id,
                public.user_tier_state.stripe_customer_id
            ),
            active_tier_synced_at = COALESCE(
                EXCLUDED.active_tier_synced_at,
                public.user_tier_state.active_tier_synced_at
            );
    END IF;
END $$;
