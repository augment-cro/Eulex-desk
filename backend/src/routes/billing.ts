/**
 * Stripe-driven token-pack top-up for Eulex Plus subscribers.
 *
 * Three-route surface:
 *
 *   GET  /billing/topup/packs          — public catalog (which packs,
 *                                         which prices, in what currency)
 *   POST /billing/topup/create-session — Plus-only; opens a Stripe
 *                                         Checkout session and returns
 *                                         the redirect URL
 *   POST /billing/stripe/webhook       — Stripe → us; signature-verified
 *                                         and idempotent (dedupes via
 *                                         `stripe_event_id` UNIQUE)
 *
 * The webhook is the only place `stripe` payment_method credits get
 * written. Self-service users never hit the AdminMax credits POST.
 *
 * @module billing
 */

import { Router } from "express";
import { recordAuditEvent, recordFeatureUse } from "../lib/audit";
import express from "express";
import type { Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { query } from "../lib/db";
import {
    findPack,
    getEulexLegalTeamProductId,
    getLegalProProductId,
    getPlanDef,
    getPlusProductId,
    getProProductId,
    getStripe,
    getTeamProductId,
    getTokenPacks,
    isStripeConfigured,
    planDefByKeyOrSlug,
    planForProductId,
    resolvePackPriceId,
    resolvePriceIdForPlan,
    stripeWebhookSecret,
    syncCustomerInvoiceDetails,
    type PaidPlan,
    type PlanDef,
} from "../lib/stripe";
import {
    can,
    getEntitlements,
    tierKeyForLevelId,
    TIER_RANK,
} from "../lib/entitlements";
import { ensureTeamForOwner } from "../lib/teams";
import { parseUiLocale, type UiLocale } from "../lib/uiLocale";
import { getPlanCatalog } from "../lib/planCatalog";
import {
    clearLocalTierOverride,
    findUserByStripeCustomer,
    getFreeTierLevelId,
    isPartnerPushConfigured,
    pushMembershipChange,
    rememberCheckoutCountry,
    rememberStripeCustomer,
    replaceUmpUserLevels,
    setLocalTierActive,
    type MembershipPushPayload,
} from "../lib/membership";
import { getEmailProvider } from "../lib/email/provider";
import { renderOrderConfirmationEmail } from "../lib/email/templates/orderConfirmation";
import { postEvent } from "../lib/analytics";

// Structural types for the slice of Stripe payloads we touch. The
// official Stripe namespace types (Stripe.Event, Stripe.Checkout.Session)
// aren't visible through the CJS module resolution this repo uses, so
// we declare just the fields the handler reads. The Stripe SDK still
// validates the shape at runtime via `webhooks.constructEvent`.
type StripeWebhookEvent = {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
};

type StripeCheckoutSession = {
    id: string;
    payment_status?: string;
    payment_intent?: string | null;
    amount_total?: number | null;
    customer_email?: string | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
};

type StripeSubscriptionLite = {
    id: string;
    customer: string;
    status: string;
    cancel_at_period_end: boolean;
    current_period_end?: number | null;
    /** Unix seconds the subscription was created — used to tell a brand-new
     *  order apart from a renewal so we only email on the former. */
    created?: number | null;
    items?: {
        data?: Array<{
            price?: { id?: string; product?: string | { id?: string } };
            quantity?: number;
            current_period_end?: number;
        }>;
    };
    metadata?: Record<string, string> | null;
};

/**
 * Resolve which paid plan a Stripe subscription represents. Order:
 *   1. the product id on the subscription's price (authoritative — it's
 *      what the customer actually pays for, set or not by our checkout);
 *   2. our checkout `metadata.plan` (key or slug) as a fallback;
 *   3. Plus, as a last resort (legacy single-product behaviour) — logged.
 */
function resolveSubscriptionPlan(sub: StripeSubscriptionLite): PlanDef {
    const price = sub.items?.data?.[0]?.price;
    const rawProduct = price?.product;
    const productId =
        typeof rawProduct === "string"
            ? rawProduct
            : rawProduct && typeof rawProduct === "object"
              ? (rawProduct.id ?? null)
              : null;
    const byProduct = planForProductId(productId);
    if (byProduct) return byProduct;
    const byMeta = planDefByKeyOrSlug(sub.metadata?.plan);
    if (byMeta) return byMeta;
    console.warn(
        `[stripe/webhook] could not resolve plan for sub=${sub.id} (product=${productId ?? "—"}, meta.plan=${sub.metadata?.plan ?? "—"}); defaulting to plus`,
    );
    return getPlanDef("plus") as PlanDef;
}

/**
 * Whether the caller's tier may buy token packs. Resolved from the
 * `buyTokenPacks` entitlement (Plus and up) keyed off the authoritative
 * tier_level_id — NOT the legacy `res.locals.tier` string, which only
 * carries 'free'|'plus' and is wrong for pro/team.
 */
async function callerCanBuyPacks(res: Response): Promise<boolean> {
    const tierLevelId = res.locals.tierLevelId as number | undefined;
    if (typeof tierLevelId !== "number") return false;
    try {
        return can(await getEntitlements(tierLevelId), "buyTokenPacks");
    } catch {
        return false;
    }
}

type StripeInvoiceLite = {
    id: string;
    customer: string;
    subscription?: string | null;
    /**
     * API ≥ 2025-03-31.basil moved the subscription off the invoice root:
     * it now lives at parent.subscription_details.subscription (string or
     * expanded object). Keep both shapes — webhook payload shape follows
     * the endpoint's pinned API version.
     */
    parent?: {
        subscription_details?: {
            subscription?: string | { id: string } | null;
        } | null;
    } | null;
    status?: string | null;
    /** Cents actually collected — 0 for trial/credit-balance invoices. */
    amount_paid?: number | null;
    currency?: string | null;
    /** Unix seconds the invoice was created (≈ payment time for paid). */
    created?: number | null;
    metadata?: Record<string, string> | null;
    /**
     * Discount ids (unexpanded in webhook payloads). Only used as a
     * cheap "was this invoice discounted?" signal — the promo code
     * itself is resolved via an expanded re-retrieve.
     */
    discounts?: unknown[] | null;
};

/** Subscription id from either invoice shape (pre-/post-Basil). */
function invoiceSubscriptionId(inv: StripeInvoiceLite): string | null {
    if (typeof inv.subscription === "string" && inv.subscription) {
        return inv.subscription;
    }
    const s = inv.parent?.subscription_details?.subscription ?? null;
    if (typeof s === "string" && s) return s;
    if (s && typeof s === "object" && typeof s.id === "string") return s.id;
    return null;
}

export const billingRouter = Router();

/**
 * Billing country is REQUIRED at checkout (tracker #33).
 *
 * History: this used to try `automatic_tax` and, when Stripe could not
 * resolve a tax location (no address on the customer — the common case,
 * because checkout never asked for a country), silently retry WITHOUT
 * tax. The docblock promised "the webhook will re-enable tax on the next
 * renewal" — no such webhook ever existed, so a subscription created that
 * way stayed VAT-free on every renewal. Audit 2026-08-31: 15 of 43 paid
 * invoices and 6 of 15 active subscriptions had no VAT.
 *
 * Now the country arrives from the checkout modal, is validated here, is
 * written to the Stripe customer BEFORE the subscription exists, and
 * `automatic_tax` is mandatory. If Stripe still cannot resolve a location
 * the error surfaces to the user as `TAX_LOCATION_UNRESOLVED` — the
 * checkout fails loudly instead of issuing an invoice without VAT.
 */
const ISO2 = /^[A-Z]{2}$/;

/** Normalise + validate a body `country` field. Null when unusable. */
function parseCountry(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const c = raw.trim().toUpperCase();
    return ISO2.test(c) ? c : null;
}

/** Trimmed non-empty string, else null. Length-capped for DB/Stripe. */
function parseText(raw: unknown, max = 120): string | null {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    return s ? s.slice(0, max) : null;
}

/**
 * Billing details the checkout modal collects (tracker #33 / #35).
 *
 * Natural person: `name` + `country` mandatory.
 * Business (`business: true`, or a VAT ID / company name given): Zakon o
 * PDV-u čl. 79. st. 1. t. 3. requires the buyer's name, ADDRESS and
 * OIB / VAT ID on the invoice — so `organisation`, `addressLine1`,
 * `addressCity` and `vatNumber` are all mandatory. Postal code and phone
 * are optional for everyone (tracker #37) — čl. 79. does not ask for a
 * phone; we take it only if the user offers it. The route handlers
 * validate; runCheckout persists + pushes everything to the Stripe
 * customer before sub.create.
 */
type BillingDetails = {
    name: string;
    country: string;
    business: boolean;
    organisation: string | null;
    vatNumber: string | null;
    addressLine1: string | null;
    addressCity: string | null;
    addressPostalCode: string | null;
    /** Optional contact phone (tracker #37) — never required. */
    phone: string | null;
};

/** Parse + validate billing details from a request body. */
function parseBillingDetails(
    body: Record<string, unknown>,
): { ok: true; details: BillingDetails } | { ok: false; code: string; detail: string } {
    const country = parseCountry(body.country);
    if (!country) {
        return { ok: false, code: "COUNTRY_REQUIRED", detail: "Billing country is required" };
    }
    const name = parseText(body.name);
    if (!name) {
        return { ok: false, code: "NAME_REQUIRED", detail: "Billing name is required" };
    }
    const organisation = parseText(body.organisation);
    const vatNumber = parseText(body.vat_number, 40);
    const addressLine1 = parseText(body.address_line1, 200);
    const addressCity = parseText(body.address_city, 120);
    const addressPostalCode = parseText(body.address_postal_code, 20);
    const business = body.business === true || !!organisation || !!vatNumber;
    if (business) {
        if (!organisation) {
            return { ok: false, code: "ORGANISATION_REQUIRED", detail: "Company name is required for a business invoice" };
        }
        if (!vatNumber) {
            return { ok: false, code: "VAT_ID_REQUIRED", detail: "OIB or VAT ID is required for a business invoice" };
        }
        if (!addressLine1 || !addressCity) {
            return { ok: false, code: "ADDRESS_REQUIRED", detail: "Street and city are required for a business invoice" };
        }
    }
    return {
        ok: true,
        details: {
            name,
            country,
            business,
            organisation,
            vatNumber,
            addressLine1,
            addressCity,
            addressPostalCode,
            phone: parseText(body.phone, 40),
        },
    };
}

/**
 * Persist what the user typed at checkout so Settings → General shows
 * the same values and later renewals / plan changes resolve the same
 * tax location. display_name + organisation live on user_profiles
 * (DML is fine for the IAM user — only ALTER is postgres-owned); country,
 * vat_number and the billing address on user_tier_state. Country is the
 * one write that must succeed (it gates automatic_tax); the rest are
 * best-effort.
 */
async function persistBillingDetails(
    userId: string,
    d: BillingDetails,
): Promise<void> {
    await rememberCheckoutCountry(userId, d.country);
    try {
        await query(
            `INSERT INTO public.user_tier_state
                (user_id, vat_number, address_line1, address_city, address_postal_code, phone, active_tier_synced_at)
                  VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (user_id) DO UPDATE SET
                vat_number = EXCLUDED.vat_number,
                address_line1 = EXCLUDED.address_line1,
                address_city = EXCLUDED.address_city,
                address_postal_code = EXCLUDED.address_postal_code,
                phone = COALESCE(EXCLUDED.phone, public.user_tier_state.phone)`,
            [userId, d.vatNumber, d.addressLine1, d.addressCity, d.addressPostalCode, d.phone],
        );
        await query(
            `INSERT INTO public.user_profiles (user_id, display_name, organisation)
                  VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                organisation = EXCLUDED.organisation`,
            [userId, d.name, d.organisation],
        );
    } catch (err) {
        console.warn(
            "[billing/checkout] billing-details persist (non-country) failed:",
            err instanceof Error ? err.message : err,
        );
    }
}

function isTaxLocationError(err: unknown): boolean {
    const msg =
        err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "";
    if (!msg) return false;
    return (
        /customer'?s? location/i.test(msg) ||
        /tax location/i.test(msg) ||
        /automatic[_\s-]?tax/i.test(msg) ||
        /not recogniz/i.test(msg)
    );
}

/** Thrown when Stripe cannot derive a tax location even with a country set. */
class TaxLocationError extends Error {
    readonly code = "TAX_LOCATION_UNRESOLVED";
    constructor(cause: unknown) {
        super(
            cause instanceof Error
                ? cause.message
                : "Stripe could not resolve a tax location",
        );
        this.name = "TaxLocationError";
    }
}

/**
 * Create the subscription with `automatic_tax` — no fallback. Callers
 * have already written a validated country onto the customer, so a
 * tax-location rejection here is a real fault (Stripe Tax not enabled
 * for that country, malformed address…) and must reach the user, never
 * be papered over with a VAT-free invoice.
 */
async function createSubscriptionWithTax(
    stripe: ReturnType<typeof getStripe>,
    baseParams: Record<string, unknown>,
): Promise<unknown> {
    try {
        return await stripe.subscriptions.create({
            ...baseParams,
            automatic_tax: { enabled: true },
        } as Parameters<typeof stripe.subscriptions.create>[0]);
    } catch (err) {
        if (isTaxLocationError(err)) throw new TaxLocationError(err);
        throw err;
    }
}

// ── public plan catalog ─────────────────────────────────────────────────────

/**
 * GET /billing/plans — PUBLIC (no auth). The single source of truth for
 * the pricing UI on BOTH Eulex Desk (PlanCards) and the eulex.ai landing page.
 * Serves tier marketing copy (bilingual) + entitlements + daily quota,
 * resolved from `tier_limits` with code-default fallback (60s cache).
 * eulex.ai fetches this server-side and renders its own pricing cards.
 */
billingRouter.get("/plans", async (_req, res) => {
    try {
        const catalog = await getPlanCatalog();
        res.json({
            plans: catalog.map((p) => ({
                tierLevelId: p.tierLevelId,
                tierKey: p.tierKey,
                slug: p.slug,
                label: p.label,
                dailyTokens: p.dailyTokens,
                order: p.marketing.order,
                popular: p.marketing.popular,
                entitlements: p.entitlements,
                locales: p.marketing.locales,
            })),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[billing/plans]", msg);
        res.status(500).json({ detail: msg });
    }
});

// ── public catalog (top-up) ─────────────────────────────────────────────────

/**
 * GET /billing/topup/packs — what self-service top-ups are available.
 * Shipped to the frontend so the banner CTA can render the right
 * copy + price.
 */
billingRouter.get("/topup/packs", requireAuth, async (_req, res) => {
    const eligible = await callerCanBuyPacks(res);
    res.json({
        enabled: isStripeConfigured() && getTokenPacks().length > 0,
        eligible,
        packs: eligible ? getTokenPacks().map(({ priceId, ...rest }) => rest) : [],
    });
});

// ── checkout session ──────────────────────────────────────────────────────

/**
 * POST /billing/topup/create-session — Plus-only Stripe Checkout entry.
 * Body: { pack_id: "tokens_1m" | "tokens_3m" }
 * Resp: { url: string }
 */
billingRouter.post(
    "/topup/create-session",
    requireAuth,
    async (req: Request, res: Response) => {
        if (!isStripeConfigured()) {
            res.status(503).json({ detail: "Stripe not configured" });
            return;
        }
        if (!(await callerCanBuyPacks(res))) {
            res.status(403).json({
                detail: "Kupnja token paketa zahtijeva Plus ili višu pretplatu.",
                code: "TIER_REQUIRED",
                feature: "buyTokenPacks",
            });
            return;
        }
        const { pack_id } = req.body as { pack_id?: string };
        if (typeof pack_id !== "string") {
            res.status(400).json({ detail: "pack_id required" });
            return;
        }
        const pack = findPack(pack_id);
        if (!pack) {
            res.status(404).json({ detail: "Unknown pack" });
            return;
        }
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const successBase = billingFrontendBaseUrl();
        try {
            // #76: the env slot may hold a product id (prod_…) — resolve
            // it to the product's default price; Checkout only accepts
            // price_… in line_items[].price.
            const packPriceId = await resolvePackPriceId(pack);
            const session = await getStripe().checkout.sessions.create({
                mode: "payment",
                // Stripe-hosted page follows the app UI language instead
                // of the browser locale.
                locale: parseUiLocale(req),
                payment_method_types: ["card"],
                line_items: [{ price: packPriceId, quantity: 1 }],
                customer_email: userEmail,
                client_reference_id: userId,
                // Critical: these flow into the webhook so we can
                // credit the right user with the right token amount
                // even if the price ID gets reused for promo bundles.
                metadata: {
                    user_id: userId,
                    pack_id: pack.id,
                    tokens: String(pack.tokens),
                },
                payment_intent_data: {
                    metadata: {
                        user_id: userId,
                        pack_id: pack.id,
                        tokens: String(pack.tokens),
                    },
                },
                success_url: `${successBase}/account/billing?topup=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${successBase}/account/billing?topup=cancelled`,
                allow_promotion_codes: true,
            });
            if (!session.url) {
                res.status(500).json({ detail: "Stripe returned no URL" });
                return;
            }
            res.json({ url: session.url, session_id: session.id });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[billing/create-session]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// ── Plus subscription (Eulex Desk-owned Stripe Subscription) ────────────────────
//
// The Eulex Desk app owns the Plus subscription end-to-end:
//   • POST /billing/plus/checkout         — create Subscription, return clientSecret
//   • GET  /billing/plus/status           — read live state from Stripe + local override
//   • POST /billing/plus/cancel           — cancel at period end
//   • Stripe webhook /billing/stripe/webhook handles the lifecycle
//     events and pushes UMP changes to the partner site over the
//     internal push API (see backend/src/lib/membership.ts).
//
// No JWT-aware WP REST surface is referenced from this service — the
// only outbound call to the partner site is the small signed
// /membership push.

billingRouter.get("/plus/config", requireAuth, (_req, res) => {
    const stripeOn = isStripeConfigured();
    res.json({
        // True iff Stripe is configured AND we know which product is
        // the Plus product. Frontend hides the upgrade modal when false.
        plusEnabled: stripeOn && !!getPlusProductId(),
        // Same flag, per paid plan — drives which upgrade options the
        // frontend offers (Phase 4 surfaces Pro/Team; legal tiers added
        // in the pricing relaunch). Enterprise is on-demand (no checkout).
        proEnabled: stripeOn && !!getProProductId(),
        teamEnabled: stripeOn && !!getTeamProductId(),
        legalProEnabled: stripeOn && !!getLegalProProductId(),
        eulexLegalTeamEnabled: stripeOn && !!getEulexLegalTeamProductId(),
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
        // Whether membership pushes to the partner site are wired —
        // surfaced for AdminMax/observability only; checkout works
        // either way (local override is always written).
        partnerPushEnabled: isPartnerPushConfigured(),
    });
});

/**
 * POST /billing/plus/checkout — start a Plus Subscription.
 * Body (optional): { return_url?: string }
 * Resp: {
 *   subscriptionId, clientSecret, type: "payment"|"setup",
 *   amountDue, subtotal, taxAmount, currency
 * }
 *
 * Mirrors the surface the existing PlusUpgradeModal expects so the
 * frontend can render Stripe Elements + confirmPayment without
 * branching on backend variant.
 */
/** Seats for a per-seat plan (Team), clamped to [minSeats, 1000]. */
function clampSeats(planDef: PlanDef, raw: unknown): number {
    if (!planDef.perSeat) return 1;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return planDef.minSeats;
    return Math.min(1000, Math.max(planDef.minSeats, n));
}

/**
 * Optional free-trial window for new subscriptions, in days. Unset/0 →
 * no trial (default). Applies to every paid plan; per-plan trials can
 * be added later if marketing wants them.
 */
function getTrialDays(): number {
    const n = Number(process.env.STRIPE_TRIAL_DAYS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Resolve a customer-facing promotion code ("LJETO25") to the Stripe
 * promotion-code id checkout needs. Returns null when the code does not
 * exist or is inactive — callers turn that into a 400 so the user gets
 * immediate feedback instead of paying full price silently.
 */
async function resolvePromotionCode(code: string): Promise<string | null> {
    const trimmed = code.trim();
    if (!trimmed) return null;
    const list = await getStripe().promotionCodes.list({
        code: trimmed,
        active: true,
        limit: 1,
    });
    return list.data[0]?.id ?? null;
}

/**
 * Shared checkout body for any paid plan. Creates a Stripe Subscription
 * with `default_incomplete` and returns the Elements clientSecret. Team
 * passes `quantity = seats`. See the two route mounts below.
 */
async function runCheckout(
    plan: PaidPlan,
    seats: number,
    res: Response,
    opts: {
        promoCode?: string;
        locale?: UiLocale;
        /** Validated by the route handler — see parseBillingDetails. */
        billing?: BillingDetails;
    } = {},
): Promise<void> {
    const planDef = getPlanDef(plan);
    if (!isStripeConfigured() || !planDef?.productId) {
        res.status(503).json({
            detail: `${plan} subscription is not configured`,
        });
        return;
    }
    {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const wpUserId = res.locals.wpUserId as number | undefined;
        // Funnel signal (migration 210): checkout started. Completion is
        // recorded by the Stripe webhook (subscription.* via recordTierChange).
        void recordAuditEvent({
            userId,
            eventType: "checkout.started",
            metadata: { plan, seats, promo: Boolean(opts.promoCode) },
        });
        void recordFeatureUse({ userId, feature: "checkout" });
        try {
            const stripe = getStripe();
            const priceId = await resolvePriceIdForPlan(plan);

            // Optional promo code — resolved FIRST so a bad code is a clear
            // 400 before we touch (and cancel) any existing incomplete
            // subscription; the user's current payment form stays alive.
            let promotionCodeId: string | null = null;
            if (opts.promoCode) {
                promotionCodeId = await resolvePromotionCode(opts.promoCode);
                if (!promotionCodeId) {
                    res.status(400).json({
                        detail: "Nepoznat ili neaktivan promo kod",
                        code: "INVALID_PROMO_CODE",
                    });
                    return;
                }
            }

            // 1. Reuse a customer if we have one; otherwise create.
            //    Country sits on the same row, so we grab both in a
            //    single round-trip — used to pre-fill Stripe
            //    customer.address.country so automatic_tax can resolve
            //    a tax location on the very first invoice. Without it
            //    Stripe rejects sub.create with "customer's location
            //    isn't recognized" and we fall back to no-VAT pricing
            //    (see createSubscriptionWithTax — no VAT-free fallback).
            const u = await query<{
                stripe_customer_id: string | null;
                country: string | null;
                vat_number: string | null;
            }>(
                `SELECT s.stripe_customer_id, s.country, s.vat_number
                   FROM public.user_tier_state s
                  WHERE s.user_id = $1`,
                [userId],
            );
            // Company name for the invoice's "Bill to" block. Separate
            // query (not a JOIN above): user_tier_state and user_profiles
            // rows come into existence independently, and a missing
            // profiles row must not hide an existing stripe_customer_id
            // (that would mint a duplicate customer).
            let organisation: string | null = null;
            try {
                const p = await query<{ organisation: string | null }>(
                    `SELECT organisation FROM public.user_profiles WHERE user_id = $1`,
                    [userId],
                );
                organisation = p.rows[0]?.organisation ?? null;
            } catch (err) {
                console.warn(
                    "[billing/plus/checkout] organisation lookup failed (non-fatal):",
                    err instanceof Error ? err.message : err,
                );
            }
            // Billing details — name + country REQUIRED (tracker #33).
            // The checkout modal sends what the user confirmed; that wins
            // over anything stored. Older clients that send nothing fall
            // back to the stored country, and still cannot proceed
            // without one: the country must sit on the Stripe customer
            // BEFORE sub.create so the very first invoice carries VAT,
            // and it is persisted so renewals and plan changes keep
            // resolving the same tax location.
            const storedCountry = parseCountry(u.rows[0]?.country ?? null);
            const country = opts.billing?.country ?? storedCountry;
            if (!country) {
                res.status(400).json({
                    detail: "Billing country is required",
                    code: "COUNTRY_REQUIRED",
                });
                return;
            }
            if (opts.billing) {
                await persistBillingDetails(userId, opts.billing);
                if (opts.billing.organisation !== null || opts.billing.name) {
                    organisation = opts.billing.organisation ?? organisation;
                }
            } else if (country !== storedCountry) {
                await rememberCheckoutCountry(userId, country);
            }
            const vatNumber = opts.billing
                ? opts.billing.vatNumber
                : (u.rows[0]?.vat_number ?? null);
            // Stripe has ONE name field — the invoice "Bill to" line. A
            // company name takes it when given; otherwise the person's.
            const invoiceName = opts.billing
                ? (opts.billing.organisation ?? opts.billing.name)
                : organisation;
            let customerId = u.rows[0]?.stripe_customer_id ?? null;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    email: userEmail ?? undefined,
                    // Drives the language of Stripe-sent invoices,
                    // receipts and the portal's "auto" locale.
                    ...(opts.locale
                        ? { preferred_locales: [opts.locale] }
                        : {}),
                    // Full billing address when the modal supplied one
                    // (mandatory for a business — čl. 79. ZPDV); country
                    // alone for a natural person.
                    address: {
                        country,
                        ...(opts.billing?.addressLine1
                            ? { line1: opts.billing.addressLine1 }
                            : {}),
                        ...(opts.billing?.addressCity
                            ? { city: opts.billing.addressCity }
                            : {}),
                        ...(opts.billing?.addressPostalCode
                            ? { postal_code: opts.billing.addressPostalCode }
                            : {}),
                    },
                    ...(opts.billing?.phone
                        ? { phone: opts.billing.phone }
                        : {}),
                    metadata: {
                        max_user_id: userId,
                        wp_user_id: wpUserId != null ? String(wpUserId) : "",
                    },
                });
                customerId = customer.id;
                await rememberStripeCustomer(userId, customerId);
            } else {
                // Guard (tracker #34): a customer who already has a live
                // subscription must NOT get a second one. The in-app
                // upgrade path used to land here and mint a duplicate —
                // one customer ended up paying Pro AND Legal Pro for the
                // same weeks. Plan changes belong to /change-plan, which
                // prorates an upgrade immediately and schedules a
                // downgrade for the period end. Tell the client to go
                // there; create nothing.
                const live = await stripe.subscriptions.list({
                    customer: customerId,
                    status: "all",
                    limit: 20,
                });
                const liveSub = live.data.find((s) =>
                    ["active", "trialing", "past_due"].includes(s.status),
                );
                if (liveSub) {
                    res.status(409).json({
                        detail: "An active subscription already exists — change the plan instead",
                        code: "ACTIVE_SUBSCRIPTION_EXISTS",
                        action: "change_plan",
                        subscriptionId: liveSub.id,
                    });
                    return;
                }
                // Existing customer: make sure the country the user just
                // chose is what Stripe will tax against. This is NOT
                // best-effort — if the address write fails, automatic_tax
                // below fails too, and that error must reach the user
                // rather than be swallowed here.
                const existing = (await stripe.customers.retrieve(
                    customerId,
                )) as unknown as {
                    address?: {
                        country?: string | null;
                        line1?: string | null;
                        city?: string | null;
                        postal_code?: string | null;
                    } | null;
                };
                const ea = existing?.address ?? {};
                const wanted = {
                    country,
                    ...(opts.billing?.addressLine1
                        ? { line1: opts.billing.addressLine1 }
                        : {}),
                    ...(opts.billing?.addressCity
                        ? { city: opts.billing.addressCity }
                        : {}),
                    ...(opts.billing?.addressPostalCode
                        ? { postal_code: opts.billing.addressPostalCode }
                        : {}),
                };
                const differs =
                    (ea.country?.toUpperCase() ?? "") !== country ||
                    (wanted.line1 !== undefined && ea.line1 !== wanted.line1) ||
                    (wanted.city !== undefined && ea.city !== wanted.city) ||
                    (wanted.postal_code !== undefined &&
                        ea.postal_code !== wanted.postal_code);
                if (differs) {
                    await stripe.customers.update(customerId, { address: wanted });
                }
            }

            // 1b. Company name + VAT onto the customer BEFORE the
            //     subscription exists — the first invoice snapshots
            //     customer_name/customer_tax_ids at finalization, so a
            //     later sync would only fix the *next* invoice.
            //     Best-effort inside; never blocks checkout.
            await syncCustomerInvoiceDetails(customerId, {
                name: invoiceName,
                vatNumber,
                address: {
                    country,
                    line1: opts.billing?.addressLine1 ?? null,
                    city: opts.billing?.addressCity ?? null,
                    postal_code: opts.billing?.addressPostalCode ?? null,
                },
                phone: opts.billing?.phone ?? null,
            });

            // 2. Cancel any stale incomplete subscriptions so we don't
            //    pile up unpaid drafts when a user restarts checkout.
            const stale = await stripe.subscriptions.list({
                customer: customerId,
                status: "incomplete",
                limit: 10,
            });
            for (const old of stale.data) {
                try {
                    await stripe.subscriptions.cancel(old.id);
                } catch (cancelErr) {
                    console.warn(
                        "[billing/plus/checkout] failed to cancel stale subscription:",
                        cancelErr instanceof Error
                            ? cancelErr.message
                            : cancelErr,
                    );
                }
            }

            // 3. Create the new subscription with default_incomplete
            //    so the client must complete the PaymentIntent inside
            //    Stripe Elements before activation.
            //
            //    Tax: `automatic_tax` is mandatory. The customer already
            //    carries a validated billing country (above), so Stripe
            //    resolves the tax location on THIS invoice. There is no
            //    VAT-free fallback any more — see createSubscriptionWithTax.
            const trialDays = getTrialDays();

            const subParams = {
                customer: customerId,
                items: [
                    planDef.perSeat
                        ? { price: priceId, quantity: seats }
                        : { price: priceId },
                ],
                ...(promotionCodeId
                    ? { discounts: [{ promotion_code: promotionCodeId }] }
                    : {}),
                ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
                payment_behavior: "default_incomplete" as const,
                payment_settings: {
                    save_default_payment_method:
                        "on_subscription" as const,
                },
                expand: [
                    "latest_invoice.confirmation_secret",
                    "latest_invoice.payment_intent",
                    "pending_setup_intent",
                ],
                metadata: {
                    max_user_id: userId,
                    wp_user_id: wpUserId != null ? String(wpUserId) : "",
                    plan,
                    ...(planDef.perSeat ? { seats: String(seats) } : {}),
                },
            };
            const subscription = (await createSubscriptionWithTax(
                stripe,
                subParams,
            )) as unknown as {
                id: string;
                latest_invoice?: {
                    confirmation_secret?: { client_secret?: string | null };
                    payment_intent?: { client_secret?: string | null };
                    amount_due?: number | null;
                    subtotal?: number | null;
                    tax?: number | null;
                    currency?: string | null;
                } | null;
                pending_setup_intent?: { client_secret?: string | null } | null;
            };

            const inv = subscription.latest_invoice ?? null;
            const setupIntent = subscription.pending_setup_intent ?? null;

            const clientSecret =
                inv?.confirmation_secret?.client_secret ??
                inv?.payment_intent?.client_secret ??
                setupIntent?.client_secret ??
                null;
            if (!clientSecret) {
                console.error(
                    "[billing/plus/checkout] no clientSecret on new subscription",
                    subscription.id,
                );
                res.status(500).json({
                    detail: "Could not initialize payment — try again",
                });
                return;
            }
            const type = inv?.confirmation_secret || inv?.payment_intent
                ? "payment"
                : "setup";

            res.json({
                subscriptionId: subscription.id,
                clientSecret,
                type,
                amountDue: inv?.amount_due ?? 0,
                subtotal: inv?.subtotal ?? 0,
                taxAmount: inv?.tax ?? 0,
                currency: (inv?.currency ?? "eur").toUpperCase(),
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[billing/checkout:${plan}]`, msg);
            if (err instanceof TaxLocationError) {
                // Loud, typed, and NOT a subscription: the old code
                // answered this by creating one without VAT.
                res.status(400).json({ detail: msg, code: err.code });
                return;
            }
            res.status(500).json({ detail: msg });
        }
    }
}

/**
 * POST /billing/checkout — start a subscription for any paid plan.
 * Body: { plan: "plus"|"pro"|"team", seats?: number }. Team is per-seat
 * (min 5). Returns the same Stripe Elements payload as the Plus flow so
 * the frontend can render PaymentElement + confirmPayment unchanged.
 */
billingRouter.post(
    "/checkout",
    requireAuth,
    async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown> & {
            plan?: string;
            seats?: unknown;
            promo_code?: unknown;
        };
        const planDef = getPlanDef(String(body.plan ?? ""));
        if (!planDef) {
            res.status(400).json({ detail: "Unknown or missing plan" });
            return;
        }
        const billing = parseBillingDetails(body);
        if (!billing.ok) {
            res.status(400).json({ detail: billing.detail, code: billing.code });
            return;
        }
        const seats = clampSeats(planDef, body.seats);
        const promoCode =
            typeof body.promo_code === "string" ? body.promo_code : undefined;
        await runCheckout(planDef.plan, seats, res, {
            promoCode,
            locale: parseUiLocale(req),
            billing: billing.details,
        });
    },
);

/**
 * POST /billing/plus/checkout — backward-compatible Plus entry used by
 * the existing PlusUpgradeModal. Delegates to the general handler.
 */
billingRouter.post(
    "/plus/checkout",
    requireAuth,
    async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const billing = parseBillingDetails(body);
        if (!billing.ok) {
            res.status(400).json({ detail: billing.detail, code: billing.code });
            return;
        }
        const promoCode =
            typeof body.promo_code === "string" ? body.promo_code : undefined;
        await runCheckout("plus", 1, res, {
            promoCode,
            locale: parseUiLocale(req),
            billing: billing.details,
        });
    },
);

/**
 * Period end of a subscription. Since Stripe API 2025-03-31 (Basil) —
 * and our pinned 2025-09-30.clover — `current_period_end` lives on the
 * subscription *item*, not the subscription object itself. All our
 * plans are single-item subscriptions, so the first item's period end
 * is the subscription's. Typed structurally so it accepts the SDK's
 * Subscription without a cast.
 */
function subscriptionPeriodEnd(sub: {
    items?: { data?: { current_period_end?: number }[] };
}): number | null {
    return sub.items?.data?.[0]?.current_period_end ?? null;
}

/**
 * GET /billing/plus/status — quick view used by the account/billing
 * page. Reads the local override (auth middleware already trusts it)
 * and, if Stripe is configured, augments with the latest subscription
 * snapshot for cancel-at-period-end / next-renewal display.
 */
billingRouter.get(
    "/plus/status",
    requireAuth,
    async (_req: Request, res: Response) => {
        const userId = res.locals.userId as string;
        const tierLevelId = res.locals.tierLevelId as number | undefined;
        const u = await query<{
            stripe_customer_id: string | null;
            active_tier_level_id: number | null;
            active_tier_until: string | null;
        }>(
            `SELECT s.stripe_customer_id, s.active_tier_level_id, s.active_tier_until
               FROM public.user_tier_state s
              WHERE s.user_id = $1`,
            [userId],
        );
        const local = u.rows[0] ?? null;
        const activeLevel = local?.active_tier_level_id ?? null;
        // Plan name from the authoritative tier_level_id (free/plus/pro/team).
        const plan = activeLevel != null ? tierKeyForLevelId(activeLevel) : "free";

        let stripeView: Record<string, unknown> | null = null;
        if (isStripeConfigured() && local?.stripe_customer_id) {
            try {
                const subs = await getStripe().subscriptions.list({
                    customer: local.stripe_customer_id,
                    status: "all",
                    limit: 5,
                });
                const active = subs.data.find((s) =>
                    ["active", "trialing", "past_due"].includes(s.status),
                );
                if (active) {
                    stripeView = {
                        id: active.id,
                        status: active.status,
                        cancel_at_period_end: active.cancel_at_period_end,
                        current_period_end: subscriptionPeriodEnd(active),
                    };
                }
            } catch (err) {
                console.warn(
                    "[billing/plus/status] stripe lookup failed (non-fatal):",
                    err instanceof Error ? err.message : err,
                );
            }
        }

        res.json({
            plan,
            tierLevelId,
            activeTierUntil: local?.active_tier_until ?? null,
            subscription: stripeView,
        });
    },
);

/**
 * POST /billing/cancel — flag the caller's active subscription to end
 * at the period boundary. Works for every paid plan (the lookup is by
 * Stripe customer, not by product). We never cancel immediately so the
 * user keeps the plan until the date they already paid for; there is
 * no proration or refund. Idempotent: an already-cancelled renewal
 * returns the current state instead of an error.
 * `/plus/cancel` is kept as a backward-compatible alias.
 */
billingRouter.post(
    ["/cancel", "/plus/cancel"],
    requireAuth,
    async (_req: Request, res: Response) => {
        if (!isStripeConfigured()) {
            res.status(503).json({ detail: "Stripe not configured" });
            return;
        }
        const userId = res.locals.userId as string;
        const u = await query<{ stripe_customer_id: string | null }>(
            `SELECT s.stripe_customer_id
               FROM public.user_tier_state s
              WHERE s.user_id = $1`,
            [userId],
        );
        const customerId = u.rows[0]?.stripe_customer_id ?? null;
        if (!customerId) {
            res.status(404).json({ detail: "No Stripe customer for this user" });
            return;
        }
        try {
            const stripe = getStripe();
            const subs = await stripe.subscriptions.list({
                customer: customerId,
                status: "all",
                // 20, not 5: a pile of abandoned `incomplete` checkouts must
                // not push the one running subscription off the first page.
                limit: 20,
            });
            // Same "still running" statuses the /plus/status view uses, so
            // a trialing/past_due subscription can also stop its renewal.
            const active = subs.data.find((s) =>
                ["active", "trialing", "past_due"].includes(s.status),
            );
            if (!active) {
                res.status(404).json({ detail: "No active subscription" });
                return;
            }
            if (active.cancel_at_period_end) {
                // Already flagged — report the current state, don't error.
                res.json({
                    ok: true,
                    cancel_at_period_end: true,
                    current_period_end: subscriptionPeriodEnd(active),
                });
                return;
            }
            const updated = await stripe.subscriptions.update(active.id, {
                cancel_at_period_end: true,
            });
            res.json({
                ok: true,
                cancel_at_period_end: true,
                current_period_end: subscriptionPeriodEnd(updated),
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[billing/cancel]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// ── plan change (upgrade / downgrade with proration) ────────────────────────

/** Slice of a Stripe subscription item the change-plan route reads. */
type StripeSubItemLite = {
    id: string;
    quantity?: number | null;
    price?: {
        id?: string;
        product?: string | { id?: string } | null;
    } | null;
};

/**
 * POST /billing/change-plan — switch the caller's ACTIVE subscription
 * to another paid plan (#28). Body: { tier: PaidPlan, seats?: number }
 * (seats only meaningful for per-seat plans; clamped like checkout).
 *
 * Semantics, per Stripe's recommended flows:
 *   • UPGRADE (target ranks above the current plan) — update the
 *     subscription item in place with `proration_behavior:
 *     "always_invoice"` + `payment_behavior: "error_if_incomplete"`:
 *     the prorated difference is invoiced and charged immediately, and
 *     the `customer.subscription.updated` webhook activates the new
 *     tier right away (product → tier mapping already in place).
 *   • DOWNGRADE — never claw back entitlements the user already paid
 *     for: a subscription schedule (`create({ from_subscription })`,
 *     then a two-phase `update` with `end_behavior: "release"`) keeps
 *     the current price until the period end and flips to the new
 *     price at renewal. `proration_behavior: "none"` on both phases —
 *     no credits, no partial charges.
 *
 * VAT/tax mirrors checkout: upgrades try `automatic_tax` and retry
 * without it on tax-location errors (same class of failure
 * createSubscriptionWithTax enforces); the schedule path
 * inherits the subscription's own settings via `from_subscription`.
 *
 * Responses:
 *   200 { ok, action: "upgraded",  plan, effective: "now",        current_period_end }
 *   200 { ok, action: "scheduled", plan, effective: "period_end", current_period_end }
 *   200 { ok, action: "checkout" } — no active subscription; the client
 *       falls back to the normal checkout flow.
 *   400 { code: "UNKNOWN_PLAN" | "SAME_PLAN" }, 503 not configured.
 */
billingRouter.post(
    "/change-plan",
    requireAuth,
    async (req: Request, res: Response) => {
        if (!isStripeConfigured()) {
            res.status(503).json({ detail: "Stripe not configured" });
            return;
        }
        const body = (req.body ?? {}) as {
            tier?: string;
            seats?: unknown;
            country?: unknown;
        };
        const planDef = getPlanDef(String(body.tier ?? ""));
        if (!planDef) {
            res.status(400).json({
                detail: "Unknown or missing tier",
                code: "UNKNOWN_PLAN",
            });
            return;
        }
        if (!planDef.productId) {
            res.status(503).json({
                detail: `${planDef.plan} subscription is not configured`,
            });
            return;
        }
        const userId = res.locals.userId as string;
        try {
            const stripe = getStripe();
            const u = await query<{
                stripe_customer_id: string | null;
                country: string | null;
            }>(
                `SELECT s.stripe_customer_id, s.country
                   FROM public.user_tier_state s
                  WHERE s.user_id = $1`,
                [userId],
            );
            const customerId = u.rows[0]?.stripe_customer_id ?? null;
            if (!customerId) {
                res.json({ ok: true, action: "checkout" });
                return;
            }
            // Country is REQUIRED for a plan change too (tracker #33): the
            // prorated upgrade invoice is taxed the same way as checkout.
            // Body wins (the client may collect it); stored is the fallback.
            const storedCountry = parseCountry(u.rows[0]?.country ?? null);
            const country = parseCountry(body.country) ?? storedCountry;
            if (!country) {
                res.status(400).json({
                    detail: "Billing country is required",
                    code: "COUNTRY_REQUIRED",
                });
                return;
            }
            if (country !== storedCountry) {
                await rememberCheckoutCountry(userId, country);
            }
            const subs = await stripe.subscriptions.list({
                customer: customerId,
                status: "all",
                // Same rationale as /cancel: don't let abandoned
                // `incomplete` drafts push the live sub off page one.
                limit: 20,
            });
            const active = subs.data.find((s) =>
                ["active", "trialing", "past_due"].includes(s.status),
            );
            if (!active) {
                res.json({ ok: true, action: "checkout" });
                return;
            }
            const item = (active.items?.data?.[0] ??
                null) as StripeSubItemLite | null;
            if (!item) {
                throw new Error(`Subscription ${active.id} has no items`);
            }
            const rawProduct = item.price?.product;
            const currentProductId =
                typeof rawProduct === "string"
                    ? rawProduct
                    : rawProduct && typeof rawProduct === "object"
                      ? (rawProduct.id ?? null)
                      : null;
            const currentDef =
                planForProductId(currentProductId) ??
                planDefByKeyOrSlug(
                    (active.metadata as Record<string, string> | null)?.plan,
                );
            if (currentDef?.plan === planDef.plan) {
                res.status(400).json({
                    detail: "Already on this plan",
                    code: "SAME_PLAN",
                });
                return;
            }
            const newPriceId = await resolvePriceIdForPlan(planDef.plan);
            const seats = clampSeats(
                planDef,
                body.seats ?? item.quantity ?? undefined,
            );
            // Unknown current plan (legacy/manual product) → treat as an
            // upgrade: charge now, activate now. Never silently defer.
            const isUpgrade =
                !currentDef ||
                TIER_RANK[planDef.plan] > TIER_RANK[currentDef.plan];

            // A pending downgrade schedule blocks direct item updates and
            // must not survive a new decision either way — release it
            // (keeps the subscription running on its current phase).
            const rawSchedule = (
                active as unknown as {
                    schedule?: string | { id?: string } | null;
                }
            ).schedule;
            const scheduleId =
                typeof rawSchedule === "string"
                    ? rawSchedule
                    : (rawSchedule?.id ?? null);
            if (scheduleId) {
                try {
                    await stripe.subscriptionSchedules.release(scheduleId);
                } catch (relErr) {
                    console.warn(
                        "[billing/change-plan] schedule release failed (continuing):",
                        relErr instanceof Error ? relErr.message : relErr,
                    );
                }
            }

            if (isUpgrade) {
                const updateParams = {
                    items: [
                        {
                            id: item.id,
                            price: newPriceId,
                            quantity: planDef.perSeat ? seats : 1,
                        },
                    ],
                    proration_behavior: "always_invoice" as const,
                    // Fail the update if the prorated charge can't be
                    // collected — the user keeps their current plan
                    // instead of landing in past_due on the new one.
                    payment_behavior: "error_if_incomplete" as const,
                    cancel_at_period_end: false,
                    metadata: {
                        max_user_id: userId,
                        plan: planDef.plan,
                        ...(planDef.perSeat ? { seats: String(seats) } : {}),
                    },
                };
                // Country onto the customer BEFORE the update so Stripe
                // taxes the prorated invoice. Not best-effort — a failure
                // here must surface, never be swallowed.
                const cust = (await stripe.customers.retrieve(
                    customerId,
                )) as unknown as {
                    address?: { country?: string | null } | null;
                };
                if ((cust?.address?.country?.toUpperCase() ?? "") !== country) {
                    await stripe.customers.update(customerId, {
                        address: { country },
                    });
                }
                // automatic_tax is mandatory; no VAT-free retry (tracker #33).
                // This also repairs legacy subscriptions created without
                // tax: enabling it here means every renewal from now on
                // carries VAT.
                let updated;
                try {
                    updated = await stripe.subscriptions.update(active.id, {
                        ...updateParams,
                        automatic_tax: { enabled: true },
                    });
                } catch (taxErr) {
                    if (isTaxLocationError(taxErr)) {
                        res.status(400).json({
                            detail:
                                taxErr instanceof Error
                                    ? taxErr.message
                                    : "Stripe could not resolve a tax location",
                            code: "TAX_LOCATION_UNRESOLVED",
                        });
                        return;
                    }
                    throw taxErr;
                }
                res.json({
                    ok: true,
                    action: "upgraded",
                    plan: planDef.plan,
                    effective: "now",
                    current_period_end: subscriptionPeriodEnd(updated),
                });
                return;
            }

            // Downgrade — schedule the flip at period end. A pending
            // cancel-renewal is superseded by the explicit plan choice.
            if (active.cancel_at_period_end) {
                await stripe.subscriptions.update(active.id, {
                    cancel_at_period_end: false,
                });
            }
            const schedule = (await stripe.subscriptionSchedules.create({
                from_subscription: active.id,
            })) as unknown as {
                id: string;
                phases: Array<{
                    start_date: number;
                    end_date: number;
                    items: Array<{
                        price: string | { id: string };
                        quantity?: number | null;
                    }>;
                }>;
            };
            const phase0 = schedule.phases[0];
            if (!phase0) {
                throw new Error(`Schedule ${schedule.id} has no phases`);
            }
            // The new phase must state its duration (Basil replaced
            // `iterations` with `duration`); one billing cycle of the
            // new price, taken from the price's own recurrence.
            const newPrice = (await stripe.prices.retrieve(
                newPriceId,
            )) as unknown as {
                recurring?: {
                    interval?: "day" | "week" | "month" | "year";
                    interval_count?: number;
                } | null;
            };
            const phaseDuration = {
                interval: newPrice.recurring?.interval ?? "month",
                interval_count: newPrice.recurring?.interval_count ?? 1,
            };
            await stripe.subscriptionSchedules.update(schedule.id, {
                // After one cycle on the new price the schedule releases
                // and the subscription keeps renewing on that price.
                end_behavior: "release",
                phases: [
                    {
                        // Mirror the running phase exactly — current price
                        // until the period end the user already paid for.
                        items: phase0.items.map((it) => ({
                            price:
                                typeof it.price === "string"
                                    ? it.price
                                    : it.price.id,
                            ...(it.quantity != null
                                ? { quantity: it.quantity }
                                : {}),
                        })),
                        start_date: phase0.start_date,
                        end_date: phase0.end_date,
                        proration_behavior: "none" as const,
                    },
                    {
                        items: [
                            planDef.perSeat
                                ? { price: newPriceId, quantity: seats }
                                : { price: newPriceId },
                        ],
                        duration: phaseDuration,
                        proration_behavior: "none" as const,
                        metadata: {
                            max_user_id: userId,
                            plan: planDef.plan,
                        },
                    },
                ],
            });
            res.json({
                ok: true,
                action: "scheduled",
                plan: planDef.plan,
                effective: "period_end",
                current_period_end:
                    phase0.end_date ?? subscriptionPeriodEnd(active),
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[billing/change-plan]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

/**
 * POST /billing/portal — open a Stripe Customer Portal session for the
 * caller (invoices, payment method, plan changes, cancellation — all
 * Stripe-hosted, zero UI for us to maintain). Returns { url }.
 *
 * Requires an existing Stripe customer; users who never started a
 * checkout get a 404 and the frontend hides the button.
 */
billingRouter.post(
    "/portal",
    requireAuth,
    async (req: Request, res: Response) => {
        if (!isStripeConfigured()) {
            res.status(503).json({ detail: "Stripe not configured" });
            return;
        }
        const userId = res.locals.userId as string;
        const u = await query<{ stripe_customer_id: string | null }>(
            `SELECT s.stripe_customer_id
               FROM public.user_tier_state s
              WHERE s.user_id = $1`,
            [userId],
        );
        const customerId = u.rows[0]?.stripe_customer_id ?? null;
        if (!customerId) {
            res.status(404).json({
                detail: "No Stripe customer for this user",
                code: "NO_STRIPE_CUSTOMER",
            });
            return;
        }
        const locale = parseUiLocale(req);
        try {
            // Backfill preferred_locales on customers created before we
            // started setting it, so Stripe invoices/receipts follow the
            // app language too. Best-effort — the portal session below
            // gets an explicit locale either way.
            try {
                await getStripe().customers.update(customerId, {
                    preferred_locales: [locale],
                });
            } catch (syncErr) {
                console.warn(
                    "[billing/portal] preferred_locales sync failed (non-fatal):",
                    syncErr instanceof Error ? syncErr.message : syncErr,
                );
            }
            const session = await getStripe().billingPortal.sessions.create({
                customer: customerId,
                locale,
                return_url: `${billingFrontendBaseUrl()}/account/billing`,
            });
            res.json({ url: session.url });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[billing/portal]", msg);
            res.status(500).json({ detail: msg });
        }
    },
);

// ── webhook ───────────────────────────────────────────────────────────────
//
// Mounted SEPARATELY in index.ts with a raw body parser; the JSON body
// parser must NEVER touch this route or signature verification fails.
// We export the handler so index.ts can wire it up explicitly.

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
    if (!isStripeConfigured()) {
        res.status(503).send("Stripe not configured");
        return;
    }
    const secret = stripeWebhookSecret();
    if (!secret) {
        res.status(503).send("Webhook secret not configured");
        return;
    }
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
        res.status(400).send("Missing Stripe-Signature header");
        return;
    }
    let event: StripeWebhookEvent;
    try {
        // req.body is a Buffer thanks to the express.raw middleware in
        // index.ts. Using rawBody (string) trips the signature check.
        event = getStripe().webhooks.constructEvent(
            req.body as Buffer,
            sig,
            secret,
        ) as unknown as StripeWebhookEvent;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stripe/webhook] signature verify failed:", msg);
        res.status(400).send(`Webhook Error: ${msg}`);
        return;
    }

    try {
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded": {
                const session = event.data.object as StripeCheckoutSession;
                if (session.payment_status !== "paid") {
                    console.log(
                        `[stripe/webhook] skip ${event.id} — payment_status=${session.payment_status}`,
                    );
                    break;
                }
                await creditFromSession(session, event.id);
                break;
            }
            case "checkout.session.expired":
            case "checkout.session.async_payment_failed":
                console.log(
                    `[stripe/webhook] ignored ${event.type} session=${(event.data.object as StripeCheckoutSession).id}`,
                );
                break;

            // ── Plus subscription lifecycle ────────────────────────
            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.resumed":
            case "customer.subscription.trial_will_end":
            case "customer.subscription.deleted":
            case "customer.subscription.paused": {
                await applySubscriptionEvent(
                    event.type,
                    event.id,
                    event.data.object as StripeSubscriptionLite,
                );
                break;
            }
            case "invoice.paid":
            case "invoice.payment_succeeded": {
                // Invoice.paid is the most reliable activation signal
                // for recurring renewals — the Subscription event may
                // be slightly delayed. We re-resolve the parent
                // subscription and replay the same handler so the local
                // override gets a fresh `until` after each renewal.
                const inv = event.data.object as StripeInvoiceLite;
                const invSubId = invoiceSubscriptionId(inv);
                if (invSubId) {
                    try {
                        const sub = (await getStripe().subscriptions.retrieve(
                            invSubId,
                        )) as unknown as StripeSubscriptionLite;
                        await applySubscriptionEvent(event.type, event.id, sub);
                        // Revenue ledger — subscriptions only live in
                        // Stripe otherwise, so AdminMax analytics would
                        // undercount income (token packs land in
                        // user_token_credits via the checkout path).
                        await recordSubscriptionRevenue(inv, sub);
                    } catch (err) {
                        console.error(
                            "[stripe/webhook] invoice.paid → sub retrieve failed:",
                            err instanceof Error ? err.message : err,
                        );
                    }
                } else {
                    console.log(
                        `[stripe/webhook] ${event.type} invoice=${inv.id} has no subscription (one-off) — skipped`,
                    );
                }
                break;
            }
            case "invoice.payment_failed": {
                const inv = event.data.object as StripeInvoiceLite;
                console.warn(
                    `[stripe/webhook] invoice.payment_failed customer=${inv.customer} sub=${invoiceSubscriptionId(inv) ?? "—"}`,
                );
                // Dunning nudge — Stripe retries the charge on its own
                // schedule; we tell the user their card failed so they can
                // fix it before the subscription lapses. Idempotent per
                // invoice via the same order-email ledger.
                if (inv.customer) {
                    await sendPaymentFailedEmail(inv.customer, inv.id);
                }
                break;
            }
            default:
                // Stripe sends a lot of events we don't care about.
                // Acknowledge with 200 so it doesn't retry forever.
                break;
        }
        res.json({ received: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stripe/webhook] handler error:", msg);
        res.status(500).json({ detail: msg });
    }
}

/**
 * Translate a Stripe subscription event into:
 *   1. local `user_tier_state` update, and
 *   2. an internal push to the partner site (UMP).
 *
 * Idempotent. Stripe will retry on any non-2xx so the function MUST
 * stay safe to re-run with the same `event.id`. The push API on the
 * partner side dedupes by `request_id`.
 */
async function applySubscriptionEvent(
    eventType: string,
    eventId: string,
    sub: StripeSubscriptionLite,
): Promise<void> {
    if (!sub?.customer || !sub.id) {
        console.warn(`[stripe/webhook] ${eventType} missing fields`);
        return;
    }

    // Find the local user. Prefer the unique linkage; fall back to
    // metadata.max_user_id which we set on creation.
    let localUserId: string | null = null;
    let wpUserId: number | null = null;
    const byCustomer = await findUserByStripeCustomer(sub.customer);
    if (byCustomer) {
        localUserId = byCustomer.id;
        wpUserId = byCustomer.wp_user_id ?? null;
    } else if (sub.metadata?.max_user_id) {
        localUserId = sub.metadata.max_user_id;
        const wp = sub.metadata.wp_user_id;
        if (wp) {
            const parsed = parseInt(wp, 10);
            if (Number.isFinite(parsed)) wpUserId = parsed;
        }
        // First-seen — backfill the customer linkage.
        await rememberStripeCustomer(localUserId, sub.customer);
    }
    if (!localUserId) {
        console.warn(
            `[stripe/webhook] ${eventType} — no Eulex Desk user for customer=${sub.customer}, sub=${sub.id}`,
        );
        return;
    }

    const isActive = ["active", "trialing"].includes(sub.status);
    // Basil+ payloads carry the period end on the subscription item; the
    // top-level field only survives on events from pre-Basil API versions.
    const periodEndSec = subscriptionPeriodEnd(sub) ?? sub.current_period_end;
    const periodEnd = periodEndSec ? new Date(periodEndSec * 1000) : null;

    // Which paid plan is this? Map the subscription's product → tier so
    // Pro/Team land on their own level instead of always Plus.
    const planDef = resolveSubscriptionPlan(sub);
    const tierLevelId = planDef.tierLevelId;

    if (isActive) {
        await setLocalTierActive(
            localUserId,
            tierLevelId,
            periodEnd,
            {
                stripeCustomerId: sub.customer,
                stripeSubscriptionId: sub.id,
            },
            {
                source: "stripe",
                reason: `${eventType} plan=${planDef.plan} status=${sub.status}`,
            },
        );
        await replaceUmpUserLevels(localUserId, [
            {
                level_id: tierLevelId,
                expire_at: periodEnd,
                status: sub.status,
            },
        ]);
        // Team plan → provision (or refresh) the buyer's team with seats =
        // the subscription quantity, so they can start adding colleagues.
        if (planDef.plan === "team") {
            const seats = sub.items?.data?.[0]?.quantity ?? 5;
            try {
                await ensureTeamForOwner(localUserId, seats, sub.id);
            } catch (err) {
                console.error(
                    "[stripe/webhook] ensureTeamForOwner failed:",
                    err instanceof Error ? err.message : err,
                );
            }
        }
        if (wpUserId) {
            const payload: MembershipPushPayload = {
                wp_user_id: wpUserId,
                level_id: tierLevelId,
                action: "assign",
                expires_at: periodEnd ? periodEnd.toISOString() : null,
                stripe_customer_id: sub.customer,
                stripe_subscription_id: sub.id,
                reason: `${eventType} plan=${planDef.plan} status=${sub.status}`,
                request_id: eventId,
                sent_at: new Date().toISOString(),
            };
            await pushMembershipChange(payload);
        }
        // Order-confirmation email — once per NEW subscription. Two guards:
        //  • freshness: only subscriptions created in the last 24h, so an
        //    existing subscriber's first post-deploy renewal (empty ledger)
        //    doesn't wrongly get a "confirmed" email;
        //  • ledger: dedupes the several active-making events of that one new
        //    order (created → updated → invoice.paid all fire within minutes).
        const createdMs = sub.created ? sub.created * 1000 : 0;
        const isFreshOrder =
            createdMs > 0 && Date.now() - createdMs < 24 * 60 * 60 * 1000;
        if (
            isFreshOrder &&
            (await claimOrderEmail(sub.id, localUserId, planDef.plan))
        ) {
            const seats = planDef.perSeat
                ? sub.items?.data?.[0]?.quantity ?? null
                : null;
            await sendOrderConfirmationEmails({
                userId: localUserId,
                planName: PLAN_DISPLAY_NAME[planDef.plan] ?? planDef.plan,
                renewalDate: periodEnd,
                seats,
            });
            // Analytics: new subscription purchase completed. Fired exactly
            // once per order (same claimOrderEmail dedupe as the email).
            // NEVER pass customer id, email, Stripe ids, or monetary amounts.
            postEvent("purchase_completed", {
                tier: planDef.plan,
                kind: "subscription",
            });
        } else if (
            !isFreshOrder &&
            eventType === "customer.subscription.updated"
        ) {
            // Existing subscription activated/updated (renewal or plan change).
            // We emit the neutral "update" value because this branch covers
            // renewals, upgrades, AND downgrades equally. Distinguishing true
            // upgrade vs downgrade requires previous-tier tracking, which is a
            // future improvement. Cancels are handled in the else branch below.
            // Gated on the subscription.updated event only: one renewal also
            // replays this handler via invoice.paid AND invoice.payment_succeeded
            // (and trial_will_end lands here too), which would count the same
            // renewal 3+ times.
            // NEVER pass customer id, email, Stripe ids, or monetary amounts.
            postEvent("subscription_changed", {
                tier: planDef.plan,
                change: "update",
            });
        }
    } else {
        // canceled / unpaid / incomplete_expired / paused → revoke.
        await clearLocalTierOverride(localUserId, {
            source: "stripe",
            reason: `${eventType} plan=${planDef.plan} status=${sub.status}`,
        });
        if (wpUserId) {
            const payload: MembershipPushPayload = {
                wp_user_id: wpUserId,
                level_id: tierLevelId,
                action: "revoke",
                expires_at: null,
                stripe_customer_id: sub.customer,
                stripe_subscription_id: sub.id,
                reason: `${eventType} plan=${planDef.plan} status=${sub.status}`,
                request_id: eventId,
                sent_at: new Date().toISOString(),
            };
            await pushMembershipChange(payload);
        }
        // Analytics: subscription cancelled/revoked. Fire-and-forget, after
        // business logic. Gated on the terminal lifecycle events only:
        // this else-branch also runs for status "incomplete" (every fresh
        // checkout via payment_behavior: "default_incomplete") and for any
        // redelivered non-active event, which would emit phantom cancels.
        // deleted/paused each fire exactly once per real termination.
        // NEVER pass customer id, email, Stripe ids, amounts.
        if (
            eventType === "customer.subscription.deleted" ||
            eventType === "customer.subscription.paused"
        ) {
            postEvent("subscription_changed", {
                tier: planDef.plan,
                change: "cancel",
            });
        }
    }
}

/**
 * Credit a paid Checkout session into `user_token_credits`. Idempotent
 * via the UNIQUE constraint on `stripe_event_id`: if Stripe retries
 * (network glitch on our 200 reply), the second INSERT no-ops.
 */
async function creditFromSession(
    session: StripeCheckoutSession,
    eventId: string,
): Promise<void> {
    const meta = session.metadata ?? {};
    const userId = (meta.user_id ?? session.client_reference_id) as
        | string
        | null
        | undefined;
    const packId = meta.pack_id as string | undefined;
    const tokensFromMeta = meta.tokens ? Number(meta.tokens) : NaN;
    const tokens = Number.isFinite(tokensFromMeta) && tokensFromMeta > 0
        ? Math.floor(tokensFromMeta)
        : packId
          ? findPack(packId)?.tokens ?? 0
          : 0;
    if (!userId) {
        console.warn(
            `[stripe/webhook] session=${session.id} missing user_id — skipping`,
        );
        return;
    }
    if (!tokens || tokens <= 0) {
        console.warn(
            `[stripe/webhook] session=${session.id} no token amount — skipping`,
        );
        return;
    }
    const amountCents = session.amount_total ?? null;
    try {
        const result = await query<{ id: string }>(
            `INSERT INTO public.user_token_credits
                (user_id, tokens_granted, payment_method, external_reference,
                 stripe_event_id, amount_eur_cents, notes)
             VALUES ($1, $2, 'stripe', $3, $4, $5, $6)
             ON CONFLICT (stripe_event_id) DO NOTHING
             RETURNING id`,
            [
                userId,
                tokens,
                session.id,
                eventId,
                amountCents,
                packId ? `Stripe Checkout · ${packId}` : "Stripe Checkout",
            ],
        );
        if (result.rows.length > 0) {
            console.log(
                `[stripe/webhook] credited user=${userId} tokens=${tokens} session=${session.id} grant=${result.rows[0].id}`,
            );
            // Analytics: token-pack purchase completed. The INSERT dedupe
            // above ensures this fires exactly once per purchase.
            // No tier here — only Plus users can buy packs, but we don't
            // re-resolve tier inside creditFromSession; omit it.
            // NEVER pass amount, session id, user id, or Stripe ids.
            postEvent("purchase_completed", { kind: "topup" });
            // Token-pack order confirmation. The credit insert above is the
            // dedupe (ON CONFLICT skips replays), so we only land here once.
            const packLabel =
                (packId ? findPack(packId)?.label : null) ?? "Token paket";
            await sendOrderConfirmationEmails({
                userId,
                planName: packLabel,
                amountCents: amountCents ?? null,
                tokens,
            });
        } else {
            console.log(
                `[stripe/webhook] duplicate event=${eventId} user=${userId} — already credited`,
            );
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[stripe/webhook] credit insert failed:", msg);
        throw err;
    }
}

// ── Order-confirmation email (Stripe success) ─────────────────────────────
//
// On a successful order we email the customer AND info@eulex.ai, reusing
// the chat-share email design (templates/orderConfirmation.ts). Idempotent
// per order via the billing_order_emails ledger so subscription renewals /
// repeated webhook events don't re-send. All failures are swallowed — a
// missing confirmation must NEVER fail the webhook (Stripe would retry the
// whole tier activation).

const ORDER_NOTIFY_EMAIL = "info@eulex.ai";

const PLAN_DISPLAY_NAME: Record<string, string> = {
    plus: "Eulex Plus",
    pro: "Pro",
    team: "Team",
    legal_pro: "Legal Pro",
    eulex_legal_team: "Eulex Legal Team",
};

function billingFrontendBaseUrl(): string {
    // FRONTEND_URL is a comma-separated CORS-origins list; take the first
    // (the public domain), same as the chat-share link builder.
    const first =
        (process.env.FRONTEND_URL ?? "http://localhost:3000")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)[0] ?? "http://localhost:3000";
    return first.replace(/\/+$/, "");
}

/**
 * Claim the right to send the order-confirmation email for `orderKey`
 * (subscription id, or checkout session id for token packs). Returns true
 * exactly once per key — renewals and retried webhooks get false.
 */
async function claimOrderEmail(
    orderKey: string,
    userId: string,
    plan: string,
): Promise<boolean> {
    try {
        const r = await query<{ order_key: string }>(
            `INSERT INTO public.billing_order_emails (order_key, user_id, plan)
             VALUES ($1, $2, $3)
             ON CONFLICT (order_key) DO NOTHING
             RETURNING order_key`,
            [orderKey, userId, plan],
        );
        return r.rows.length > 0;
    } catch (err) {
        // If the ledger write fails, prefer NOT sending (risking a missed
        // mail) over crashing the webhook or double-sending.
        console.error(
            "[billing/order-email] claim failed:",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

function fmtOrderDate(d: Date, lang: "hr" | "en"): string {
    try {
        return new Intl.DateTimeFormat(lang === "hr" ? "hr-HR" : "en-US", {
            day: "numeric",
            month: "long",
            year: "numeric",
        }).format(d);
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

function fmtOrderAmount(cents: number, lang: "hr" | "en"): string {
    try {
        return new Intl.NumberFormat(lang === "hr" ? "hr-HR" : "en-US", {
            style: "currency",
            currency: "EUR",
        }).format(cents / 100);
    } catch {
        return `${(cents / 100).toFixed(2)} €`;
    }
}

function orderDetailLines(
    lang: "hr" | "en",
    opts: {
        renewalDate?: Date | null;
        amountCents?: number | null;
        seats?: number | null;
        tokens?: number | null;
    },
): string[] {
    const L =
        lang === "hr"
            ? { renews: "Obnova", amount: "Iznos", seats: "Mjesta", tokens: "Tokeni" }
            : { renews: "Renews", amount: "Amount", seats: "Seats", tokens: "Tokens" };
    const lines: string[] = [];
    if (opts.amountCents != null && opts.amountCents > 0)
        lines.push(`${L.amount}: ${fmtOrderAmount(opts.amountCents, lang)}`);
    if (opts.tokens != null && opts.tokens > 0)
        lines.push(
            `${L.tokens}: ${new Intl.NumberFormat(
                lang === "hr" ? "hr-HR" : "en-US",
            ).format(opts.tokens)}`,
        );
    if (opts.seats != null && opts.seats > 1)
        lines.push(`${L.seats}: ${opts.seats}`);
    if (opts.renewalDate)
        lines.push(`${L.renews}: ${fmtOrderDate(opts.renewalDate, lang)}`);
    return lines;
}

/**
 * Send the customer + info@eulex.ai order-confirmation emails. Best-effort:
 * logs and returns on any failure (never throws into the webhook).
 */
async function sendOrderConfirmationEmails(opts: {
    userId: string;
    planName: string;
    renewalDate?: Date | null;
    amountCents?: number | null;
    seats?: number | null;
    tokens?: number | null;
}): Promise<void> {
    try {
        const u = await query<{
            email: string | null;
            display_name: string | null;
            preferred_language: string | null;
        }>(
            `SELECT email, display_name, preferred_language
               FROM public.users WHERE id = $1`,
            [opts.userId],
        );
        const row = u.rows[0];
        const customerEmail = row?.email?.trim();
        if (!customerEmail) {
            console.warn(
                `[billing/order-email] no email for user=${opts.userId} — skipping`,
            );
            return;
        }
        const lang: "hr" | "en" = row?.preferred_language === "hr" ? "hr" : "en";
        const name = row?.display_name ?? undefined;
        const base = billingFrontendBaseUrl();
        const provider = getEmailProvider();

        // Customer copy — in the user's language.
        const cust = renderOrderConfirmationEmail({
            audience: "customer",
            customerEmail,
            customerName: row?.display_name ?? null,
            planName: opts.planName,
            detailLines: orderDetailLines(lang, opts),
            ctaUrl: `${base}/assistant`,
            lang,
        });
        await provider.send({
            to: { email: customerEmail, name },
            subject: cust.subject,
            html: cust.html,
            text: cust.text,
            replyTo: { email: ORDER_NOTIFY_EMAIL, name: "EULEX" },
            tags: ["order-confirmation"],
        });

        // Internal copy → info@eulex.ai (always Croatian).
        const admin = renderOrderConfirmationEmail({
            audience: "admin",
            customerEmail,
            customerName: row?.display_name ?? null,
            planName: opts.planName,
            detailLines: orderDetailLines("hr", opts),
            ctaUrl: `${base}/adminmax`,
            lang: "hr",
        });
        await provider.send({
            to: { email: ORDER_NOTIFY_EMAIL, name: "EULEX" },
            subject: admin.subject,
            html: admin.html,
            text: admin.text,
            replyTo: { email: customerEmail, name },
            tags: ["order-confirmation-admin"],
        });
        console.log(
            `[billing/order-email] sent customer=${customerEmail} → info@eulex.ai plan="${opts.planName}"`,
        );
    } catch (err) {
        console.error(
            "[billing/order-email] send failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Resolve the customer-facing promotion code (e.g. "HOK2026") that
 * discounted an invoice, or null when the invoice carries no discount.
 * Webhook payloads only embed discount IDs, so a discounted invoice is
 * re-retrieved with the promotion code expanded (one extra API call,
 * discounted invoices only). Falls back to the coupon id when the
 * discount was applied directly via coupon (no promotion code).
 * Best-effort: attribution must never fail the revenue insert.
 */
async function resolveInvoicePromoCode(
    inv: StripeInvoiceLite,
): Promise<string | null> {
    if (!Array.isArray(inv.discounts) || inv.discounts.length === 0) {
        return null;
    }
    try {
        const full = await getStripe().invoices.retrieve(inv.id, {
            expand: ["discounts.promotion_code"],
        });
        for (const d of full.discounts ?? []) {
            if (typeof d === "string" || !("promotion_code" in d)) continue;
            const pc = d.promotion_code;
            if (pc && typeof pc === "object" && pc.code) return pc.code;
            // Discount without a promotion code (coupon attached
            // directly) — API ≥ clover nests it under source.coupon.
            const coupon = d.source?.coupon;
            if (coupon && typeof coupon === "object") {
                return coupon.name ?? coupon.id;
            }
            if (typeof coupon === "string") return coupon;
        }
        return null;
    } catch (err) {
        console.error(
            "[stripe/webhook] promo-code resolve failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

/**
 * Persist a paid subscription invoice into the revenue ledger
 * (public.billing_revenue). Idempotent via the UNIQUE stripe_invoice_id
 * — Stripe replays both invoice.paid and invoice.payment_succeeded for
 * the same invoice and the second insert no-ops. Zero-amount invoices
 * (trials, full credit-balance coverage) are skipped. Best-effort: a
 * ledger failure must never fail the webhook (tier activation already
 * happened).
 */
async function recordSubscriptionRevenue(
    inv: StripeInvoiceLite,
    sub: StripeSubscriptionLite,
): Promise<boolean> {
    const amount = Math.floor(Number(inv.amount_paid ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) return false;
    try {
        const planDef = resolveSubscriptionPlan(sub);
        const user = await findUserByStripeCustomer(inv.customer);
        const paidAt = inv.created
            ? new Date(inv.created * 1000).toISOString()
            : new Date().toISOString();
        const promoCode = await resolveInvoicePromoCode(inv);
        const result = await query<{ id: string }>(
            `INSERT INTO public.billing_revenue (
                user_id, stripe_customer_id, stripe_invoice_id,
                stripe_subscription_id, plan, amount_cents, currency,
                paid_at, promo_code
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (stripe_invoice_id) DO NOTHING
             RETURNING id`,
            [
                user?.id ?? null,
                inv.customer,
                inv.id,
                sub.id,
                planDef.plan,
                amount,
                (inv.currency ?? "eur").toLowerCase(),
                paidAt,
                promoCode,
            ],
        );
        if (result.rows.length > 0) {
            console.log(
                `[stripe/webhook] revenue recorded invoice=${inv.id} plan=${planDef.plan} amount=${amount} ${inv.currency ?? "eur"}`,
            );
            return true;
        }
        return false;
    } catch (err) {
        console.error(
            "[stripe/webhook] revenue ledger insert failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

/**
 * One-shot repair: walk paid Stripe invoices from the last `days` days
 * and insert any subscription revenue missing from billing_revenue
 * (idempotent — same ON CONFLICT path the webhook uses). Exists because
 * the Basil API change (invoice.subscription → parent.subscription_details)
 * silently disabled the webhook's ledger insert for a while. Exposed via
 * POST /adminmax/billing/backfill-revenue.
 */
export async function backfillSubscriptionRevenue(days: number): Promise<{
    scanned: number;
    inserted: number;
    skipped_no_subscription: number;
    skipped_zero_amount: number;
    failed: number;
}> {
    const stripe = getStripe();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const subCache = new Map<string, StripeSubscriptionLite>();
    let scanned = 0;
    let inserted = 0;
    let skippedNoSub = 0;
    let skippedZero = 0;
    let failed = 0;
    for await (const raw of stripe.invoices.list({
        status: "paid",
        created: { gte: since },
        limit: 100,
    })) {
        scanned += 1;
        const inv = raw as unknown as StripeInvoiceLite;
        const subId = invoiceSubscriptionId(inv);
        if (!subId) {
            skippedNoSub += 1;
            continue;
        }
        if (!inv.amount_paid || inv.amount_paid <= 0) {
            skippedZero += 1;
            continue;
        }
        try {
            let sub = subCache.get(subId);
            if (!sub) {
                sub = (await stripe.subscriptions.retrieve(
                    subId,
                )) as unknown as StripeSubscriptionLite;
                subCache.set(subId, sub);
            }
            if (await recordSubscriptionRevenue(inv, sub)) inserted += 1;
        } catch (err) {
            failed += 1;
            console.error(
                `[billing/backfill-revenue] invoice=${inv.id} failed:`,
                err instanceof Error ? err.message : err,
            );
        }
    }
    console.log(
        `[billing/backfill-revenue] days=${days} scanned=${scanned} inserted=${inserted} no_sub=${skippedNoSub} zero=${skippedZero} failed=${failed}`,
    );
    return {
        scanned,
        inserted,
        skipped_no_subscription: skippedNoSub,
        skipped_zero_amount: skippedZero,
        failed,
    };
}

/**
 * "Your payment failed" dunning email. Best-effort and idempotent per
 * invoice (billing_order_emails ledger, key `payment_failed:<invoice>`)
 * — Stripe re-sends the event on retries and we must not spam.
 */
async function sendPaymentFailedEmail(
    stripeCustomerId: string,
    invoiceId: string,
): Promise<void> {
    try {
        const user = await findUserByStripeCustomer(stripeCustomerId);
        if (!user) {
            console.warn(
                `[billing/payment-failed-email] no Eulex Desk user for customer=${stripeCustomerId}`,
            );
            return;
        }
        if (
            !(await claimOrderEmail(
                `payment_failed:${invoiceId}`,
                user.id,
                "payment_failed",
            ))
        ) {
            return; // already notified for this invoice
        }
        const u = await query<{
            email: string | null;
            display_name: string | null;
            preferred_language: string | null;
        }>(
            `SELECT email, display_name, preferred_language
               FROM public.users WHERE id = $1`,
            [user.id],
        );
        const row = u.rows[0];
        const email = row?.email?.trim();
        if (!email) return;
        const lang: "hr" | "en" = row?.preferred_language === "hr" ? "hr" : "en";
        const base = billingFrontendBaseUrl();
        const L =
            lang === "hr"
                ? {
                      subject: "Naplata nije uspjela — provjerite način plaćanja",
                      hi: `Pozdrav${row?.display_name ? ` ${row.display_name}` : ""},`,
                      body: "Pokušaj naplate vaše Eulex pretplate nije uspio. Stripe će automatski pokušati ponovno; da pretplata ne bi istekla, provjerite karticu u postavkama računa.",
                      cta: "Otvori postavke plaćanja",
                  }
                : {
                      subject: "Payment failed — please check your payment method",
                      hi: `Hi${row?.display_name ? ` ${row.display_name}` : ""},`,
                      body: "We could not charge your Eulex subscription. Stripe will retry automatically; to keep your plan active, please review your card in account settings.",
                      cta: "Open billing settings",
                  };
        const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px;">
        <h1 style="font-size:17px;color:#0f172a;margin:0 0 12px;">${L.subject}</h1>
        <p style="font-size:14px;color:#334155;">${L.hi}</p>
        <p style="font-size:14px;color:#334155;">${L.body}</p>
        <p style="margin-top:20px;"><a href="${base}/account?tab=billing" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-size:13px;padding:10px 18px;border-radius:8px;">${L.cta}</a></p>
    </div>
</body></html>`;
        await getEmailProvider().send({
            to: { email, name: row?.display_name ?? undefined },
            subject: L.subject,
            html,
            text: `${L.hi}\n\n${L.body}\n\n${base}/account?tab=billing`,
            replyTo: { email: ORDER_NOTIFY_EMAIL, name: "EULEX" },
            tags: ["payment-failed"],
        });
        console.log(
            `[billing/payment-failed-email] sent to ${email} invoice=${invoiceId}`,
        );
    } catch (err) {
        console.error(
            "[billing/payment-failed-email] failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Bare-bones middleware that turns the raw body parser into a single
 * Express layer. Exported so index.ts can mount it before the JSON
 * parser without re-implementing the wiring.
 */
export const stripeRawBodyParser = express.raw({ type: "application/json" });
