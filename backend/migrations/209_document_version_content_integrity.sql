-- 208: tamper-evident export — content integrity columns on document_versions.
--
-- content_sha256: SHA-256 hex digest of the version's SOURCE file bytes
-- (the DOCX/PDF/TXT at storage_path), recorded at write time so a project
-- export manifest can prove a file matches what the workspace actually held.
-- The pdf_storage_path rendition is a derived artifact and is never hashed.
--
-- size_bytes: byte length of the same source bytes, recorded together with
-- the hash so the two always describe the same content.
--
-- Both nullable on purpose: rows written before this migration stay
-- unhashed until their bytes are next rewritten, so a legacy version reads
-- as "unverifiable" in the manifest and never as falsely verified. Backfill
-- (streaming every stored object out of GCS) is a separate opt-in job.
--
-- ⚠️ Deliberately a PLAIN migration, NOT ensureSchema: the app role does not
-- own document_versions on prod (postgres does), and ensureSchema silently
-- skips DDL it cannot apply (the 07-22 PII-shield incident). Run this as the
-- table owner before deploying code that writes these columns.

alter table public.document_versions
  add column if not exists content_sha256 text;

alter table public.document_versions
  add column if not exists size_bytes bigint;
