-- 109: Email-bound chat share invites + collaborator list on chats.
--
-- A chat owner (or member of the chat's project) can invite outside
-- email addresses to see a snapshot of the conversation and, after
-- signing in with the same email, join the chat as a collaborator.
--
-- Invariants
-- ----------
-- * The opaque share token is NEVER stored in plaintext. We persist
--   `token_hash` = sha256(token) and only the original email recipient
--   sees the token (in the magic link).
-- * `snapshot_at` freezes the "read-only view" cutoff: before accept,
--   the recipient only sees messages with created_at <= snapshot_at.
--   After accept, the row's email lands in chats.shared_with and they
--   see the live thread.
-- * Revoking is soft (revoked_at). Already-accepted invitees keep
--   access through chats.shared_with — revoke that membership by
--   editing the array, not by deleting the share row.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.chat_shares (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id             uuid        NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
    shared_by_user_id   uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    shared_with_email   text        NOT NULL,

    -- sha256 hex (64 chars) of the opaque token shipped in the email.
    token_hash          text        NOT NULL UNIQUE,

    -- Cutoff for the pre-accept snapshot view.
    snapshot_at         timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL DEFAULT (now() + interval '30 days'),

    -- Set when the recipient signs in with a matching email and clicks
    -- "Continue conversation" on the share page.
    accepted_at         timestamptz,
    accepted_user_id    uuid        REFERENCES public.users(id) ON DELETE SET NULL,

    revoked_at          timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_shares_chat
    ON public.chat_shares (chat_id);

CREATE INDEX IF NOT EXISTS idx_chat_shares_email
    ON public.chat_shares (shared_with_email);

-- Re-sharing the same chat to the same email should upsert the live
-- (non-revoked) invite instead of stacking duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS chat_shares_chat_email_active_uniq
    ON public.chat_shares (chat_id, shared_with_email)
    WHERE revoked_at IS NULL;

-- Email-based collaborator list on the chat itself, mirroring the
-- existing projects.shared_with / tabular_reviews.shared_with pattern.
-- After a share invite is accepted, the recipient's email is appended
-- here and the chat.ts access check matches on res.locals.userEmail.
ALTER TABLE public.chats
    ADD COLUMN IF NOT EXISTS shared_with jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS chats_shared_with_idx
    ON public.chats USING gin (shared_with);
