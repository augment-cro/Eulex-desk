-- 132: chat history management (ISSUE-TRACKER #13)
-- Per-user sidebar groups + pin flag + active/archived/deleted status on
-- chats. Additive only; soft delete replaces hard DELETE in routes/chat.ts.

CREATE TABLE IF NOT EXISTS public.chat_groups (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     text        NOT NULL,
    name        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_groups_user ON public.chat_groups (user_id);

ALTER TABLE public.chats
    ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.chat_groups(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted'));

CREATE INDEX IF NOT EXISTS idx_chats_user_status ON public.chats (user_id, status);
