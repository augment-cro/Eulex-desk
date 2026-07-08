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
    resolvePriceIdForPlan,
    stripeWebhookSecret,
    type PaidPlan,
    type PlanDef,
} from "../lib/stripe";
import { can, getEntitlements, tierKeyForLevelId } from "../lib/entitlements";
import { ensureTeamForOwner } from "../lib/teams";
import { getPlanCatalog } from "../lib/planCatalog";
import {
    clearLocalTierOverride,
    findUserByStripeCustomer,
    getFreeTierLevelId,
    isPartnerPushConfigured,
    pushMembershipChange,
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
    status?: string | null;
    /** Cents actually collected — 0 for trial/credit-balance invoices. */
    amount_paid?: number | null;
    currency?: string | null;
    /** Unix seconds the invoice was created (≈ payment time for paid). */
    created?: number | null;
    metadata?: Record<string, string> | null;
};

export const billingRouter = Router();

/**
 * Create a Plus subscription, preferring `automatic_tax: enabled`.
 *
 * On a brand-new Stripe customer Stripe will throw when it can't
 * derive a tax location (no address on file, no IP geolocation match)
 * — we don't collect billing address until Stripe Elements renders,
 * so this is the common case for first-time checkout. We catch that
 * specific class of failure and retry without `automatic_tax`. The
 * webhook will re-enable tax on the next renewal once the address is
 * known.
 *
 * Any other Stripe error bubbles up unchanged so the caller still
 * surfaces the original message to the user.
 */
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

async function createSubscriptionWithTaxFallback(
    stripe: ReturnType<typeof getStripe>,
    baseParams: Record<string, unknown>,
): Promise<unknown> {
    try {
        return await stripe.subscriptions.create({
            ...baseParams,
            automatic_tax: { enabled: true },
        } as Parameters<typeof stripe.subscriptions.create>[0]);
    } catch (err) {
        if (!isTaxLocationError(err)) throw err;
        console.warn(
            "[billing/plus/checkout] automatic_tax failed (no address yet), retrying without:",
            err instanceof Error ? err.message : err,
        );
        return await stripe.subscriptions.create(
            baseParams as Parameters<typeof stripe.subscriptions.create>[0],
        );
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
        const successBase =
            process.env.FRONTEND_URL?.trim() ?? "https://max.eulex.ai";
        try {
            const session = await getStripe().checkout.sessions.create({
                mode: "payment",
                payment_method_types: ["card"],
                line_items: [{ price: pack.priceId, quantity: 1 }],
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
    opts: { promoCode?: string } = {},
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
            //    (see createSubscriptionWithTaxFallback).
            const u = await query<{
                stripe_customer_id: string | null;
                country: string | null;
            }>(
                `SELECT s.stripe_customer_id, s.country
                   FROM public.user_tier_state s
                  WHERE s.user_id = $1`,
                [userId],
            );
            const country = (u.rows[0]?.country ?? "").trim();
            const hasCountry = /^[A-Z]{2}$/.test(country);
            let customerId = u.rows[0]?.stripe_customer_id ?? null;
            if (!customerId) {
                const customer = await stripe.customers.create({
                    email: userEmail ?? undefined,
                    ...(hasCountry
                        ? { address: { country } }
                        : {}),
                    metadata: {
                        max_user_id: userId,
                        wp_user_id: wpUserId != null ? String(wpUserId) : "",
                    },
                });
                customerId = customer.id;
                await rememberStripeCustomer(userId, customerId);
            } else if (hasCountry) {
                // Existing customer that may have been created before we
                // started capturing country. Patch the address only if
                // it's not already set so we never overwrite Stripe
                // Elements' captured billing address.
                try {
                    const existing = (await stripe.customers.retrieve(
                        customerId,
                    )) as unknown as {
                        address?: { country?: string | null } | null;
                    };
                    const existingCountry =
                        existing?.address?.country?.toUpperCase() ?? "";
                    if (existingCountry !== country) {
                        await stripe.customers.update(customerId, {
                            address: { country },
                        });
                    }
                } catch (lookupErr) {
                    console.warn(
                        "[billing/plus/checkout] customer address sync failed (non-fatal):",
                        lookupErr instanceof Error
                            ? lookupErr.message
                            : lookupErr,
                    );
                }
            }

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
            //    Tax handling: try with automatic_tax first; if Stripe
            //    rejects because the customer has no recognised address
            //    (very common on first checkout — we never collect
            //    address before this call), retry without automatic_tax
            //    so the user can actually pay. Tax is then resolved on
            //    the next renewal once Stripe's PaymentElement has
            //    captured the billing address.
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
            const subscription = (await createSubscriptionWithTaxFallback(
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
        const body = (req.body ?? {}) as {
            plan?: string;
            seats?: unknown;
            promo_code?: unknown;
        };
        const planDef = getPlanDef(String(body.plan ?? ""));
        if (!planDef) {
            res.status(400).json({ detail: "Unknown or missing plan" });
            return;
        }
        const seats = clampSeats(planDef, body.seats);
        const promoCode =
            typeof body.promo_code === "string" ? body.promo_code : undefined;
        await runCheckout(planDef.plan, seats, res, { promoCode });
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
        const promoCode =
            typeof req.body?.promo_code === "string"
                ? req.body.promo_code
                : undefined;
        await runCheckout("plus", 1, res, { promoCode });
    },
);

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
                        current_period_end:
                            (active as unknown as { current_period_end?: number })
                                .current_period_end ?? null,
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
 * POST /billing/plus/cancel — flag the active subscription to end at
 * the period boundary. We never cancel immediately so the user keeps
 * Plus until the date they already paid for.
 */
billingRouter.post(
    "/plus/cancel",
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
                status: "active",
                limit: 5,
            });
            const active = subs.data[0];
            if (!active) {
                res.status(404).json({ detail: "No active subscription" });
                return;
            }
            const updated = (await stripe.subscriptions.update(active.id, {
                cancel_at_period_end: true,
            })) as unknown as { current_period_end?: number };
            res.json({
                ok: true,
                cancel_at_period_end: true,
                current_period_end: updated.current_period_end ?? null,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("[billing/plus/cancel]", msg);
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
            res.status(404).json({
                detail: "No Stripe customer for this user",
                code: "NO_STRIPE_CUSTOMER",
            });
            return;
        }
        try {
            const session = await getStripe().billingPortal.sessions.create({
                customer: customerId,
                return_url: `${billingFrontendBaseUrl()}/account?tab=billing`,
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
                if (inv.subscription) {
                    try {
                        const sub = (await getStripe().subscriptions.retrieve(
                            inv.subscription,
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
                }
                break;
            }
            case "invoice.payment_failed": {
                const inv = event.data.object as StripeInvoiceLite;
                console.warn(
                    `[stripe/webhook] invoice.payment_failed customer=${inv.customer} sub=${inv.subscription ?? "—"}`,
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
    const periodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null;

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
): Promise<void> {
    const amount = Math.floor(Number(inv.amount_paid ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
        const planDef = resolveSubscriptionPlan(sub);
        const user = await findUserByStripeCustomer(inv.customer);
        const paidAt = inv.created
            ? new Date(inv.created * 1000).toISOString()
            : new Date().toISOString();
        const result = await query<{ id: string }>(
            `INSERT INTO public.billing_revenue (
                user_id, stripe_customer_id, stripe_invoice_id,
                stripe_subscription_id, plan, amount_cents, currency, paid_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
            ],
        );
        if (result.rows.length > 0) {
            console.log(
                `[stripe/webhook] revenue recorded invoice=${inv.id} plan=${planDef.plan} amount=${amount} ${inv.currency ?? "eur"}`,
            );
        }
    } catch (err) {
        console.error(
            "[stripe/webhook] revenue ledger insert failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
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
