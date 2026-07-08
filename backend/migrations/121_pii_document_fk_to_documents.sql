-- =============================================================================
-- Migracija 121: PII Shield — FK na public.documents umjesto document_versions
-- =============================================================================
--
-- Status:    Hotfix nakon prvog produkcijskog rolloutua (Phase 4)
-- Datum:     2026-05-20
-- Branch:    feature/pii-shield
-- Revert:    121_pii_document_fk_to_documents_revert.sql
--
-- KONTEKST:
--   Backend `readDocumentContent()` u chatTools.ts prosljeđuje
--   `documents.id` (parent), ne `document_versions.id` (revision). Migracija
--   120 je postavila tri FK constraintea na `document_versions(id)` —
--   sidecar `/anonymize` puca s
--     ForeignKeyViolationError: insert or update on table "pii_mappings"
--     violates foreign key constraint
--     "pii_mappings_source_document_version_id_fkey"
--     DETAIL:  Key is not present in table "document_versions".
--
--   Refactoring je manje invazivan na schema strani nego na backend strani
--   (semantika "ovaj mapping pripada ovom dokumentu" ostaje točna i bez
--   verzija; verzije nisu PII-relevantne — sav PII je u tekstu, a tekst se
--   re-ekstrahira na novu verziju kad se promijeni). Pomicanje FK na
--   `documents(id)` ON DELETE CASCADE pokriva use case bez breaking change-a
--   za sidecar API ili tablice koje već imaju mapping rowove.
--
-- Sadržaj:
--   1. pii_document_analyses.document_version_id  → documents(id)  (NOT NULL)
--   2. pii_mappings.source_document_version_id    → documents(id)  (NULL)
--   3. pii_audit_log.document_version_id          → documents(id)  (NULL)
--
-- Kolona se zove dalje `*_document_version_id` zbog backward compat sa
-- sidecar codom — preimenovanje bi tražilo deploy hotfix i sidecar restart.
-- Semantički sad nosi `documents.id`, što je u istom UUID prostoru pa
-- ne lomi postojeće row-ove (tablice su prazne nakon Phase 4 deploya).
-- =============================================================================

BEGIN;

-- ─── pii_document_analyses ──────────────────────────────────────────────────
ALTER TABLE public.pii_document_analyses
    DROP CONSTRAINT IF EXISTS pii_document_analyses_document_version_id_fkey;

ALTER TABLE public.pii_document_analyses
    ADD CONSTRAINT pii_document_analyses_document_version_id_fkey
    FOREIGN KEY (document_version_id) REFERENCES public.documents(id) ON DELETE CASCADE;

-- ─── pii_mappings ───────────────────────────────────────────────────────────
ALTER TABLE public.pii_mappings
    DROP CONSTRAINT IF EXISTS pii_mappings_source_document_version_id_fkey;

ALTER TABLE public.pii_mappings
    ADD CONSTRAINT pii_mappings_source_document_version_id_fkey
    FOREIGN KEY (source_document_version_id) REFERENCES public.documents(id) ON DELETE SET NULL;

-- ─── pii_audit_log ──────────────────────────────────────────────────────────
ALTER TABLE public.pii_audit_log
    DROP CONSTRAINT IF EXISTS pii_audit_log_document_version_id_fkey;

ALTER TABLE public.pii_audit_log
    ADD CONSTRAINT pii_audit_log_document_version_id_fkey
    FOREIGN KEY (document_version_id) REFERENCES public.documents(id) ON DELETE SET NULL;

COMMIT;
