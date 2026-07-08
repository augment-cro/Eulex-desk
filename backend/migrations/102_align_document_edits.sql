-- 102: Align document_edits with the canonical schema (000_one_shot_schema.sql).
--
-- The Cloud SQL bootstrap (100) created document_edits with edit_type/content/
-- created_by, but the backend (chatTools.runEditDocument and routes/documents.ts)
-- expects the tracked-changes schema: version_id, change_id, del_w_id, ins_w_id,
-- deleted_text, inserted_text, context_before, context_after, status, resolved_at,
-- chat_message_id.
--
-- Without these columns every edit_document tool call fails with:
--   [dbShim] insert on "document_edits" failed: column "change_id" of
--   relation "document_edits" does not exist
-- and runEditDocument returns "Failed to record edits."
--
-- Safe to run multiple times.

-- 1) Add the missing columns. We don't backfill anything — there are no
--    pre-existing tracked-changes rows to migrate (the old shape only
--    held edit_type='something' bookkeeping that the current code never reads).
ALTER TABLE public.document_edits
  ADD COLUMN IF NOT EXISTS chat_message_id  uuid,
  ADD COLUMN IF NOT EXISTS version_id       uuid,
  ADD COLUMN IF NOT EXISTS change_id        text,
  ADD COLUMN IF NOT EXISTS del_w_id         text,
  ADD COLUMN IF NOT EXISTS ins_w_id         text,
  ADD COLUMN IF NOT EXISTS deleted_text     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS inserted_text    text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS context_before   text,
  ADD COLUMN IF NOT EXISTS context_after    text,
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS resolved_at      timestamptz;

-- 2) Bootstrap-era columns the current code never writes. Make them
--    nullable so future inserts (which omit them) don't fail.
ALTER TABLE public.document_edits
  ALTER COLUMN edit_type DROP NOT NULL;

-- 3) Status check constraint matching the canonical schema.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'document_edits_status_check'
      AND conrelid = 'public.document_edits'::regclass
  ) THEN
    ALTER TABLE public.document_edits
      ADD CONSTRAINT document_edits_status_check
      CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text]));
  END IF;
END
$$;

-- 4) FK to document_versions (the canonical schema makes version_id
--    NOT NULL with ON DELETE CASCADE; we add the FK but keep the column
--    nullable for any pre-existing rows from the old bootstrap shape).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'document_edits_version_id_fkey'
      AND conrelid = 'public.document_edits'::regclass
  ) THEN
    ALTER TABLE public.document_edits
      ADD CONSTRAINT document_edits_version_id_fkey
      FOREIGN KEY (version_id)
      REFERENCES public.document_versions(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- 5) FK to chat_messages (canonical schema sets ON DELETE SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'document_edits_chat_message_id_fkey'
      AND conrelid = 'public.document_edits'::regclass
  ) THEN
    ALTER TABLE public.document_edits
      ADD CONSTRAINT document_edits_chat_message_id_fkey
      FOREIGN KEY (chat_message_id)
      REFERENCES public.chat_messages(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- 6) Indexes used by the resolve-edit and chat-load paths.
CREATE INDEX IF NOT EXISTS document_edits_document_id_idx
  ON public.document_edits(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS document_edits_message_id_idx
  ON public.document_edits(chat_message_id);

CREATE INDEX IF NOT EXISTS document_edits_version_id_idx
  ON public.document_edits(version_id);
