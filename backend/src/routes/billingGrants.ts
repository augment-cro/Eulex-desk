/**
 * POST /internal/billing/grants — plan grants from the billing provider
 * (contracts/billing-provider.openapi.json). Body:
 *   { user_id, grant: { tier_level_id, until, label } | null }
 * The provider sends the user's whole current entitlement each time
 * (idempotent); lib/externalGrants.ts decides whether to write it.
 * Service → core identity per contracts/service-identity.md; with no
 * BILLING_SERVICE_SECRET every request is 401 (inert).
 */
import { Router } from "express";
import { verifyInboundServiceToken } from "../lib/seams/serviceIdentity";
import { applyExternalGrant, parseExternalGrant } from "../lib/externalGrants";
import { query } from "../lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createBillingGrantsRouter(): Router {
    const router = Router();

    router.post("/grants", async (req, res) => {
        const auth = req.headers.authorization ?? "";
        const identity = auth.startsWith("Bearer ") ? verifyInboundServiceToken(auth.slice(7)) : null;
        if (!identity || identity.service !== "billing") {
            res.status(401).json({ error: "unauthorized" });
            return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const userId = typeof body.user_id === "string" ? body.user_id : "";
        if (!UUID.test(userId)) {
            res.status(400).json({ error: "user_id must be a user uuid" });
            return;
        }
        const parsed = parseExternalGrant(body.grant === undefined ? undefined : body.grant);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        try {
            const exists = await query(`SELECT 1 FROM public.users WHERE id = $1`, [userId]);
            if (!exists.rowCount) {
                res.status(404).json({ error: "unknown user" });
                return;
            }
            const decision = await applyExternalGrant("billing", userId, parsed.grant);
            res.json({ ok: true, action: decision.action, ...(decision.action === "none" ? { why: decision.why } : {}) });
        } catch (err) {
            console.error("[internal/billing/grants]", err instanceof Error ? err.message : err);
            res.status(500).json({ error: "internal" });
        }
    });

    return router;
}

export default createBillingGrantsRouter();
