-- 208: workspace audit trail (issue-tracker #27)
-- Append-only ledger of user-visible workspace activity: chat turns,
-- document uploads/new versions, tabular review creation/runs, exports,
-- sharing changes, edit accept/reject. Complements the operator-side
-- public.admin_audit (migration 133) — this one records what USERS did
-- in their own workspace, written fire-and-forget by lib/audit.ts.
--
-- Deliberately NOT mirrored in ensureSchema.ts: boot-time DDL silently
-- skips statements when another role owns the object (the 07-22 PII
-- shield incident) — this file is the single owner of the table.
--
-- Append-only: application code INSERTs only, no UPDATE/DELETE paths.
-- No foreign keys on purpose — audit rows must survive deletion of the
-- user/project/document/chat they reference, and an insert must never
-- fail on an FK race with a concurrent delete.
--
-- Read access (a future History page) follows the existing
-- shared_with/access model via project_id/user_id — no read API yet.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.audit_events (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The acting user (public.users.id). For runs on shared resources this
    -- is the requester, not the resource owner.
    user_id     uuid        NOT NULL,
    -- Dot-namespaced noun.verb, e.g. 'chat.turn_completed',
    -- 'document.uploaded', 'review.run_started', 'project.sharing_changed'.
    event_type  text        NOT NULL,
    project_id  uuid,
    document_id uuid,
    review_id   uuid,
    chat_id     uuid,
    -- Small, PII-lean JSON snapshot: ids and enums only (model name,
    -- version number, counts, cancelled flag). Never document text,
    -- message content, filenames, or e-mail addresses.
    metadata    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
    ON public.audit_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
    ON public.audit_events (project_id, created_at DESC)
    WHERE project_id IS NOT NULL;
