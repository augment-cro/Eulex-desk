/**
 * /teams — Team-tier roster management (MVP).
 *
 *   GET    /teams/mine                      — caller's team (or { team: null })
 *   POST   /teams/:teamId/members           — add/invite a colleague by email
 *   DELETE /teams/:teamId/members/:memberId — remove a member (frees a seat)
 *
 * The team itself is created by the Stripe webhook when a Team subscription
 * activates — there is no "create team" endpoint here. Management is gated by
 * team role (owner/admin), not per-user entitlement, because the team's mere
 * existence is the Team-tier artifact. Adding a member to a specific predmet
 * still happens via the project `shared_with` path (routes/projects.ts).
 *
 * @module teams
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
    addOrInviteMember,
    canManageTeam,
    getTeamForUser,
    removeMember,
} from "../lib/teams";

export const teamsRouter = Router();

// GET /teams/mine
teamsRouter.get("/mine", requireAuth, async (_req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    try {
        const team = await getTeamForUser(userId);
        res.json({ team });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[teams/mine]", msg);
        res.status(500).json({ detail: msg });
    }
});

// POST /teams/:teamId/members  body: { email }
teamsRouter.post(
    "/:teamId/members",
    requireAuth,
    async (req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const { teamId } = req.params;
        const email =
            typeof req.body?.email === "string" ? req.body.email : "";
        try {
            if (!(await canManageTeam(teamId, userId))) {
                res.status(403).json({
                    detail: "Nemate ovlast za upravljanje ovim timom.",
                    code: "NOT_TEAM_MANAGER",
                });
                return;
            }
            const result = await addOrInviteMember(teamId, email, userId);
            if (!result.ok) {
                const status =
                    result.error === "no_seats"
                        ? 409
                        : result.error === "team_not_found"
                          ? 404
                          : 400;
                res.status(status).json({
                    detail: result.error,
                    code: result.error.toUpperCase(),
                });
                return;
            }
            res.status(201).json({ member: result.member });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[teams/members POST]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// DELETE /teams/:teamId/members/:memberId
teamsRouter.delete(
    "/:teamId/members/:memberId",
    requireAuth,
    async (req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const { teamId, memberId } = req.params;
        try {
            if (!(await canManageTeam(teamId, userId))) {
                res.status(403).json({
                    detail: "Nemate ovlast za upravljanje ovim timom.",
                    code: "NOT_TEAM_MANAGER",
                });
                return;
            }
            const result = await removeMember(teamId, memberId);
            if (!result.ok) {
                const status =
                    result.error === "cannot_remove_owner" ? 403 : 404;
                res.status(status).json({ detail: result.error });
                return;
            }
            res.json({ ok: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[teams/members DELETE]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);
