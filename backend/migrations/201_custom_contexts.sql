-- 201: Custom Contexts — user-defined legal knowledge bases (Plan 1: entity & API).
-- Four core tables. Alerting tables (source_change_events, context_alert_events)
-- and attach-link tables land in later plans. Safe to run multiple times.
-- Mirrored in backend/src/lib/ensureSchema.ts.

CREATE TABLE IF NOT EXISTS public.custom_contexts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  team_id          uuid        REFERENCES public.teams(id) ON DELETE SET NULL,
  name             text        NOT NULL,
  description      text,
  instructions_md  text,
  alerts_enabled   boolean     NOT NULL DEFAULT false,
  visibility       text        NOT NULL DEFAULT 'private'
                               CHECK (visibility IN ('private','shared','team')),
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_contexts_owner
    ON public.custom_contexts (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.context_sources (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id         uuid        NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  kind               text        NOT NULL
                                 CHECK (kind IN ('legal_instrument','legal_article','caselaw','web')),
  ref                text        NOT NULL,
  mode               text        NOT NULL DEFAULT 'retrieved'
                                 CHECK (mode IN ('pinned','retrieved')),
  retrieval_note     text,
  sync_state         text        CHECK (sync_state IN ('linked','staged','ingested')),
  label              text,
  citation           text,
  added_from         text        NOT NULL DEFAULT 'picker'
                                 CHECK (added_from IN ('picker','chat')),
  position           integer     NOT NULL DEFAULT 0,
  tracked_for_alerts boolean     NOT NULL DEFAULT false,
  last_known_version text,
  last_checked_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_context_sources_context
    ON public.context_sources (context_id, position);

CREATE TABLE IF NOT EXISTS public.context_shares (
  context_id        uuid        NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  shared_with_email text        NOT NULL,
  allow_edit        boolean     NOT NULL DEFAULT false,
  shared_by_user_id uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_id, shared_with_email)
);

CREATE TABLE IF NOT EXISTS public.user_context_prefs (
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  context_id uuid        NOT NULL REFERENCES public.custom_contexts(id) ON DELETE CASCADE,
  enabled    boolean     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, context_id)
);
