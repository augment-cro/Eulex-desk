/**
 * Team subsystem (MVP) — seat-bound roster for the Team tier.
 *
 * A team is owned by a Team-tier subscriber (created by the Stripe webhook
 * when a Team subscription activates) and has N seats (= the subscription
 * quantity, min 5). Colleagues are added by email:
 *   • if the email already belongs to a Eulex Desk user → added as `active`;
 *   • otherwise `invited` and linked to their user_id on first login
 *     (linkInvitesForUser, called from the auth middleware).
 *
 * Adding a member to a specific predmet (project) is NOT done here — that
 * reuses the existing `projects.shared_with` path (lib/access). The team is
 * the managed, gated, seat-counted roster you pick those people from.
 *
 * @module teams
 */

import { query } from "./db";

export type TeamRole = "owner" | "admin" | "member";
export type MemberStatus = "invited" | "active" | "removed";

export interface TeamMember {
    id: string;
    email: string;
    role: TeamRole;
    status: MemberStatus;
    userId: string | null;
    displayName: string | null;
    invitedAt: string;
    joinedAt: string | null;
}

export interface TeamContext {
    id: string;
    name: string;
    ownerUserId: string;
    seats: number;
    /** active + invited (non-removed) members. */
    seatsUsed: number;
    /** caller's role in this team. */
    role: TeamRole;
    isOwner: boolean;
    members: TeamMember[];
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Create (or refresh) the team owned by `ownerUserId` and make the owner an
 * active member. Idempotent via the unique index on teams.owner_user_id —
 * called from the Stripe webhook on every Team subscription event so the
 * seat count tracks the subscription quantity.
 */
export async function ensureTeamForOwner(
    ownerUserId: string,
    seats: number,
    stripeSubscriptionId?: string | null,
): Promise<string> {
    const s = Math.max(5, Math.floor(Number(seats)) || 5);
    const res = await query<{ id: string }>(
        `INSERT INTO public.teams (owner_user_id, seats, stripe_subscription_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_user_id) DO UPDATE SET
            seats = EXCLUDED.seats,
            stripe_subscription_id = COALESCE(
                EXCLUDED.stripe_subscription_id,
                public.teams.stripe_subscription_id
            ),
            updated_at = now()
         RETURNING id`,
        [ownerUserId, s, stripeSubscriptionId ?? null],
    );
    const teamId = res.rows[0].id;
    const ownerRow = await query<{ email: string | null }>(
        `SELECT email FROM public.users WHERE id = $1`,
        [ownerUserId],
    );
    const ownerEmail = ownerRow.rows[0]?.email ?? null;
    if (ownerEmail) {
        await query(
            `INSERT INTO public.team_members
                (team_id, user_id, email, role, status, joined_at)
             VALUES ($1, $2, $3, 'owner', 'active', now())
             ON CONFLICT (team_id, lower(email)) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                role    = 'owner',
                status  = 'active',
                joined_at = COALESCE(public.team_members.joined_at, now())`,
            [teamId, ownerUserId, ownerEmail],
        );
    }
    return teamId;
}

/** Members of a team (excludes removed), owner first. */
export async function listMembers(teamId: string): Promise<TeamMember[]> {
    const res = await query<{
        id: string;
        email: string;
        role: string;
        status: string;
        user_id: string | null;
        display_name: string | null;
        invited_at: string;
        joined_at: string | null;
    }>(
        `SELECT m.id, m.email, m.role, m.status, m.user_id,
                u.display_name, m.invited_at, m.joined_at
           FROM public.team_members m
           LEFT JOIN public.users u ON u.id = m.user_id
          WHERE m.team_id = $1 AND m.status <> 'removed'
          ORDER BY (m.role = 'owner') DESC, m.invited_at ASC`,
        [teamId],
    );
    return res.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role as TeamRole,
        status: r.status as MemberStatus,
        userId: r.user_id,
        displayName: r.display_name,
        invitedAt: r.invited_at,
        joinedAt: r.joined_at,
    }));
}

/**
 * The team the user belongs to (as owner or active member), with members
 * and seat usage. Returns null if the user isn't on any team.
 */
export async function getTeamForUser(
    userId: string,
): Promise<TeamContext | null> {
    const teamRes = await query<{
        id: string;
        name: string;
        owner_user_id: string;
        seats: string | number;
    }>(
        `SELECT t.id, t.name, t.owner_user_id, t.seats
           FROM public.teams t
           LEFT JOIN public.team_members m
                  ON m.team_id = t.id
                 AND m.user_id = $1
                 AND m.status = 'active'
          WHERE t.owner_user_id = $1 OR m.id IS NOT NULL
          ORDER BY (t.owner_user_id = $1) DESC
          LIMIT 1`,
        [userId],
    );
    if (teamRes.rows.length === 0) return null;
    const t = teamRes.rows[0];
    const members = await listMembers(t.id);
    const isOwner = t.owner_user_id === userId;
    const role: TeamRole = isOwner
        ? "owner"
        : (members.find((m) => m.userId === userId)?.role ?? "member");
    return {
        id: t.id,
        name: t.name,
        ownerUserId: t.owner_user_id,
        seats: Number(t.seats),
        seatsUsed: members.length,
        role,
        isOwner,
        members,
    };
}

/** Caller is the team owner or an admin (allowed to manage members). */
export async function canManageTeam(
    teamId: string,
    userId: string,
): Promise<boolean> {
    const res = await query<{ role: string }>(
        `SELECT role FROM public.team_members
          WHERE team_id = $1 AND user_id = $2 AND status = 'active'`,
        [teamId, userId],
    );
    const role = res.rows[0]?.role;
    return role === "owner" || role === "admin";
}

export type AddMemberResult =
    | { ok: true; member: TeamMember }
    | { ok: false; error: "invalid_email" | "no_seats" | "team_not_found" };

/**
 * Add a colleague to the team by email. Existing Eulex Desk users join as `active`
 * immediately; unknown emails are `invited` and linked on first login.
 * Enforces the seat cap (active + invited).
 */
export async function addOrInviteMember(
    teamId: string,
    rawEmail: string,
    invitedBy: string,
): Promise<AddMemberResult> {
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };

    const team = await query<{ seats: string | number }>(
        `SELECT seats FROM public.teams WHERE id = $1`,
        [teamId],
    );
    if (team.rows.length === 0) return { ok: false, error: "team_not_found" };

    // Already on the team (re-invite) is fine; otherwise enforce seats.
    const existing = await query<{ id: string }>(
        `SELECT id FROM public.team_members
          WHERE team_id = $1 AND lower(email) = $2 AND status <> 'removed'`,
        [teamId, email],
    );
    if (existing.rows.length === 0) {
        const used = await query<{ c: string }>(
            `SELECT COUNT(*)::text AS c FROM public.team_members
              WHERE team_id = $1 AND status <> 'removed'`,
            [teamId],
        );
        if (Number(used.rows[0].c) >= Number(team.rows[0].seats)) {
            return { ok: false, error: "no_seats" };
        }
    }

    const u = await query<{ id: string }>(
        `SELECT id FROM public.users WHERE lower(email) = $1 LIMIT 1`,
        [email],
    );
    const existingUserId = u.rows[0]?.id ?? null;
    const status: MemberStatus = existingUserId ? "active" : "invited";

    const res = await query<{
        id: string;
        email: string;
        role: string;
        status: string;
        user_id: string | null;
        invited_at: string;
        joined_at: string | null;
    }>(
        `INSERT INTO public.team_members
            (team_id, user_id, email, role, status, invited_by, joined_at)
         VALUES ($1, $2, $3, 'member', $4, $5, $6)
         ON CONFLICT (team_id, lower(email)) DO UPDATE SET
            user_id = COALESCE(EXCLUDED.user_id, public.team_members.user_id),
            status  = CASE WHEN public.team_members.status = 'removed'
                           THEN EXCLUDED.status ELSE public.team_members.status END,
            invited_by = EXCLUDED.invited_by
         RETURNING id, email, role, status, user_id, invited_at, joined_at`,
        [
            teamId,
            existingUserId,
            email,
            status,
            invitedBy,
            existingUserId ? new Date() : null,
        ],
    );
    const r = res.rows[0];
    let displayName: string | null = null;
    if (r.user_id) {
        const dn = await query<{ display_name: string | null }>(
            `SELECT display_name FROM public.users WHERE id = $1`,
            [r.user_id],
        );
        displayName = dn.rows[0]?.display_name ?? null;
    }
    return {
        ok: true,
        member: {
            id: r.id,
            email: r.email,
            role: r.role as TeamRole,
            status: r.status as MemberStatus,
            userId: r.user_id,
            displayName,
            invitedAt: r.invited_at,
            joinedAt: r.joined_at,
        },
    };
}

/** Remove a member (frees the seat). The owner can't be removed. */
export async function removeMember(
    teamId: string,
    memberId: string,
): Promise<{ ok: boolean; error?: "not_found" | "cannot_remove_owner" }> {
    const m = await query<{ role: string }>(
        `SELECT role FROM public.team_members WHERE id = $1 AND team_id = $2`,
        [memberId, teamId],
    );
    if (m.rows.length === 0) return { ok: false, error: "not_found" };
    if (m.rows[0].role === "owner")
        return { ok: false, error: "cannot_remove_owner" };
    await query(
        `DELETE FROM public.team_members WHERE id = $1 AND team_id = $2`,
        [memberId, teamId],
    );
    return { ok: true };
}

/**
 * Link any pending email invites to a user on first login. Called from the
 * auth middleware right after a brand-new user is created, so an invitee who
 * signs up after being invited becomes an active team member automatically.
 * Never throws — invites are best-effort.
 */
export async function linkInvitesForUser(
    userId: string,
    email: string | null | undefined,
): Promise<void> {
    if (!email) return;
    try {
        await query(
            `UPDATE public.team_members
                SET user_id = $1,
                    status = 'active',
                    joined_at = COALESCE(joined_at, now())
              WHERE user_id IS NULL
                AND status <> 'removed'
                AND lower(email) = lower($2)`,
            [userId, email],
        );
    } catch (err) {
        console.warn(
            "[teams] linkInvitesForUser failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
}
