-- 103: Align remaining Cloud SQL tables with the canonical
--      backend/migrations/000_one_shot_schema.sql shape.
--
-- Goals:
--   * Add columns the application code reads/writes that are missing
--     from the bootstrap schema (100_cloud_sql_bootstrap.sql).
--   * Add missing indexes used by hot read paths.
--   * Add weak constraints (CHECK, FK, UNIQUE) that match the canonical
--     schema, so future inserts cannot drift.
--
-- This migration intentionally does NOT:
--   * Change any existing column types (e.g. chat_messages.content stays text).
--     Converting text → jsonb on populated tables would break under the
--     current dbShim, which doesn't auto-encode strings as JSON literals.
--   * Drop any bootstrap-era columns (e.g. documents.name, document_versions.
--     storage_key, tabular_cells.row_index/col_index). They're unused by the
--     code but harmless and may carry historical rows.
--   * Tighten any NOT NULL constraint that would invalidate existing rows.
--
-- All operations are idempotent. Run as `postgres` (table owner).

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

-- The canonical schema has email + wp_user_id indexes. wp_user_id_key already
-- exists; add the email lookup that auth uses on first-login email match.
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_wp ON public.users(wp_user_id);

-- ---------------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_user_profiles_user
    ON public.user_profiles(user_id);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_projects_user ON public.projects(user_id);
CREATE INDEX IF NOT EXISTS projects_shared_with_idx
    ON public.projects USING gin (shared_with);

-- ---------------------------------------------------------------------------
-- project_subfolders — biggest gap. The bootstrap version lacks user_id,
-- parent_folder_id, and updated_at. The /projects/:id/folders POST and
-- nested-folder code (routes/projects.ts) writes all three.
-- ---------------------------------------------------------------------------

ALTER TABLE public.project_subfolders
    ADD COLUMN IF NOT EXISTS user_id           uuid,
    ADD COLUMN IF NOT EXISTS parent_folder_id  uuid,
    ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'project_subfolders_parent_folder_id_fkey'
          AND conrelid = 'public.project_subfolders'::regclass
    ) THEN
        ALTER TABLE public.project_subfolders
            ADD CONSTRAINT project_subfolders_parent_folder_id_fkey
            FOREIGN KEY (parent_folder_id)
            REFERENCES public.project_subfolders(id)
            ON DELETE CASCADE;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'project_subfolders_user_id_fkey'
          AND conrelid = 'public.project_subfolders'::regclass
    ) THEN
        ALTER TABLE public.project_subfolders
            ADD CONSTRAINT project_subfolders_user_id_fkey
            FOREIGN KEY (user_id)
            REFERENCES public.users(id)
            ON DELETE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_project_subfolders_project
    ON public.project_subfolders(project_id);

CREATE INDEX IF NOT EXISTS idx_project_subfolders_parent
    ON public.project_subfolders(parent_folder_id);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_documents_user_project
    ON public.documents(user_id, project_id);

CREATE INDEX IF NOT EXISTS idx_documents_project_folder
    ON public.documents(project_id, folder_id);

-- ---------------------------------------------------------------------------
-- document_versions — add the canonical source CHECK constraint and the
-- two indexes the code uses for "latest version" lookups.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_versions_source_check'
          AND conrelid = 'public.document_versions'::regclass
    ) THEN
        -- Backfill any NULL/unknown source values to 'upload' so the
        -- constraint validates without a separate cleanup step.
        UPDATE public.document_versions
        SET source = 'upload'
        WHERE source IS NULL
           OR source NOT IN (
                'upload','user_upload','assistant_edit',
                'user_accept','user_reject','generated'
           );

        ALTER TABLE public.document_versions
            ADD CONSTRAINT document_versions_source_check
            CHECK (source = ANY (ARRAY[
                'upload'::text,
                'user_upload'::text,
                'assistant_edit'::text,
                'user_accept'::text,
                'user_reject'::text,
                'generated'::text
            ]));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS document_versions_document_id_idx
    ON public.document_versions(document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS document_versions_doc_vnum_idx
    ON public.document_versions(document_id, version_number);

-- ---------------------------------------------------------------------------
-- chats
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_chats_user ON public.chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_project ON public.chats(project_id);

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat
    ON public.chat_messages(chat_id);

-- ---------------------------------------------------------------------------
-- workflows
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_workflows_user
    ON public.workflows(user_id);

-- ---------------------------------------------------------------------------
-- workflow_shares
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS workflow_shares_workflow_id_idx
    ON public.workflow_shares(workflow_id);

CREATE INDEX IF NOT EXISTS workflow_shares_email_idx
    ON public.workflow_shares(shared_with_email);

-- ---------------------------------------------------------------------------
-- hidden_workflows
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_hidden_workflows_user
    ON public.hidden_workflows(user_id);

-- ---------------------------------------------------------------------------
-- user_mcp_servers
-- ---------------------------------------------------------------------------

-- Slug format constraint matching the canonical schema. Skip backfill —
-- we just guard new inserts; pre-existing rows that happen to violate the
-- pattern would already be unreachable through the slug-based lookup paths.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_mcp_servers_slug_format'
          AND conrelid = 'public.user_mcp_servers'::regclass
    ) THEN
        ALTER TABLE public.user_mcp_servers
            ADD CONSTRAINT user_mcp_servers_slug_format
            CHECK (slug IS NULL OR slug ~ '^[a-z0-9_-]{1,24}$');
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_mcp_servers_user_slug_key'
          AND conrelid = 'public.user_mcp_servers'::regclass
    ) THEN
        -- Only add the unique constraint if no duplicates exist.
        IF NOT EXISTS (
            SELECT 1 FROM public.user_mcp_servers
            WHERE slug IS NOT NULL
            GROUP BY user_id, slug
            HAVING count(*) > 1
        ) THEN
            ALTER TABLE public.user_mcp_servers
                ADD CONSTRAINT user_mcp_servers_user_slug_key
                UNIQUE (user_id, slug);
        END IF;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user
    ON public.user_mcp_servers(user_id, enabled);

-- ---------------------------------------------------------------------------
-- tabular_reviews
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_tabular_reviews_user
    ON public.tabular_reviews(user_id);

CREATE INDEX IF NOT EXISTS idx_tabular_reviews_project
    ON public.tabular_reviews(project_id);

CREATE INDEX IF NOT EXISTS tabular_reviews_shared_with_idx
    ON public.tabular_reviews USING gin (shared_with);

-- ---------------------------------------------------------------------------
-- tabular_cells — application uses (review_id, document_id, column_index).
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_tabular_cells_review
    ON public.tabular_cells(review_id, document_id, column_index);

-- ---------------------------------------------------------------------------
-- tabular_review_chats
-- ---------------------------------------------------------------------------

ALTER TABLE public.tabular_review_chats
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS tabular_review_chats_review_idx
    ON public.tabular_review_chats(review_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS tabular_review_chats_user_idx
    ON public.tabular_review_chats(user_id);

-- ---------------------------------------------------------------------------
-- tabular_review_chat_messages
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS tabular_review_chat_messages_chat_idx
    ON public.tabular_review_chat_messages(chat_id, created_at);

-- ---------------------------------------------------------------------------
-- Re-grant DML to mike_app on tables that gained columns (grants on the
-- table cover all columns automatically, but re-running is harmless and
-- guarantees the runtime role can write to the new columns).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.project_subfolders,
    public.tabular_review_chats
TO mike_app;
