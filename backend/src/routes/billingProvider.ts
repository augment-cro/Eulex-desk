/**
 * /billing — offline-payment quotes and fiscal documents through the
 * optional billing-provider seam (contracts/billing-provider.openapi.json).
 *
 *   GET  /billing/offline/config                 — can I ask for a quote? prefill
 *   POST /billing/offline/quote                  — {plan, seats, company} → quote
 *   GET  /billing/documents                      — my quotes + invoices
 *   GET  /billing/documents/:kind/:id/pdf        — kind = quotes | invoices
 *
 * The core adds what only it knows — the user, the plan's price, the
 * Stripe customer ref, the profile's billing country (the provider decides
 * which countries get quotes and documents), whether a card subscription
 * is live — and relays the provider's answers unchanged. Inert (disabled /
 * empty) when the seam isn't configured.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import {
    billingProviderConfigured,
    billingProviderFetch,
    BillingProviderUnavailable,
} from "../lib/seams/billingProviderClient";
import { companyFromBody, loadStoredBilling, persistCompany } from "../lib/billingProfile";
import { providerPlan } from "../lib/providerPlan";
import { stripeGrantActive } from "../lib/externalGrants";

export const billingProviderRouter = Router();

/** Relay a provider answer: PDFs as bytes, everything else as JSON. */
export async function relayProviderResponse(res: Response, upstream: globalThis.Response): Promise<void> {
    const type = upstream.headers.get("content-type") ?? "";
    if (type.includes("application/pdf")) {
        res.status(upstream.status);
        res.setHeader("Content-Type", "application/pdf");
        const disposition = upstream.headers.get("content-disposition");
        if (disposition) res.setHeader("Content-Disposition", disposition);
        res.setHeader("Cache-Control", "private, no-store");
        res.send(Buffer.from(await upstream.arrayBuffer()));
        return;
    }
    const text = await upstream.text();
    try {
        res.status(upstream.status).json(JSON.parse(text));
    } catch {
        res.status(upstream.status >= 400 ? 502 : upstream.status).json({
            code: "BILLING_PROVIDER_BAD_ANSWER",
            detail: "Unexpected answer from the billing provider",
        });
    }
}

export function sendProviderError(res: Response, err: unknown, tag: string): void {
    if (err instanceof BillingProviderUnavailable) {
        console.error(`[${tag}]`, err.message);
        res.status(503).json({ code: "BILLING_PROVIDER_UNAVAILABLE", detail: "Billing provider unavailable" });
        return;
    }
    console.error(`[${tag}]`, err instanceof Error ? err.message : err);
    res.status(500).json({ code: "INTERNAL", detail: "Internal error" });
}

billingProviderRouter.get("/offline/config", requireAuth, async (_req: Request, res: Response) => {
    if (!billingProviderConfigured()) {
        res.json({ enabled: false });
        return;
    }
    const userId = res.locals.userId as string;
    try {
        const stored = await loadStoredBilling(userId);
        if (!stored) {
            res.status(404).json({ code: "USER_NOT_FOUND", detail: "User not found" });
            return;
        }
        // The provider decides which billing countries it serves; the core
        // passes the country the user chose in their profile.
        const upstream = await billingProviderFetch("/offline/config", {
            user: { id: userId, email: stored.email },
            query: { tax_id: stored.company.oib, country: stored.country },
        });
        const cfg = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
        const countries = Array.isArray(cfg.countries) ? cfg.countries.map(String) : null;
        const countryOk = !countries || (!!stored.country && countries.includes(stored.country));
        if (!upstream.ok || cfg.enabled !== true || !countryOk) {
            res.json({ enabled: false, reason: countryOk ? null : "COUNTRY_UNSUPPORTED" });
            return;
        }
        const stripeActive = await stripeGrantActive(userId);
        res.json({
            ...cfg,
            enabled: true,
            eligible: !stripeActive,
            reason: stripeActive ? "STRIPE_SUBSCRIPTION_ACTIVE" : null,
            email: stored.email,
            company: stored.company,
        });
    } catch (err) {
        sendProviderError(res, err, "billing/offline/config");
    }
});

billingProviderRouter.post("/offline/quote", requireAuth, async (req: Request, res: Response) => {
    if (!billingProviderConfigured()) {
        res.status(503).json({ code: "BANK_TRANSFER_DISABLED", detail: "Offline payment is not available" });
        return;
    }
    const userId = res.locals.userId as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
        const stored = await loadStoredBilling(userId);
        if (!stored) {
            res.status(404).json({ code: "USER_NOT_FOUND", detail: "User not found" });
            return;
        }
        if (await stripeGrantActive(userId)) {
            res.status(409).json({
                code: "STRIPE_SUBSCRIPTION_ACTIVE",
                detail: "The account has an active card subscription; change or cancel it first",
            });
            return;
        }
        const plan = await providerPlan(body.plan, body.seats);
        if (!plan) {
            res.status(400).json({ code: "PLAN_INVALID", detail: "Unknown or unavailable plan" });
            return;
        }
        const company = companyFromBody(body.company);
        const upstream = await billingProviderFetch("/offline/quotes", {
            user: { id: userId, email: stored.email },
            method: "POST",
            body: {
                plan,
                buyer: {
                    name: company.name,
                    taxId: company.oib,
                    street: company.street,
                    postalCode: company.postalCode,
                    city: company.city,
                    country: stored.country ?? "",
                },
                email: stored.email,
            },
            timeoutMs: 90_000,
        });
        if (upstream.ok) await persistCompany(userId, company);
        await relayProviderResponse(res, upstream);
    } catch (err) {
        sendProviderError(res, err, "billing/offline/quote");
    }
});

billingProviderRouter.get("/documents", requireAuth, async (_req: Request, res: Response) => {
    if (!billingProviderConfigured()) {
        res.json({ available: false, quotes: [], invoices: [] });
        return;
    }
    const userId = res.locals.userId as string;
    try {
        const stored = await loadStoredBilling(userId);
        const upstream = await billingProviderFetch("/documents", {
            user: { id: userId, email: stored?.email ?? null },
            query: { customer_ref: stored?.stripeCustomerId, country: stored?.country },
        });
        await relayProviderResponse(res, upstream);
    } catch (err) {
        sendProviderError(res, err, "billing/documents");
    }
});

billingProviderRouter.get(
    "/documents/:kind/:id/pdf",
    requireAuth,
    async (req: Request, res: Response) => {
        const { kind, id } = req.params;
        if (!["quotes", "invoices"].includes(kind) || !/^[0-9A-Za-z:_-]{1,64}$/.test(id)) {
            res.status(404).json({ code: "NOT_FOUND", detail: "Document not found" });
            return;
        }
        if (!billingProviderConfigured()) {
            res.status(404).json({ code: "NOT_FOUND", detail: "Document not found" });
            return;
        }
        const userId = res.locals.userId as string;
        try {
            const stored = await loadStoredBilling(userId);
            const upstream = await billingProviderFetch(`/documents/${kind}/${encodeURIComponent(id)}/pdf`, {
                user: { id: userId, email: stored?.email ?? null },
                query: { customer_ref: stored?.stripeCustomerId, country: stored?.country },
                timeoutMs: 60_000,
            });
            await relayProviderResponse(res, upstream);
        } catch (err) {
            sendProviderError(res, err, "billing/documents/pdf");
        }
    },
);
