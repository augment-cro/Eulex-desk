-- 124: Team subsystem (MVP) — seat-bound roster for the Team tier.
--
-- A team is owned by a Team-tier subscriber and has N seats (= the Stripe
-- subscription quantity, min 5). Members are invited by email; on their
-- next login the invite is linked to their user_id (see auth middleware).
--
-- Adding a member to a specific predmet (project) reuses the existing
-- projects.shared_with access path (lib/access.checkProjectAccess) — teams
-- only add the managed, gated roster + seat accounting on top. Mirrors
-- the boot-time DDL in src/lib/ensureSchema.ts.
--
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS public.teams (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   text        NOT NULL DEFAULT 'My Team',
    owner_user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    seats                  integer     NOT NULL DEFAULT 5,
    stripe_subscription_id text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- One team per owner so ensureTeamForOwner can upsert.
CREATE UNIQUE INDEX IF NOT EXISTS teams_owner_uniq
    ON public.teams(owner_user_id);

CREATE TABLE IF NOT EXISTS public.team_members (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     uuid        NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    user_id     uuid        REFERENCES public.users(id) ON DELETE SET NULL,
    email       text        NOT NULL,
    role        text        NOT NULL DEFAULT 'member',   -- owner | admin | member
    status      text        NOT NULL DEFAULT 'invited',  -- invited | active | removed
    invited_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
    invited_at  timestamptz NOT NULL DEFAULT now(),
    joined_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_email_uniq
    ON public.team_members(team_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_team_members_team  ON public.team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_email ON public.team_members(lower(email));
CREATE INDEX IF NOT EXISTS idx_team_members_user  ON public.team_members(user_id);

COMMIT;
