/**
 * Stripe client + Eulex Plus token-pack catalog.
 *
 * The catalog is server-side only — frontends ask the backend for the
 * list with `GET /billing/topup/packs` and never see Stripe Price IDs.
 * That keeps Price IDs (which differ per env: test vs live) out of the
 * client bundle and makes pricing changes a backend deploy, not a
 * frontend rebuild.
 *
 * The 1M / 3M packs map to Stripe Prices (`price_xxx`) provided via
 * env. If a pack is missing its env var it's silently dropped from
 * the public list — that's the toggle to disable Stripe top-up at
 * runtime without code changes.
 *
 * @module stripe
 */

import Stripe from "stripe";

// We don't use Stripe namespace types directly — moduleResolution=node
// drops them on the floor. `InstanceType<typeof Stripe>` recovers the
// runtime shape (which is what the SDK methods return anyway).
type StripeClient = InstanceType<typeof Stripe>;

let _client: StripeClient | null = null;

/**
 * Lazily-initialised Stripe client. Uses the published `apiVersion`
 * pin (Sep 2025 release) so the typed responses we rely on don't
 * silently shift on the next dashboard upgrade.
 */
export function getStripe(): StripeClient {
    if (_client) return _client;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    _client = new Stripe(key, {
        // Pin to a fixed API version so account-level upgrades on the
        // Stripe dashboard don't change shapes underneath us. Cast
        // through `any` because the LatestApiVersion type alias is not
        // re-exported via the CJS resolution path TS uses here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        apiVersion: "2025-09-30.clover" as any,
    });
    return _client;
}

export function isStripeConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
}

export function stripeWebhookSecret(): string | null {
    return process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;
}

// ---------------------------------------------------------------------------
// Pack catalog
// ---------------------------------------------------------------------------

export type TokenPack = {
    /** Stable slug shipped to the frontend; used as Checkout client_reference. */
    id: string;
    /** Tokens credited on successful payment. */
    tokens: number;
    /** Display label / description used by the UI. */
    label: string;
    description: string;
    /** Stripe Price ID (price_xxx). Resolved from env. */
    priceId: string;
    /** Frontend-facing price hint (purely cosmetic; Stripe is the truth). */
    amountEurDisplay: number;
};

/**
 * Resolve the public catalog from environment variables. Each pack is
 * enabled iff its `STRIPE_PACK_*_PRICE_ID` env var is set; missing
 * vars hide the pack — useful for staging where only the 1M is wired.
 */
export function getTokenPacks(): TokenPack[] {
    const packs: TokenPack[] = [];
    const p1m = process.env.STRIPE_PACK_1M_PRICE_ID?.trim();
    if (p1m) {
        packs.push({
            id: "tokens_1m",
            tokens: 1_000_000,
            label: "1.000.000 tokena",
            description:
                "Dodatak na vaš Plus plan — vrijedi neograničeno, troši se nakon dnevnog limita.",
            priceId: p1m,
            amountEurDisplay: Number(
                process.env.STRIPE_PACK_1M_AMOUNT_EUR ?? 9,
            ),
        });
    }
    const p3m = process.env.STRIPE_PACK_3M_PRICE_ID?.trim();
    if (p3m) {
        packs.push({
            id: "tokens_3m",
            tokens: 3_000_000,
            label: "3.000.000 tokena",
            description:
                "Veliki paket za intenzivne mjesece — najbolja cijena po tokenu.",
            priceId: p3m,
            amountEurDisplay: Number(
                process.env.STRIPE_PACK_3M_AMOUNT_EUR ?? 24,
            ),
        });
    }
    return packs;
}

export function findPack(packId: string): TokenPack | undefined {
    return getTokenPacks().find((p) => p.id === packId);
}

// ---------------------------------------------------------------------------
// Plus subscription
// ---------------------------------------------------------------------------
//
// The Eulex Desk app owns the Plus subscription end-to-end: it creates the
// Stripe Subscription, owns the webhook, and propagates membership
// changes to the partner site over a small internal push API.
// See backend/src/lib/membership.ts and the /billing/plus/* routes.

/**
 * Stripe Product that represents Eulex Plus. Configured at runtime
 * via env so the same code can run against test (`prod_…test`) and
 * live (`prod_…live`) without a deploy.
 */
export function getPlusProductId(): string | null {
    return process.env.STRIPE_PLUS_PRODUCT_ID?.trim() || null;
}

/** Stripe Product for Eulex Pro (prod_…). Configured via env per environment. */
export function getProProductId(): string | null {
    return process.env.STRIPE_PRO_PRODUCT_ID?.trim() || null;
}

/** Stripe Product for Eulex Team (prod_…, billed per seat). */
export function getTeamProductId(): string | null {
    return process.env.STRIPE_TEAM_PRODUCT_ID?.trim() || null;
}

/** Stripe Product for Legal Pro (prod_…). Configured via env per environment. */
export function getLegalProProductId(): string | null {
    return process.env.STRIPE_LEGAL_PRO_PRODUCT_ID?.trim() || null;
}

/** Stripe Product for Eulex Legal Team (prod_…, per seat). Env-configured. */
export function getEulexLegalTeamProductId(): string | null {
    return process.env.STRIPE_EULEX_LEGAL_TEAM_PRODUCT_ID?.trim() || null;
}

/**
 * Optional pin on a specific Price ID for Plus. Useful when the
 * product has multiple prices (monthly/annual/promo) and you want
 * checkout to always pick one. If unset, we resolve the product's
 * `default_price` from the Stripe dashboard at runtime.
 */
export function getPlusPriceIdOverride(): string | null {
    return process.env.STRIPE_PLUS_PRICE_ID?.trim() || null;
}

/**
 * Resolve the active Price ID for Plus checkout.
 *
 *   1. STRIPE_PLUS_PRICE_ID (explicit env pin) wins.
 *   2. Otherwise read `Product.default_price` from Stripe and cache
 *      for 5 minutes. Cache is process-local — fine for Cloud Run
 *      where each instance is short-lived anyway.
 *
 * Throws if no Plus product is configured at all.
 */
const PRICE_TTL_MS = 5 * 60_000;
const _priceCache = new Map<PaidPlan, { priceId: string; fetchedAt: number }>();

/**
 * Resolve the active Price ID for a plan's checkout.
 *
 *   1. STRIPE_<PLAN>_PRICE_ID (explicit env pin) wins.
 *   2. Otherwise read `Product.default_price` from Stripe and cache it
 *      per-plan for 5 minutes.
 *
 * Throws if the plan has no product configured at all.
 */
export async function resolvePriceIdForPlan(plan: PaidPlan): Promise<string> {
    const def = getPlanDef(plan);
    if (!def) throw new Error(`Unknown plan: ${plan}`);
    if (def.priceOverride) return def.priceOverride;
    const cached = _priceCache.get(plan);
    if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
        return cached.priceId;
    }
    if (!def.productId) {
        throw new Error(
            `STRIPE_${plan.toUpperCase()}_PRODUCT_ID not configured — ${plan} subscription disabled`,
        );
    }
    const product = (await getStripe().products.retrieve(def.productId)) as {
        default_price?: string | { id: string } | null;
    };
    const dp = product.default_price;
    const priceId =
        typeof dp === "string"
            ? dp
            : dp && typeof dp === "object"
              ? dp.id
              : null;
    if (!priceId) {
        throw new Error(
            `Stripe product ${def.productId} has no default_price; set STRIPE_${plan.toUpperCase()}_PRICE_ID or pick one in the dashboard`,
        );
    }
    _priceCache.set(plan, { priceId, fetchedAt: Date.now() });
    return priceId;
}

/** Backward-compatible alias — the Plus checkout still calls this. */
export async function resolvePlusPriceId(): Promise<string> {
    return resolvePriceIdForPlan("plus");
}

/**
 * tier_level_id that an active Plus subscription maps to. Default 2
 * matches the Eulex tier_limits seed; override via PLUS_TIER_LEVEL_ID.
 */
export function getPlusTierLevelId(): number {
    const fromEnv = Number(process.env.PLUS_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 2;
}

export function getFreeTierLevelId(): number {
    const fromEnv = Number(process.env.FREE_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 3;
}

/**
 * tier_level_id for Pro / Team. Defaults match the UMP production levels
 * (Pro = 7, Team = 8); override via PRO_TIER_LEVEL_ID / TEAM_TIER_LEVEL_ID.
 */
export function getProTierLevelId(): number {
    const fromEnv = Number(process.env.PRO_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 7;
}

export function getTeamTierLevelId(): number {
    const fromEnv = Number(process.env.TEAM_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 8;
}

/**
 * tier_level_id for the legal/enterprise tiers. Defaults: Legal Pro = 9,
 * Eulex Legal Team = 10, Enterprise = 11. Override via the matching
 * *_TIER_LEVEL_ID env var. Enterprise has no Stripe product (on-demand).
 */
export function getLegalProTierLevelId(): number {
    const fromEnv = Number(process.env.LEGAL_PRO_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 9;
}

export function getEulexLegalTeamTierLevelId(): number {
    const fromEnv = Number(process.env.EULEX_LEGAL_TEAM_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 10;
}

export function getEnterpriseTierLevelId(): number {
    const fromEnv = Number(process.env.ENTERPRISE_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 11;
}

// Internal "Foundation" tier — our own accounts, practically unlimited
// (mirrors Enterprise entitlements with the max daily quota).
export function getFoundationTierLevelId(): number {
    const fromEnv = Number(process.env.FOUNDATION_TIER_LEVEL_ID);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 12;
}

// ---------------------------------------------------------------------------
// Paid-plan registry (single source for product ↔ tier ↔ price wiring)
// ---------------------------------------------------------------------------

export type PaidPlan =
    | "plus"
    | "pro"
    | "team"
    | "legal_pro"
    | "eulex_legal_team";

export interface PlanDef {
    plan: PaidPlan;
    /** UMP tier_level_id this plan maps to. */
    tierLevelId: number;
    /** tier_limits.tier_slug for this plan. */
    slug: string;
    /** Stripe product id (env), or null when not configured. */
    productId: string | null;
    /** Explicit Stripe price pin (env), or null to use product default. */
    priceOverride: string | null;
    /** Team is billed per seat (subscription quantity = seat count). */
    perSeat: boolean;
    /** Minimum seats for a per-seat plan (Team = 5). */
    minSeats: number;
}

/** The three paid plans, wired from env. Free has no Stripe product. */
export function getPlanDefs(): PlanDef[] {
    return [
        {
            plan: "plus",
            tierLevelId: getPlusTierLevelId(),
            slug: "eulex_plus",
            productId: getPlusProductId(),
            priceOverride: getPlusPriceIdOverride(),
            perSeat: false,
            minSeats: 1,
        },
        {
            plan: "pro",
            tierLevelId: getProTierLevelId(),
            slug: "pro",
            productId: getProProductId(),
            priceOverride: process.env.STRIPE_PRO_PRICE_ID?.trim() || null,
            perSeat: false,
            minSeats: 1,
        },
        {
            plan: "team",
            tierLevelId: getTeamTierLevelId(),
            slug: "team",
            productId: getTeamProductId(),
            priceOverride: process.env.STRIPE_TEAM_PRICE_ID?.trim() || null,
            perSeat: true,
            minSeats: 5,
        },
        {
            plan: "legal_pro",
            tierLevelId: getLegalProTierLevelId(),
            slug: "legal_pro",
            productId: getLegalProProductId(),
            priceOverride:
                process.env.STRIPE_LEGAL_PRO_PRICE_ID?.trim() || null,
            perSeat: false,
            minSeats: 1,
        },
        {
            plan: "eulex_legal_team",
            tierLevelId: getEulexLegalTeamTierLevelId(),
            slug: "eulex_legal_team",
            productId: getEulexLegalTeamProductId(),
            priceOverride:
                process.env.STRIPE_EULEX_LEGAL_TEAM_PRICE_ID?.trim() || null,
            perSeat: true,
            minSeats: 5,
        },
    ];
}

/** Look up a plan by its key ('plus' | 'pro' | 'team'). */
export function getPlanDef(plan: string): PlanDef | undefined {
    return getPlanDefs().find((p) => p.plan === plan);
}

/** Look up a plan by key OR by tier slug (webhook metadata may carry either). */
export function planDefByKeyOrSlug(s: string | null | undefined): PlanDef | undefined {
    if (!s) return undefined;
    return getPlanDefs().find((p) => p.plan === s || p.slug === s);
}

/** Map a Stripe product id back to its plan — authoritative for the webhook. */
export function planForProductId(
    productId: string | null | undefined,
): PlanDef | undefined {
    if (!productId) return undefined;
    return getPlanDefs().find((p) => p.productId === productId);
}
