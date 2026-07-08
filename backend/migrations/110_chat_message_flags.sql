-- 110: Per-message "not appropriate answer" flags for the Max assistant.
--
-- Lets a user mark an assistant reply as inappropriate so we can review
-- quality issues and tune prompts/models without losing the original
-- message. The flag itself is a denormalised `is_flagged` boolean on the
-- chat_messages row (cheap to query / render in the UI) plus a one-row-
-- per-flag audit table for traceability.
--
-- Invariants
-- ----------
-- * Only assistant messages get flagged from the UI. The backend does
--   not enforce role at the DB level — the route handler is responsible
--   for that — but the column lives on chat_messages regardless.
-- * `chat_message_flags` keeps history: every flag/unflag toggle inserts
--   a new row with `action`. The denormalised boolean reflects the most
--   recent action and is what the GET /chat handler returns.
-- * `reason` is optional free-text the UI can collect later. Defaults to
--   "not_appropriate" since that's the only built-in surface today.
--
-- Safe to run multiple times.

ALTER TABLE public.chat_messages
    ADD COLUMN IF NOT EXISTS is_flagged    boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS flagged_at    timestamptz,
    ADD COLUMN IF NOT EXISTS flagged_by    uuid;

CREATE TABLE IF NOT EXISTS public.chat_message_flags (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_message_id uuid        NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
    chat_id         uuid        NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    user_id         uuid        NOT NULL,
    action          text        NOT NULL CHECK (action IN ('flag', 'unflag')),
    reason          text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_message_flags_message
    ON public.chat_message_flags (chat_message_id);

CREATE INDEX IF NOT EXISTS idx_chat_message_flags_chat
    ON public.chat_message_flags (chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_flagged
    ON public.chat_messages (chat_id)
    WHERE is_flagged = true;
