-- =============================================================================
-- Jednokratno pokreni kao PostgreSQL superuser (Cloud SQL korisnik `postgres`).
--
-- Zašto: tablica `public.users` u produkciji je vlasništvo `postgres`, dok se
-- Max backend spaja preko IAM uloge `mike-backend@<GCP_PROJECT>.iam`. Ta uloga
-- nema pravo ALTER TABLE na tuđim tablicama, pa `ensureSchema()` u Nodeu
-- tiho odustaje i kolone se nikad ne dodaju — u logovima vidiš:
--   column "active_tier_level_id" of relation "users" does not exist
--
-- Izvrši u Cloud Console → SQL ili:
--   gcloud sql connect <CLOUD_SQL_INSTANCE> --user=postgres --project=<GCP_PROJECT>
-- =============================================================================

BEGIN;

ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS active_tier_level_id   integer,
    ADD COLUMN IF NOT EXISTS active_tier_until      timestamptz,
    ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
    ADD COLUMN IF NOT EXISTS active_tier_synced_at  timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_id_uq
    ON public.users (stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;

COMMIT;

-- Opcionalno (preporuka za buduće migracije): prebaci vlasništvo na IAM ulogu
-- koja je ista kao Cloud SQL korisnik u `DB_IAM_USER` na Cloud Runu:
--   ALTER TABLE public.users OWNER TO "mike-backend@<GCP_PROJECT>.iam";
