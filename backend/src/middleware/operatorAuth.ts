/**
 * Operator API caller auth — service identity, no shared password.
 *
 * /operator/v1/* is the generic administration API of this deployment
 * (users, tiers, credits, usage, audit). An operator console — any program
 * that speaks contracts/operator.openapi.json — calls it server-to-server.
 *
 * Accepted `Authorization: Bearer …` values:
 *   1. a Google-signed OIDC identity token whose `email` (verified) is listed
 *      in OPERATOR_API_CALLERS (service accounts separated by `,`, `;` or
 *      whitespace — `;` survives gcloud's comma-split flags) and whose
 *      audience is OPERATOR_API_AUDIENCE (same separators) or, when that is
 *      unset, this host's origin (with or without the /operator/v1 path);
 *   2. outside production only: the static OPERATOR_API_DEV_TOKEN.
 *
 * OPERATOR_API_CALLERS unset → the whole surface answers 404: a deployment
 * without an operator console simply has no operator API (standalone core).
 *
 * The caller may name the human/tool behind a request in `X-Operator-Actor`;
 * it lands in admin_audit.actor as "<actor>" (or the service account when
 * absent). Trusted only because the caller itself is authenticated.
 */
import { timingSafeEqual } from "node:crypto";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import type { Request, Response, NextFunction } from "express";

const ACTOR_RE = /^[\w.@:+-]{1,100}$/;

export function operatorCallers(env: NodeJS.ProcessEnv = process.env): string[] {
    return (env.OPERATOR_API_CALLERS ?? "")
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

export function operatorApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return operatorCallers(env).length > 0;
}

export function callerAllowed(
    payload: TokenPayload | undefined,
    allowed: string[],
): boolean {
    if (!payload?.email || payload.email_verified !== true) return false;
    return allowed.includes(payload.email.toLowerCase());
}

/** Audiences a caller may have used for this request. */
export function expectedAudiences(
    req: Request,
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const pinned = (env.OPERATOR_API_AUDIENCE ?? "")
        .split(/[\s,;]+/)
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean);
    if (pinned.length) return pinned;
    const base = `https://${req.headers.host ?? ""}`;
    return [base, `${base}/operator/v1`];
}

function constantTimeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    const len = Math.max(ab.length, bb.length);
    const pa = Buffer.alloc(len);
    const pb = Buffer.alloc(len);
    ab.copy(pa);
    bb.copy(pb);
    return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

/** Audit actor for this request: the declared actor, else the caller. */
function actorFor(req: Request, caller: string): string {
    const declared = req.headers["x-operator-actor"];
    if (typeof declared === "string" && ACTOR_RE.test(declared.trim())) {
        return declared.trim();
    }
    return caller;
}

export type VerifyIdToken = (
    idToken: string,
    audience: string[],
) => Promise<TokenPayload | undefined>;

const oidc = new OAuth2Client();
const verifyWithGoogle: VerifyIdToken = async (idToken, audience) =>
    (await oidc.verifyIdToken({ idToken, audience })).getPayload();

export function makeRequireOperatorCaller(
    deps: { verify?: VerifyIdToken; env?: NodeJS.ProcessEnv } = {},
) {
    const verify = deps.verify ?? verifyWithGoogle;
    return async function requireOperatorCaller(
        req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> {
        const env = deps.env ?? process.env;
        const allowed = operatorCallers(env);
        if (allowed.length === 0) {
            res.status(404).json({ detail: "Not found" });
            return;
        }
        const auth = req.headers.authorization;
        const token =
            typeof auth === "string" && auth.startsWith("Bearer ")
                ? auth.slice(7).trim()
                : "";
        if (!token) {
            res.status(401).json({ detail: "Missing bearer token" });
            return;
        }
        const devToken = env.OPERATOR_API_DEV_TOKEN?.trim();
        if (
            env.NODE_ENV !== "production" &&
            devToken &&
            constantTimeEq(token, devToken)
        ) {
            res.locals.adminActor = actorFor(req, "dev");
            next();
            return;
        }
        try {
            const payload = await verify(token, expectedAudiences(req, env));
            if (callerAllowed(payload, allowed)) {
                res.locals.adminActor = actorFor(req, payload!.email!.toLowerCase());
                next();
                return;
            }
            console.warn(
                `[operator] caller rejected: ${payload?.email ?? "?"}`,
            );
        } catch (err) {
            console.warn(
                "[operator] token verify failed:",
                err instanceof Error ? err.message : String(err),
            );
        }
        res.status(401).json({ detail: "Invalid caller token" });
    };
}

export const requireOperatorCaller = makeRequireOperatorCaller();
