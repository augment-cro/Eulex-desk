-- =============================================================================
-- REVERT: Migracija 120 — PII Shield (anonimizacija)
-- =============================================================================
--
-- Forward:   120_pii_anonymization.sql
-- Status:    Manualni revert plan — pokrenuti SAMO ako forward migracija
--            mora biti potpuno povučena (npr. neuspješan deploy, breaking bug).
-- Datum:     2026-05-20
--
-- UPOTREBA:
--   psql --host=... --user=postgres --dbname=mike \
--        -f backend/migrations/120_pii_anonymization_revert.sql
--
-- VAŽNO — gubitak podataka:
--   Ovaj revert UNIŠTAVA sve PII Shield podatke (pii_sessions, pii_mappings,
--   pii_document_analyses, pii_audit_log). Ako se kasnije ponovo pokrene
--   forward migracija, sve sesije i mappingi morat će se regenerirati
--   (pre-warm će se ponovno okinuti za sve dokumente koji se koriste).
--
-- ŠTO REVERT NE DIRA:
--   - KMS keyring / key u GCP-u (`pii-ring` / `pii-dek-wrapping-key`) —
--     mora se ručno obrisati gcloud-om jer je infrastrukturni resurs.
--   - Cloud Run servis `mike-pii-shield` — `gcloud run services delete`.
--   - IAM service accounti — `gcloud iam service-accounts delete`.
--   - Bilo koji checked-in backend/frontend kod koji referencira PII shield —
--     mora se vratiti git checkout-om feature/pii-shield brancha.
--   - Pohranjeni dokumenti i njihov sadržaj — nemaju nikakvu vezu s PII shema.
--
-- REDOSLIJED REVERTA (po obrnutom redu od foreward migracije):
--  1. pg_cron job-ovi (uvjetno)
--  2. RLS policy
--  3. Indeksi
--  4. Tablice (CASCADE — povučeni i triggeri/FK)
--  5. Trigger funkcije
--  6. user_profiles stupci (pii_*)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Otkaži pg_cron job-ove (uvjetno)
-- ---------------------------------------------------------------------------
DO $uncron$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule(jobid)
        FROM cron.job
        WHERE jobname IN (
            'pii_audit_log_retention',
            'pii_analyses_ttl_inactive_chats',
            'pii_sessions_mark_expired',
            'pii_sessions_hard_delete',
            'pii_kek_destruction_warning'
        );
    ELSE
        RAISE NOTICE 'pg_cron not installed — no jobs to unschedule.';
    END IF;
END
$uncron$;

-- ---------------------------------------------------------------------------
-- 2. RLS policy — DROP POLICY (DROP TABLE bi i ovako otkazao policy,
--    ali eksplicitno radimo zbog čitljivosti)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS p_pii_mappings_sidecar_only       ON public.pii_mappings;
DROP POLICY IF EXISTS p_pii_sessions_backend_read       ON public.pii_sessions;
DROP POLICY IF EXISTS p_pii_sessions_sidecar_insert     ON public.pii_sessions;
DROP POLICY IF EXISTS p_pii_sessions_sidecar_update     ON public.pii_sessions;
DROP POLICY IF EXISTS p_pii_analyses_select             ON public.pii_document_analyses;
DROP POLICY IF EXISTS p_pii_analyses_backend_insert     ON public.pii_document_analyses;
DROP POLICY IF EXISTS p_pii_analyses_backend_update     ON public.pii_document_analyses;
DROP POLICY IF EXISTS p_pii_audit_select                ON public.pii_audit_log;
DROP POLICY IF EXISTS p_pii_audit_insert                ON public.pii_audit_log;

-- ---------------------------------------------------------------------------
-- 3. Tablice (CASCADE povlači FK, indekse, triggere)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.pii_audit_log         CASCADE;
DROP TABLE IF EXISTS public.pii_mappings          CASCADE;
DROP TABLE IF EXISTS public.pii_document_analyses CASCADE;
DROP TABLE IF EXISTS public.pii_sessions          CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Trigger funkcije (više nemaju ovisne tablice)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pii_sessions_set_expiry();
DROP FUNCTION IF EXISTS public.pii_document_analyses_touch();

-- ---------------------------------------------------------------------------
-- 5. user_profiles — povlačenje PII stupaca
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS pii_default_mode;
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS pii_review_required;
ALTER TABLE public.user_profiles DROP COLUMN IF EXISTS pii_disclosure_policy;

-- Napomena: pgcrypto extension ostavljamo — koristi je veći broj featurea
-- (gen_random_uuid, sha256, hmac itd.). NIKAD ne radimo DROP EXTENSION pgcrypto
-- jer može srušiti druge tablice. pg_cron ostavljamo iz istog razloga.

COMMIT;

-- =============================================================================
-- Post-revert verifikacija (pokrenuti ručno)
-- =============================================================================
-- SELECT count(*) FROM information_schema.tables
-- WHERE table_schema='public' AND table_name LIKE 'pii_%';
-- -- Očekivano: 0
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='user_profiles'
--   AND column_name LIKE 'pii_%';
-- -- Očekivano: 0 redova
--
-- SELECT jobname FROM cron.job WHERE jobname LIKE 'pii_%';
-- -- Očekivano: 0 redova (ili pg_cron not installed error)
-- =============================================================================
