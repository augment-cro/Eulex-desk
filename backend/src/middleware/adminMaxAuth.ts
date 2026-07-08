/**
 * AdminMax — separate admin portal auth (off the main user JWT track).
 *
 * The /adminmax surface is intentionally NOT tied to the eulex.ai user
 * accounts: it is reachable by an external admin (e.g. ops/finance) who
 * does not have a WordPress profile. To keep blast radius small, this
 * middleware:
 *
 *   - validates a short-lived HS256 admin JWT (sub="adminmax",
 *     aud="adminmax")
 *   - signed with ADMIN_MAX_JWT_SECRET (Cloud Secret Manager)
 *   - separate from EULEX_MCP_JWT_SECRET so a leak in one cannot mint
 *     tokens for the other
 *
 * Tokens are minted only by POST /adminmax/login after a password check
 * against ADMIN_MAX_PASSWORD (env). 8h TTL.
 */
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export const ADMIN_MAX_AUDIENCE = "adminmax";
export const ADMIN_MAX_SUBJECT = "adminmax";
export const ADMIN_MAX_TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function getAdminMaxJwtSecret(): string {
    const secret = process.env.ADMIN_MAX_JWT_SECRET;
    if (!secret) {
        throw new Error("ADMIN_MAX_JWT_SECRET is not configured");
    }
    return secret;
}

export function signAdminMaxToken(): { token: string; expiresAt: number } {
    const secret = getAdminMaxJwtSecret();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ADMIN_MAX_TOKEN_TTL_SECONDS;
    const token = jwt.sign(
        {
            sub: ADMIN_MAX_SUBJECT,
            iat: now,
            exp,
        },
        secret,
        { algorithm: "HS256", audience: ADMIN_MAX_AUDIENCE },
    );
    return { token, expiresAt: exp * 1000 };
}

/**
 * Express middleware: requires `Authorization: Bearer <admin token>` on
 * every /adminmax/* request except the login endpoint itself. Failure
 * mode is a flat 401 — the frontend `/adminmax/login` page handles it.
 */
export function requireAdminMaxAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
        res.status(401).json({ detail: "Missing admin token" });
        return;
    }

    let secret: string;
    try {
        secret = getAdminMaxJwtSecret();
    } catch {
        console.error("[adminMaxAuth] ADMIN_MAX_JWT_SECRET not configured");
        res.status(500).json({ detail: "Admin auth not configured" });
        return;
    }

    try {
        const token = auth.slice(7).trim();
        jwt.verify(token, secret, {
            algorithms: ["HS256"],
            audience: ADMIN_MAX_AUDIENCE,
            subject: ADMIN_MAX_SUBJECT,
        });
        next();
    } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
            res.status(401).json({ detail: "Admin token expired", code: "TOKEN_EXPIRED" });
            return;
        }
        res.status(401).json({ detail: "Invalid admin token" });
    }
}
