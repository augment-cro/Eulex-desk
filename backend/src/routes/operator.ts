/**
 * /operator/v1 — the generic administration API of this deployment.
 *
 * Contract: contracts/operator.openapi.json. An operator console (any
 * program speaking that contract) calls it server-to-server with a Google
 * identity token from a service account listed in OPERATOR_API_CALLERS;
 * see middleware/operatorAuth.ts. Unset → 404 for the whole surface, and
 * the app runs exactly as without a console.
 *
 * The surface is the admin data routes (routes/adminMax.ts
 * `adminDataRouter`: users, tiers, credits, usage, chats, audit, promos,
 * MCP usage), the billing-provider admin relay, plus three console
 * helpers defined here:
 *
 *   GET  /operator/v1/whoami        — caller identity + build (smoke test)
 *   GET  /operator/v1/models        — this build's model registry
 *   POST /operator/v1/audit         — record an action the console performed
 *                                     elsewhere (one admin_audit trail)
 *   POST /operator/v1/login-events  — an operator signed in to the console
 *                                     ("new users since last login")
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { requireOperatorCaller } from "../middleware/operatorAuth";
import { auditMeta, logAdminAudit } from "../lib/adminAudit";
import { recordAdminLogin } from "../lib/adminState";
import { maxModelCatalogue } from "../lib/llm/modelCatalogue";
import { adminDataRouter } from "./adminMax";
import { makeAdminBillingRouter } from "./adminBilling";

const AUDIT_ACTION_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
const AUDIT_FIELD_MAX = 200;
const AUDIT_PAYLOAD_MAX_BYTES = 8 * 1024;

function optionalField(v: unknown): string | null | undefined {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || v.length > AUDIT_FIELD_MAX) return undefined;
    return v;
}

export function makeOperatorRouter(
    deps: {
        auth?: typeof requireOperatorCaller;
        data?: Router;
        billing?: Router;
    } = {},
): Router {
    const router = Router();
    router.use(deps.auth ?? requireOperatorCaller);

    router.get("/whoami", (_req: Request, res: Response) => {
        res.json({
            caller: res.locals.adminActor ?? null,
            build: process.env.BUILD_GIT_SHA || null,
        });
    });

    router.get("/models", (_req: Request, res: Response) => {
        res.setHeader("Cache-Control", "no-store");
        res.json(maxModelCatalogue());
    });

    router.post("/audit", async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const action = body.action;
        if (typeof action !== "string" || !AUDIT_ACTION_RE.test(action)) {
            res.status(400).json({
                detail: "action: 3–64 chars, [a-z0-9_.-], starting with a letter",
            });
            return;
        }
        const targetType = optionalField(body.target_type);
        const targetId = optionalField(body.target_id);
        if (targetType === undefined || targetId === undefined) {
            res.status(400).json({
                detail: `target_type / target_id: string ≤ ${AUDIT_FIELD_MAX} chars`,
            });
            return;
        }
        const payload = body.payload ?? null;
        if (
            payload !== null &&
            (typeof payload !== "object" || Array.isArray(payload))
        ) {
            res.status(400).json({ detail: "payload must be an object" });
            return;
        }
        if (
            payload &&
            Buffer.byteLength(JSON.stringify(payload)) > AUDIT_PAYLOAD_MAX_BYTES
        ) {
            res.status(413).json({ detail: "payload too large (max 8 KB)" });
            return;
        }
        await logAdminAudit({
            action,
            targetType,
            targetId,
            payload: payload as Record<string, unknown> | null,
            ...auditMeta(req, res),
        });
        res.status(201).json({ ok: true });
    });

    router.post("/login-events", async (_req: Request, res: Response) => {
        try {
            const previous = await recordAdminLogin();
            res.json({ ok: true, previous_login_at: previous?.toISOString() ?? null });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[operator/login-events]", msg);
            res.status(500).json({ detail: msg });
        }
    });

    router.use("/billing", deps.billing ?? makeAdminBillingRouter());
    router.use(deps.data ?? adminDataRouter);
    return router;
}
