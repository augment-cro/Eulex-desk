/**
 * Frontend-facing service-token endpoint (design §4.2, settled ex-§12.4:
 * the frontend talks to a configured external service DIRECTLY, carrying
 * a core-minted identity token — mirroring how MCP OAuth connectors
 * already talk outward).
 *
 * GET /service-token/:service returns the same short-TTL HS256 token the
 * core sends on outbound seam calls (contracts/service-identity.md).
 * Responds 404 for unknown service names and for services whose secret
 * is not configured — with no seam envs set the route is mounted but
 * inert (standalone-core rule §2). No network calls are made here;
 * minting is purely local.
 */
import { Router } from "express";
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth";
import {
    mintServiceToken,
    type SeamService,
} from "../lib/seams/serviceIdentity";
import { getTeamForUser } from "../lib/teams";

const SERVICES: ReadonlySet<string> = new Set(["contexts", "governance", "audit"]);

type TenantResolver = (userId: string) => Promise<string | null>;

const defaultTenantResolver: TenantResolver = async (userId) =>
    (await getTeamForUser(userId))?.id ?? null;

export function createServiceTokenRouter(
    auth: RequestHandler = requireAuth,
    tenantFor: TenantResolver = defaultTenantResolver,
): Router {
    const router = Router();

    router.get("/:service", auth, async (req, res) => {
        const service = req.params.service;
        if (!SERVICES.has(service)) {
            res.status(404).json({ error: "unknown service" });
            return;
        }

        const userId = res.locals.userId as string;
        const userEmail = (res.locals.userEmail as string | undefined) ?? null;
        let tenant: string | null = null;
        try {
            tenant = await tenantFor(userId);
        } catch (err) {
            // Fail-soft: a tenant lookup hiccup must not block the token —
            // the service simply sees a personal-account identity.
            console.error("[serviceToken] tenant lookup failed", err);
        }

        const token = mintServiceToken(
            service as SeamService,
            userId,
            tenant,
            userEmail,
        );
        if (!token) {
            res.status(404).json({ error: "service not configured" });
            return;
        }

        const payload = jwt.decode(token) as jwt.JwtPayload | null;
        const expiresIn = payload?.exp
            ? payload.exp - Math.floor(Date.now() / 1000)
            : null;
        res.json({ token, expires_in: expiresIn });
    });

    return router;
}

export default createServiceTokenRouter();
