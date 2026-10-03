/**
 * /internal/cron/* — scheduled jobs of this deployment, triggered by Cloud
 * Scheduler. Guarded by the shared X-Cron-Secret (ADMIN_CRON_SECRET), not by
 * any admin login: a scheduler cannot hold one. Unset secret → 503.
 *
 * Mounted at /internal/cron (index.ts).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { sendWeeklyAdminSummary } from "../lib/adminSummary";
import { sendExpiryReminders } from "../lib/expiryReminders";
import { backfillSignupContacts } from "../lib/brevoContacts";
import { sendContextAlertDigests } from "../lib/contextAlertDigest";

export const internalCronRouter = Router();

/** Constant-time X-Cron-Secret check; writes the error response itself. */
function cronSecretOk(req: Request, res: Response): boolean {
    const expected = process.env.ADMIN_CRON_SECRET?.trim();
    if (!expected) {
        res.status(503).json({ detail: "ADMIN_CRON_SECRET not configured" });
        return false;
    }
    const provided =
        typeof req.headers["x-cron-secret"] === "string"
            ? req.headers["x-cron-secret"]
            : "";
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    const len = Math.max(a.length, b.length);
    const pa = Buffer.alloc(len);
    const pb = Buffer.alloc(len);
    a.copy(pa);
    b.copy(pb);
    if (!timingSafeEqual(pa, pb) || a.length !== b.length) {
        res.status(401).json({ detail: "Invalid cron secret" });
        return false;
    }
    return true;
}

internalCronRouter.post(
    "/weekly-summary",
    async (req: Request, res: Response) => {
        if (!cronSecretOk(req, res)) return;
        try {
            const result = await sendWeeklyAdminSummary();
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[internal/cron/weekly-summary]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /internal/cron/expiry-reminders — daily. Reminds users whose
 * paid tier expires within 7 days AND won't auto-renew via Stripe
 * (manual/bank-transfer tiers, cancelled subscriptions, UMP leftovers).
 */
internalCronRouter.post(
    "/expiry-reminders",
    async (req: Request, res: Response) => {
        if (!cronSecretOk(req, res)) return;
        try {
            const result = await sendExpiryReminders();
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[internal/cron/expiry-reminders]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /internal/cron/brevo-backfill — one-shot. Imports every existing
 * public.users row into the Brevo newsletter list (BREVO_SIGNUP_LIST_ID).
 * New signups are synced live by the auth middleware; this only exists to
 * catch up users who registered before that hook shipped. Idempotent
 * (Brevo updates existing contacts), so re-running is safe.
 */
internalCronRouter.post(
    "/brevo-backfill",
    async (req: Request, res: Response) => {
        if (!cronSecretOk(req, res)) return;
        try {
            const result = await backfillSignupContacts();
            res.status(result.errors.length ? 207 : 200).json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[internal/cron/brevo-backfill]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /internal/cron/context-alerts — daily. Sends the hr/en digest of
 * context source-change notifications (service_notifications rows from
 * contexts-service) to context owners; claims each row on success.
 */
internalCronRouter.post(
    "/context-alerts",
    async (req: Request, res: Response) => {
        if (!cronSecretOk(req, res)) return;
        try {
            const result = await sendContextAlertDigests();
            res.json(result);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[internal/cron/context-alerts]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);
