-- Revert 121: vrati FK-ove pii_* tablica na document_versions(id).
-- Run only ako 121 mora biti rollbackan; postojeći mapping rowovi s
-- documents.id koji ne postoje kao document_versions.id će failati ON
-- CONSTRAINT — u tom slučaju očistite tablice prvo:
--   TRUNCATE public.pii_mappings, public.pii_document_analyses,
--            public.pii_audit_log RESTART IDENTITY CASCADE;

BEGIN;

ALTER TABLE public.pii_document_analyses
    DROP CONSTRAINT IF EXISTS pii_document_analyses_document_version_id_fkey;
ALTER TABLE public.pii_document_analyses
    ADD CONSTRAINT pii_document_analyses_document_version_id_fkey
    FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id) ON DELETE CASCADE;

ALTER TABLE public.pii_mappings
    DROP CONSTRAINT IF EXISTS pii_mappings_source_document_version_id_fkey;
ALTER TABLE public.pii_mappings
    ADD CONSTRAINT pii_mappings_source_document_version_id_fkey
    FOREIGN KEY (source_document_version_id) REFERENCES public.document_versions(id) ON DELETE SET NULL;

ALTER TABLE public.pii_audit_log
    DROP CONSTRAINT IF EXISTS pii_audit_log_document_version_id_fkey;
ALTER TABLE public.pii_audit_log
    ADD CONSTRAINT pii_audit_log_document_version_id_fkey
    FOREIGN KEY (document_version_id) REFERENCES public.document_versions(id) ON DELETE SET NULL;

COMMIT;
