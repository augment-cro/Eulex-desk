-- =============================================================================
-- Migracija 120: PII Shield — anonimizacija + envelope encryption + audit
-- =============================================================================
--
-- Status:    Phase 1 canonical (temeljen na §13 PII_SHIELD_IMPLEMENTATION_PLAN.md)
-- Datum:     2026-05-20
-- Branch:    feature/pii-shield
-- Revert:    120_pii_anonymization_revert.sql
--
-- VAŽNO — odstupanja od §13 plana:
--   - `auth.users` (Supabase konvencija u planu) → `public.users` (lokalna shema).
--   - Migracija je broj 120 jer su 114–119 već zauzete drugim feature-ima
--     (tier_limits, token_credits, billing, country) — plan pretpostavlja 113
--     kao zadnju, ali stvarno stanje glavnog branch-a je drukčije.
--   - Roleovi (`mike-backend@...iam`, `mike-pii-shield@...iam`, `mike-pii-debugger@...iam`)
--     se očekuju pred-stvoreni (Phase 0, gcloud komande). GRANT-ovi su čuvani
--     DO $$ blokom koji provjeri postoji li role — ako ne postoji, samo logira
--     RAISE NOTICE umjesto da padne migracija.
--   - `pg_cron` se uvjetno aktivira: ako nije instaliran u Cloud SQL instance-u,
--     migracija ne pada — preskačemo job-ove i ovisimo o application-level
--     cleanup-u u ensureSchema.ts.
--
-- Sadržaj (redoslijed izvršavanja):
--   1. Extensions (pgcrypto, pg_cron uvjetno)
--   2. user_profiles proširenje
--   3. pii_sessions
--   4. pii_document_analyses
--   5. pii_mappings
--   6. pii_audit_log
--   7. Indeksi
--   8. Row Level Security policies
--   9. GRANT-ovi (zaštićeni DO $$ blokom)
--  10. pg_cron job-ovi (uvjetno)
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_cron je opcionalan; ne padaj migraciju ako nije dostupan
DO $extcron$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_cron;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron extension not available (skipping cron jobs): %', SQLERRM;
    END;
END
$extcron$;

-- ---------------------------------------------------------------------------
-- 2. user_profiles proširenje
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS pii_default_mode text
        NOT NULL DEFAULT 'off'
        CHECK (pii_default_mode IN ('off', 'standard', 'strict_legal', 'strict'));

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS pii_review_required boolean
        NOT NULL DEFAULT true;

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS pii_disclosure_policy jsonb
        NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 3. pii_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pii_sessions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id              uuid REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    mode                 text NOT NULL
                         CHECK (mode IN ('standard', 'strict_legal', 'strict')),
    engine_version       text NOT NULL DEFAULT '1.0.0',
    engine_compat_class  text NOT NULL DEFAULT 'safe'
                         CHECK (engine_compat_class IN ('safe', 'breaking')),
    kek_version          int  NOT NULL DEFAULT 1,
    wrapped_dek          bytea NOT NULL,
    status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'expired', 'deleted')),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    expires_at           timestamptz NOT NULL
);

COMMENT ON TABLE public.pii_sessions IS
    'PII Shield session: chat-scoped (chat_id NOT NULL, 24h TTL) ili standalone pre-warm (chat_id NULL, 30d TTL).';

-- Trigger: default expires_at (standalone = 30 dana, chat-scoped = 24h) + touch updated_at
CREATE OR REPLACE FUNCTION public.pii_sessions_set_expiry()
RETURNS trigger AS $$
BEGIN
    IF NEW.expires_at IS NULL THEN
        IF NEW.chat_id IS NULL THEN
            NEW.expires_at := NEW.created_at + interval '30 days';
        ELSE
            NEW.expires_at := NEW.created_at + interval '24 hours';
        END IF;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pii_sessions_set_expiry ON public.pii_sessions;
CREATE TRIGGER trg_pii_sessions_set_expiry
    BEFORE INSERT OR UPDATE ON public.pii_sessions
    FOR EACH ROW EXECUTE FUNCTION public.pii_sessions_set_expiry();

-- ---------------------------------------------------------------------------
-- 4. pii_document_analyses
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pii_document_analyses (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            uuid NOT NULL REFERENCES public.pii_sessions(id) ON DELETE CASCADE,
    document_version_id   uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE CASCADE,
    status                text NOT NULL DEFAULT 'analyzing'
                          CHECK (status IN (
                              'queued', 'analyzing', 'reanalyzing',
                              'ready_for_review', 'auto_confirmed',
                              'pending', 'confirmed', 'discarded',
                              'failed_open', 'failed_closed'
                          )),
    entity_summary        jsonb,
    processed_text_cache  text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, document_version_id)
);

COMMENT ON TABLE public.pii_document_analyses IS
    'Per-(session,document) PII analysis state machine + masked text cache.';

CREATE OR REPLACE FUNCTION public.pii_document_analyses_touch()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pii_document_analyses_touch ON public.pii_document_analyses;
CREATE TRIGGER trg_pii_document_analyses_touch
    BEFORE UPDATE ON public.pii_document_analyses
    FOR EACH ROW EXECUTE FUNCTION public.pii_document_analyses_touch();

-- ---------------------------------------------------------------------------
-- 5. pii_mappings (SIDECAR-ONLY — RLS blokira backend)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pii_mappings (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id                  uuid NOT NULL REFERENCES public.pii_sessions(id) ON DELETE CASCADE,
    entity_type                 text NOT NULL,
    placeholder                 text NOT NULL,
    original_value_enc          bytea NOT NULL,
    original_value_hmac         bytea NOT NULL,
    source_document_version_id  uuid REFERENCES public.document_versions(id) ON DELETE SET NULL,
    counter                     int  NOT NULL,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, placeholder),
    UNIQUE (session_id, entity_type, counter)
);

COMMENT ON TABLE public.pii_mappings IS
    'Encrypted placeholder -> original PII mapping. Sidecar-only access (RLS enforced).';

-- ---------------------------------------------------------------------------
-- 6. pii_audit_log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pii_audit_log (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at            timestamptz NOT NULL DEFAULT now(),
    user_id               uuid REFERENCES public.users(id) ON DELETE SET NULL,
    document_version_id   uuid REFERENCES public.document_versions(id) ON DELETE SET NULL,
    session_id            uuid REFERENCES public.pii_sessions(id) ON DELETE SET NULL,
    action                text NOT NULL CHECK (action IN (
                              'analyze', 'override', 'disclose', 'render',
                              'full_disclosure', 'tool_deanonymize', 'tool_block',
                              'hallucination', 'user_input_warning', 'merge_document'
                          )),
    entity_types          jsonb,
    placeholder           text,
    reason                text,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    CHECK (action <> 'full_disclosure' OR reason IS NOT NULL)
);

COMMENT ON TABLE public.pii_audit_log IS
    'PII Shield compliance audit trail. 13-mjesečna retencija (GDPR Art. 30).';

-- ---------------------------------------------------------------------------
-- 7. INDEKSI
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_sessions_chat_unique
    ON public.pii_sessions(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pii_sessions_user
    ON public.pii_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pii_sessions_expires
    ON public.pii_sessions(expires_at) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_pii_document_analyses_doc
    ON public.pii_document_analyses(document_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pii_document_analyses_session
    ON public.pii_document_analyses(session_id);

CREATE INDEX IF NOT EXISTS idx_pii_mappings_lookup
    ON public.pii_mappings(session_id, entity_type, original_value_hmac);
CREATE INDEX IF NOT EXISTS idx_pii_mappings_session
    ON public.pii_mappings(session_id);

CREATE INDEX IF NOT EXISTS idx_pii_audit_log_created
    ON public.pii_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pii_audit_log_session
    ON public.pii_audit_log(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pii_audit_log_user
    ON public.pii_audit_log(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pii_audit_log_action
    ON public.pii_audit_log(action, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
ALTER TABLE public.pii_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pii_document_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pii_mappings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pii_audit_log         ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.pii_sessions          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pii_document_analyses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pii_mappings          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pii_audit_log         FORCE ROW LEVEL SECURITY;

-- pii_mappings: sidecar-only
DROP POLICY IF EXISTS p_pii_mappings_sidecar_only ON public.pii_mappings;
CREATE POLICY p_pii_mappings_sidecar_only ON public.pii_mappings
    FOR ALL TO PUBLIC
    USING      (current_user = 'mike-pii-shield@<GCP_PROJECT>.iam')
    WITH CHECK (current_user = 'mike-pii-shield@<GCP_PROJECT>.iam');

-- pii_sessions: backend čita; sidecar piše+čita
DROP POLICY IF EXISTS p_pii_sessions_backend_read ON public.pii_sessions;
CREATE POLICY p_pii_sessions_backend_read ON public.pii_sessions
    FOR SELECT TO PUBLIC
    USING (current_user IN (
        'mike-backend@<GCP_PROJECT>.iam',
        'mike-pii-shield@<GCP_PROJECT>.iam'
    ));

DROP POLICY IF EXISTS p_pii_sessions_sidecar_insert ON public.pii_sessions;
CREATE POLICY p_pii_sessions_sidecar_insert ON public.pii_sessions
    FOR INSERT TO PUBLIC
    WITH CHECK (current_user = 'mike-pii-shield@<GCP_PROJECT>.iam');

DROP POLICY IF EXISTS p_pii_sessions_sidecar_update ON public.pii_sessions;
CREATE POLICY p_pii_sessions_sidecar_update ON public.pii_sessions
    FOR UPDATE TO PUBLIC
    USING      (current_user = 'mike-pii-shield@<GCP_PROJECT>.iam')
    WITH CHECK (current_user = 'mike-pii-shield@<GCP_PROJECT>.iam');

-- pii_document_analyses: backend piše+čita; sidecar samo čita
DROP POLICY IF EXISTS p_pii_analyses_select ON public.pii_document_analyses;
CREATE POLICY p_pii_analyses_select ON public.pii_document_analyses
    FOR SELECT TO PUBLIC
    USING (current_user IN (
        'mike-backend@<GCP_PROJECT>.iam',
        'mike-pii-shield@<GCP_PROJECT>.iam'
    ));

DROP POLICY IF EXISTS p_pii_analyses_backend_insert ON public.pii_document_analyses;
CREATE POLICY p_pii_analyses_backend_insert ON public.pii_document_analyses
    FOR INSERT TO PUBLIC
    WITH CHECK (current_user = 'mike-backend@<GCP_PROJECT>.iam');

DROP POLICY IF EXISTS p_pii_analyses_backend_update ON public.pii_document_analyses;
CREATE POLICY p_pii_analyses_backend_update ON public.pii_document_analyses
    FOR UPDATE TO PUBLIC
    USING      (current_user = 'mike-backend@<GCP_PROJECT>.iam')
    WITH CHECK (current_user = 'mike-backend@<GCP_PROJECT>.iam');

-- pii_audit_log: oba upisuju + čitaju, debugger samo čita
DROP POLICY IF EXISTS p_pii_audit_select ON public.pii_audit_log;
CREATE POLICY p_pii_audit_select ON public.pii_audit_log
    FOR SELECT TO PUBLIC
    USING (current_user IN (
        'mike-backend@<GCP_PROJECT>.iam',
        'mike-pii-shield@<GCP_PROJECT>.iam',
        'mike-pii-debugger@<GCP_PROJECT>.iam'
    ));

DROP POLICY IF EXISTS p_pii_audit_insert ON public.pii_audit_log;
CREATE POLICY p_pii_audit_insert ON public.pii_audit_log
    FOR INSERT TO PUBLIC
    WITH CHECK (current_user IN (
        'mike-backend@<GCP_PROJECT>.iam',
        'mike-pii-shield@<GCP_PROJECT>.iam'
    ));

-- ---------------------------------------------------------------------------
-- 9. GRANT-ovi — zaštićeni DO $$ blokom (preskoči ako role ne postoji)
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE
    backend_role   text := 'mike-backend@<GCP_PROJECT>.iam';
    sidecar_role   text := 'mike-pii-shield@<GCP_PROJECT>.iam';
    debugger_role  text := 'mike-pii-debugger@<GCP_PROJECT>.iam';
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = backend_role) THEN
        EXECUTE format('GRANT SELECT ON public.pii_sessions TO %I', backend_role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.pii_document_analyses TO %I', backend_role);
        EXECUTE format('GRANT SELECT, INSERT ON public.pii_audit_log TO %I', backend_role);
    ELSE
        RAISE NOTICE 'Role % not present — skipping backend grants. Run Phase 0 gcloud IAM bootstrap first.', backend_role;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = sidecar_role) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.pii_mappings TO %I', sidecar_role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.pii_sessions TO %I', sidecar_role);
        EXECUTE format('GRANT SELECT ON public.pii_document_analyses TO %I', sidecar_role);
        EXECUTE format('GRANT SELECT, INSERT ON public.pii_audit_log TO %I', sidecar_role);
    ELSE
        RAISE NOTICE 'Role % not present — skipping sidecar grants. Run Phase 0 gcloud IAM bootstrap first.', sidecar_role;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = debugger_role) THEN
        EXECUTE format('GRANT SELECT ON public.pii_audit_log TO %I', debugger_role);
    ELSE
        RAISE NOTICE 'Role % not present — skipping debugger grants (optional).', debugger_role;
    END IF;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 10. pg_cron JOB-OVI (uvjetno — preskoči ako pg_cron nije instaliran)
-- ---------------------------------------------------------------------------
DO $cronjobs$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed — application-level cleanup u ensureSchema.ts će preuzeti.';
        RETURN;
    END IF;

    -- 13-mjesečna retencija audit loga (GDPR Art. 30)
    PERFORM cron.schedule('pii_audit_log_retention', '0 3 * * *',
        $cron$DELETE FROM public.pii_audit_log
              WHERE created_at < NOW() - INTERVAL '13 months'$cron$);

    -- TTL za pii_document_analyses kad je chat neaktivan > 90 dana
    PERFORM cron.schedule('pii_analyses_ttl_inactive_chats', '0 4 * * *',
        $cron$DELETE FROM public.pii_document_analyses pda
              USING public.pii_sessions ps
              WHERE pda.session_id = ps.id
                AND ps.chat_id IS NOT NULL
                AND EXISTS (
                    SELECT 1 FROM public.chats c
                    WHERE c.id = ps.chat_id
                      AND c.updated_at < NOW() - INTERVAL '90 days')$cron$);

    -- Mark expired sessions every 15min
    PERFORM cron.schedule('pii_sessions_mark_expired', '*/15 * * * *',
        $cron$UPDATE public.pii_sessions SET status = 'expired'
              WHERE status = 'active' AND expires_at < NOW()$cron$);

    -- Hard delete expired sessions after 24h grace
    PERFORM cron.schedule('pii_sessions_hard_delete', '0 2 * * *',
        $cron$DELETE FROM public.pii_sessions
              WHERE status = 'expired'
                AND expires_at < NOW() - INTERVAL '24 hours'$cron$);

    -- Alert na sesije s starim KEK verzijama
    PERFORM cron.schedule('pii_kek_destruction_warning', '0 5 * * *',
        $cron$INSERT INTO public.pii_audit_log (action, metadata)
              SELECT 'override',
                     jsonb_build_object('alert','kek_destruction_warning',
                                        'kek_version',kek_version,
                                        'affected_sessions',count(*))
              FROM public.pii_sessions
              WHERE status = 'active'
                AND kek_version < (SELECT max(kek_version) FROM public.pii_sessions)
              GROUP BY kek_version HAVING count(*) > 0$cron$);
END
$cronjobs$;

COMMIT;

-- =============================================================================
-- Post-migration verifikacija (pokrenuti ručno, ne dio transakcije)
-- =============================================================================
-- SELECT relname, relrowsecurity, relforcerowsecurity
-- FROM pg_class
-- WHERE relname IN ('pii_sessions','pii_document_analyses','pii_mappings','pii_audit_log');
--
-- SELECT jobid, jobname, schedule FROM cron.job WHERE jobname LIKE 'pii_%';
--
-- INSERT INTO public.pii_sessions (user_id, mode, wrapped_dek, chat_id)
-- VALUES ((SELECT id FROM public.users LIMIT 1), 'standard', '\x00'::bytea, NULL);
-- SELECT chat_id, expires_at - created_at AS ttl FROM public.pii_sessions
-- ORDER BY created_at DESC LIMIT 1;
-- =============================================================================
