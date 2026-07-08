-- 108: Native file-source connectors (Google Drive, OneDrive, Box).
--
-- Per-user OAuth-backed accounts that the document picker uses to
-- import files into the existing `documents` store. Tokens are stored
-- encrypted using the same scheme as user_profiles.*_api_key columns.
--
-- The `documents` table is extended with `source_*` columns so we can
-- show provenance ("Imported from Google Drive · 2025-11-04") and
-- detect drift on a future re-import (compare source_revision against
-- live etag).
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.integration_accounts (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    -- Provider slug. Constrained to known set; add new providers via a
    -- follow-up migration so we don't accidentally insert typos.
    provider        text        NOT NULL CHECK (provider IN ('google_drive', 'onedrive', 'box')),

    -- Display-only metadata for the "Connected as …" line in settings.
    account_email   text,
    account_name    text,

    -- Encrypted via lib/crypto.encryptApiKey() — same envelope the
    -- existing claude_api_key / gemini_api_key columns use.
    access_token    text        NOT NULL,
    refresh_token   text,
    token_type      text        DEFAULT 'Bearer',
    expires_at      timestamptz,

    -- OAuth scopes actually granted (provider-specific). Stored so we
    -- can detect when a re-auth is needed because we ask for a new
    -- scope without bumping the column schema.
    scopes          text[]      DEFAULT ARRAY[]::text[],

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- One row per (user, provider). A user reconnecting OnePainter B
    -- under the same provider just overwrites the row.
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_accounts_user
    ON public.integration_accounts (user_id);

-- Provenance on imported documents.
ALTER TABLE public.documents
    ADD COLUMN IF NOT EXISTS source_provider     text,
    ADD COLUMN IF NOT EXISTS source_external_id  text,
    ADD COLUMN IF NOT EXISTS source_revision     text,
    ADD COLUMN IF NOT EXISTS source_imported_at  timestamptz;

-- Lookup: "give me all docs imported from Drive file X for this user"
-- (used to suggest 'Refresh from Drive' if the cached snapshot is old).
CREATE INDEX IF NOT EXISTS idx_documents_source_external
    ON public.documents (user_id, source_provider, source_external_id)
    WHERE source_external_id IS NOT NULL;
