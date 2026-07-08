-- 107: Convert chat_messages.content from text → jsonb and align the
--      tabular_review_chat_messages table with the same shape.
--
-- Problem
-- -------
-- The Cloud SQL bootstrap (100) created `chat_messages.content` as
-- `text DEFAULT ''`, but the canonical schema (000_one_shot_schema.sql)
-- declares it as `jsonb`, and the application code (`backend/src/routes/chat.ts`,
-- `projectChat.ts`) stores assistant turns as an *array* of events
-- (`content: events`). The dbShim JSON.stringify's the array on insert,
-- which fits a text column, but on read pg returns a plain string. The
-- frontend's `Array.isArray(content)` check in `getChat()`
-- (frontend/src/app/lib/mikeApi.ts) then always evaluates to `false`, so
-- every assistant message renders with an empty body and no events when
-- the user reopens a past chat — i.e. "message history doesn't work".
--
-- The same fault affects:
--   * `backend/src/lib/chatTools.ts::enrichWithPriorEvents` — last
--     assistant turn never feeds back into the next prompt.
--   * `backend/src/lib/chatTools.ts::buildDocContext` — prior
--     `doc_created` / `doc_edited` events aren't rediscovered, so the
--     model loses access to generated/edited docs after refresh.
--   * `backend/src/routes/chat.ts::hydrateEditStatuses` — edit-status
--     hydration silently skips assistant events.
--
-- Migration 103 deliberately stopped at text columns because the dbShim
-- "doesn't auto-encode strings as JSON literals". The accompanying
-- application change (chat/projectChat/tabular routes pre-stringifying
-- user content) lifts that constraint.
--
-- Idempotent: re-running is a no-op once the columns are jsonb.
--
-- Run as `mike_owner` (or `postgres`) — `mike_app` doesn't have DDL
-- privileges. `backend/scripts/run-migration.mjs` wraps this file in a
-- single transaction so a partial failure rolls back to the prior state.

-- ---------------------------------------------------------------------------
-- Helper: best-effort text → jsonb that round-trips both shapes we've
-- historically stored.
--   * role='assistant' rows hold a JSON.stringify'd events array, so
--     parse them as JSON. If parsing fails for whatever reason (manual
--     row tampering, mid-migration), fall back to wrapping as a JSON
--     string so the migration cannot lose data.
--   * Every other row (user content, default empty strings) is wrapped
--     with to_jsonb() into a jsonb string. NULL and '' both become NULL
--     so the column collapses the two indistinguishable empties down to
--     one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._mike_chat_content_to_jsonb(c text, r text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF c IS NULL OR c = '' THEN
        RETURN NULL;
    END IF;
    IF r = 'assistant' AND c ~ '^\s*[\[\{]' THEN
        BEGIN
            RETURN c::jsonb;
        EXCEPTION WHEN others THEN
            RETURN to_jsonb(c);
        END;
    END IF;
    RETURN to_jsonb(c);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- chat_messages.content text → jsonb
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    current_type text;
BEGIN
    SELECT data_type INTO current_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chat_messages'
      AND column_name = 'content';

    IF current_type = 'text' THEN
        -- Bootstrap created the column with `DEFAULT ''::text`. Postgres
        -- can't cast that default to jsonb, so drop it before the type
        -- change. We don't re-add a default — NULL is the natural empty
        -- value for an event-array column, and the app explicitly passes
        -- NULL when there's nothing to store.
        ALTER TABLE public.chat_messages
            ALTER COLUMN content DROP DEFAULT;

        ALTER TABLE public.chat_messages
            ALTER COLUMN content TYPE jsonb
            USING public._mike_chat_content_to_jsonb(content, role);
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- tabular_review_chat_messages
--   * Same content text → jsonb conversion.
--   * `annotations jsonb` was omitted from the Cloud SQL bootstrap (100)
--     even though the canonical schema (000) defines it and the app
--     writes to it (`backend/src/routes/tabular.ts::insert` after
--     `runLLMStream`). Without this column the assistant message insert
--     fails and tabular-review chat history disappears the same way.
-- ---------------------------------------------------------------------------

ALTER TABLE public.tabular_review_chat_messages
    ADD COLUMN IF NOT EXISTS annotations jsonb;

DO $$
DECLARE
    current_type text;
BEGIN
    SELECT data_type INTO current_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tabular_review_chat_messages'
      AND column_name = 'content';

    IF current_type = 'text' THEN
        ALTER TABLE public.tabular_review_chat_messages
            ALTER COLUMN content DROP DEFAULT;

        ALTER TABLE public.tabular_review_chat_messages
            ALTER COLUMN content TYPE jsonb
            USING public._mike_chat_content_to_jsonb(content, role);
    END IF;
END
$$;

-- Drop the helper — it served its one-shot purpose.
DROP FUNCTION public._mike_chat_content_to_jsonb(text, text);
