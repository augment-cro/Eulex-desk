/**
 * /operator/v1/billing — operator console front for the billing-provider seam
 * (contracts/billing-provider.openapi.json, admin part).
 *
 *   GET  /operator/v1/billing/quotes                    — list (?status=), + user e-mails
 *   GET  /operator/v1/billing/users/:userId/billing     — prefill for a new quote
 *   POST /operator/v1/billing/quotes                    — quote for a registered user
 *   POST /operator/v1/billing/quotes/:id/:action        — mark-paid | resend | cancel | retry
 *   GET  /operator/v1/billing/quotes/:id/pdf
 *   GET  /operator/v1/billing/invoices/:docId/pdf
 *   POST /operator/v1/billing/check-payments | sync-invoices
 *
 * Mounted after requireOperatorCaller (routes/operator.ts). The core adds what it owns (users,
 * plan prices, Stripe status) and relays the rest; mutations are
 * audit-logged. Provider field names (taxId, note) are mapped to the
 * operator console's (oib, paidNote).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { auditMeta, logAdminAudit } from "../lib/adminAudit";
import { query } from "../lib/db";
import { billingProviderConfigured, billingProviderFetch } from "../lib/seams/billingProviderClient";
import { companyFromBody, loadStoredBilling } from "../lib/billingProfile";
import { providerPlan } from "../lib/providerPlan";
import { stripeGrantActive } from "../lib/externalGrants";
import { relayProviderResponse, sendProviderError } from "./billingProvider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["mark-paid", "resend", "cancel", "retry"]);

type ProviderQuote = Record<string, unknown> & {
    userId?: string;
    buyer?: Record<string, unknown>;
    note?: string | null;
};

/** Provider admin quote → the shape the operator console reads. */
function toAdminShape(q: ProviderQuote, emails: Map<string, string | null>): Record<string, unknown> {
    const { note, buyer, ...rest } = q;
    const b = buyer ?? {};
    return {
        ...rest,
        userEmail: q.userId ? emails.get(q.userId) ?? null : null,
        paidNote: note ?? null,
        buyer: { name: b.name, oib: b.taxId, street: b.street, postalCode: b.postalCode, city: b.city },
    };
}

export function makeAdminBillingRouter(): Router {
    const router = Router();

    router.use((_req, res, next) => {
        if (!billingProviderConfigured()) {
            res.status(503).json({ code: "BILLING_PROVIDER_UNAVAILABLE", detail: "Billing provider not configured" });
            return;
        }
        next();
    });

    router.get("/quotes", async (req: Request, res: Response) => {
        try {
            const upstream = await billingProviderFetch("/admin/quotes", {
                admin: true,
                query: { status: typeof req.query.status === "string" ? req.query.status : null },
            });
            if (!upstream.ok) {
                await relayProviderResponse(res, upstream);
                return;
            }
            const data = (await upstream.json()) as { config?: unknown; quotes?: ProviderQuote[] };
            const quotes = data.quotes ?? [];
            const ids = [...new Set(quotes.map((q) => q.userId).filter((id): id is string => !!id && UUID.test(id)))];
            const emails = new Map<string, string | null>();
            if (ids.length) {
                const r = await query<{ id: string; email: string | null }>(
                    `SELECT id, email FROM public.users WHERE id = ANY($1::uuid[])`,
                    [ids],
                );
                for (const row of r.rows) emails.set(row.id, row.email);
            }
            res.json({ config: data.config ?? null, quotes: quotes.map((q) => toAdminShape(q, emails)) });
        } catch (err) {
            sendProviderError(res, err, "operator/billing/quotes");
        }
    });

    router.get("/users/:userId/billing", async (req: Request, res: Response) => {
        const userId = req.params.userId;
        if (!UUID.test(userId)) {
            res.status(404).json({ code: "USER_NOT_FOUND", detail: "User not found" });
            return;
        }
        try {
            const stored = await loadStoredBilling(userId);
            if (!stored) {
                res.status(404).json({ code: "USER_NOT_FOUND", detail: "User not found" });
                return;
            }
            const [stripeActive, eligibility] = await Promise.all([
                stripeGrantActive(userId),
                billingProviderFetch("/admin/eligibility", {
                    admin: true,
                    query: { user_id: userId, tax_id: stored.company.oib, country: stored.country },
                }).then((r) => r.json().catch(() => ({}))) as Promise<{
                    provisionalAvailable?: boolean;
                    countrySupported?: boolean;
                }>,
            ]);
            const c = stored.company;
            res.json({
                email: stored.email,
                buyer: c,
                complete: !!(c.name && c.oib && c.street && c.postalCode && c.city),
                stripeActive,
                provisionalAvailable: eligibility.provisionalAvailable === true,
                country: stored.country,
                // Older providers don't report it: don't block on a missing answer.
                countrySupported: eligibility.countrySupported !== false,
            });
        } catch (err) {
            sendProviderError(res, err, "operator/billing/user-billing");
        }
    });

    router.post("/quotes", async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const userId = typeof body.userId === "string" ? body.userId : "";
        if (!UUID.test(userId)) {
            res.status(400).json({ code: "USER_REQUIRED", detail: "Pick a registered user" });
            return;
        }
        try {
            const stored = await loadStoredBilling(userId);
            if (!stored) {
                res.status(404).json({ code: "USER_NOT_FOUND", detail: "User not found" });
                return;
            }
            if (await stripeGrantActive(userId)) {
                res.status(409).json({
                    code: "STRIPE_SUBSCRIPTION_ACTIVE",
                    detail: "The user has an active card subscription",
                });
                return;
            }
            const plan = await providerPlan(body.plan, body.seats);
            if (!plan) {
                res.status(400).json({ code: "PLAN_INVALID", detail: "Unknown or unavailable plan" });
                return;
            }
            const company = companyFromBody(body.company);
            const email =
                typeof body.email === "string" && body.email.trim() ? body.email.trim() : stored.email;
            const upstream = await billingProviderFetch("/admin/quotes", {
                admin: true,
                method: "POST",
                body: {
                    user_id: userId,
                    plan,
                    buyer: {
                        name: company.name,
                        taxId: company.oib,
                        street: company.street,
                        postalCode: company.postalCode,
                        city: company.city,
                        country: stored.country ?? "",
                    },
                    email,
                    provisional: body.provisional === true,
                    send_email: body.sendEmail !== false,
                },
                timeoutMs: 90_000,
            });
            if (upstream.ok) {
                void logAdminAudit({
                    action: "billing.quote.create",
                    targetType: "user",
                    targetId: userId,
                    payload: { plan: plan.key, seats: plan.seats, provisional: body.provisional === true },
                    ...auditMeta(req, res),
                });
            }
            await relayProviderResponse(res, upstream);
        } catch (err) {
            sendProviderError(res, err, "operator/billing/create");
        }
    });

    router.post("/quotes/:id/:action", async (req: Request, res: Response) => {
        const { id, action } = req.params;
        if (!UUID.test(id) || !ACTIONS.has(action)) {
            res.status(404).json({ code: "NOT_FOUND", detail: "Not found" });
            return;
        }
        try {
            const upstream = await billingProviderFetch(`/admin/quotes/${id}/${action}`, {
                admin: true,
                method: "POST",
                body: req.body ?? {},
                timeoutMs: 90_000,
            });
            if (upstream.ok) {
                void logAdminAudit({
                    action: `billing.quote.${action.replace("-", "_")}`,
                    targetType: "quote",
                    targetId: id,
                    payload: action === "mark-paid" ? { paid_at: (req.body ?? {}).paidAt ?? null } : null,
                    ...auditMeta(req, res),
                });
            }
            await relayProviderResponse(res, upstream);
        } catch (err) {
            sendProviderError(res, err, `operator/billing/${action}`);
        }
    });

    router.get("/quotes/:id/pdf", async (req: Request, res: Response) => {
        if (!UUID.test(req.params.id)) {
            res.status(404).json({ code: "QUOTE_NOT_FOUND", detail: "Quote not found" });
            return;
        }
        try {
            await relayProviderResponse(
                res,
                await billingProviderFetch(`/admin/quotes/${req.params.id}/pdf`, { admin: true, timeoutMs: 60_000 }),
            );
        } catch (err) {
            sendProviderError(res, err, "operator/billing/quote-pdf");
        }
    });

    router.get("/invoices/:docId/pdf", async (req: Request, res: Response) => {
        if (!/^[0-9A-Za-z:_-]{1,64}$/.test(req.params.docId)) {
            res.status(404).json({ code: "INVOICE_NOT_FOUND", detail: "Invoice not found" });
            return;
        }
        try {
            await relayProviderResponse(
                res,
                await billingProviderFetch(`/admin/invoices/${encodeURIComponent(req.params.docId)}/pdf`, {
                    admin: true,
                    timeoutMs: 60_000,
                }),
            );
        } catch (err) {
            sendProviderError(res, err, "operator/billing/invoice-pdf");
        }
    });

    for (const op of ["check-payments", "sync-invoices"] as const) {
        router.post(`/${op}`, async (req: Request, res: Response) => {
            try {
                const upstream = await billingProviderFetch(`/admin/${op}`, {
                    admin: true,
                    method: "POST",
                    timeoutMs: 120_000,
                });
                if (upstream.ok) {
                    void logAdminAudit({
                        action: `billing.${op.replace("-", "_")}`,
                        targetType: "billing",
                        ...auditMeta(req, res),
                    });
                }
                await relayProviderResponse(res, upstream);
            } catch (err) {
                sendProviderError(res, err, `operator/billing/${op}`);
            }
        });
    }

    return router;
}
