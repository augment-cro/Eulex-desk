/**
 * Stripe client + Eulex Plus token-pack catalog.
 *
 * The catalog is server-side only — frontends ask the backend for the
 * list with `GET /billing/topup/packs` and never see Stripe Price IDs.
 * That keeps Price IDs (which differ per env: test vs live) out of the
 * client bundle and makes pricing changes a backend deploy, not a
 * frontend rebuild.
 *
 * The 1M / 3M packs map to a Stripe Price (`price_…`) OR Product
 * (`prod_…`) id provided via env — a product id is resolved to its
 * default price at checkout time (#76). If a pack is missing its env
 * var it's silently dropped from the public list — that's the toggle
 * to disable Stripe top-up at runtime without code changes.
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
// Customer invoice details (company name + VAT)
// ---------------------------------------------------------------------------

/**
 * Normalise a user-typed VAT number for Stripe's `eu_vat` tax-id type,
 * which requires the country prefix (e.g. "HR12345678901"). Croatian
 * users routinely type the bare 11-digit OIB, so that form gets the
 * "HR" prefix added. Returns null when there's nothing usable.
 */
export function normaliseVatNumber(
    raw: string | null | undefined,
): string | null {
    if (!raw) return null;
    const compact = raw.replace(/[\s.-]/g, "").toUpperCase();
    if (!compact) return null;
    if (/^\d{11}$/.test(compact)) return `HR${compact}`;
    return compact;
}

/**
 * Push invoice-facing billing details onto a Stripe customer so they
 * appear on invoice PDFs: `customer.name` (company name) in the "Bill
 * to" block and the VAT number as a `customer.tax_id` in the header.
 * Invoices snapshot both at finalization time, so this must run before
 * the subscription/invoice is created for the current invoice to carry
 * them; later invoices pick up whatever is on the customer.
 *
 * Best-effort by design — never throws. A Stripe hiccup or an invalid
 * VAT number (Stripe validates `eu_vat` format) must never break
 * checkout or a profile save; it just means the invoice goes out
 * without the detail.
 *
 * VAT sync is authoritative: the DB value is the truth, so a cleared
 * VAT number (null) deletes any `eu_vat` ids we previously created,
 * and a changed one replaces them (create first, then delete stale —
 * a failed create leaves the old id intact). An empty `name` leaves
 * `customer.name` untouched rather than clearing it.
 */
export type CustomerBillingAddress = {
    country: string;
    line1?: string | null;
    city?: string | null;
    postal_code?: string | null;
};

export async function syncCustomerInvoiceDetails(
    customerId: string,
    details: {
        name?: string | null;
        vatNumber?: string | null;
        /**
         * Billing address (tracker #35). Zakon o PDV-u čl. 79. requires
         * the buyer's address on the invoice; Stripe prints
         * customer.address in the "Bill to" block. Only fields that are
         * present are written, so a country-only update never wipes a
         * street the user typed earlier.
         */
        address?: CustomerBillingAddress | null;
        /**
         * Contact phone (tracker #37). Always OPTIONAL — čl. 79. ZPDV
         * does not require it; we collect it only because a user may
         * want it on file. Stripe stores it on customer.phone.
         */
        phone?: string | null;
    },
): Promise<void> {
    if (!isStripeConfigured()) return;
    const stripe = getStripe();
    const name = details.name?.trim() || null;
    const vat = normaliseVatNumber(details.vatNumber);

    const patch: {
        name?: string;
        address?: Record<string, string>;
        phone?: string;
    } = {};
    if (name) patch.name = name;
    if (details.phone?.trim()) patch.phone = details.phone.trim();
    if (details.address?.country) {
        const a = details.address;
        patch.address = {
            country: a.country,
            ...(a.line1?.trim() ? { line1: a.line1.trim() } : {}),
            ...(a.city?.trim() ? { city: a.city.trim() } : {}),
            ...(a.postal_code?.trim()
                ? { postal_code: a.postal_code.trim() }
                : {}),
        };
    }
    if (Object.keys(patch).length > 0) {
        try {
            await stripe.customers.update(customerId, patch);
        } catch (err) {
            console.warn(
                `[stripe/sync] name/address update failed for ${customerId} (non-fatal):`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    try {
        const existing = await stripe.customers.listTaxIds(customerId, {
            limit: 10,
        });
        if (vat && !existing.data.some((t) => t.value.toUpperCase() === vat)) {
            await stripe.customers.createTaxId(customerId, {
                type: "eu_vat",
                value: vat,
            });
        }
        for (const t of existing.data) {
            if (t.type !== "eu_vat" || t.value.toUpperCase() === vat) continue;
            try {
                await stripe.customers.deleteTaxId(customerId, t.id);
            } catch (err) {
                console.warn(
                    `[stripe/sync] stale tax-id delete failed for ${customerId} (non-fatal):`,
                    err instanceof Error ? err.message : err,
                );
            }
        }
    } catch (err) {
        console.warn(
            `[stripe/sync] tax-id sync failed for ${customerId} (non-fatal):`,
            err instanceof Error ? err.message : err,
        );
    }
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
    /**
     * Stripe Price (price_…) or Product (prod_…) id, from env. Never
     * passed to Checkout directly — `resolvePackPriceId()` turns it
     * into a guaranteed price_… id first (#76).
     */
    priceId: string;
    /** Frontend-facing price hint (purely cosmetic; Stripe is the truth). */
    amountEurDisplay: number;
};

/**
 * Resolve the public catalog from environment variables. Each pack is
 * enabled iff its `STRIPE_PACK_*_PRICE_ID` (or, since #76, its
 * `STRIPE_PACK_*_PRODUCT_ID`) env var is set; missing vars hide the
 * pack — useful for staging where only the 1M is wired. Either id
 * form works: a `prod_…` value is resolved to the product's default
 * price at checkout time (see `resolvePackPriceId`).
 */
export function getTokenPacks(): TokenPack[] {
    const packs: TokenPack[] = [];
    const p1m =
        process.env.STRIPE_PACK_1M_PRICE_ID?.trim() ||
        process.env.STRIPE_PACK_1M_PRODUCT_ID?.trim();
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
    const p3m =
        process.env.STRIPE_PACK_3M_PRICE_ID?.trim() ||
        process.env.STRIPE_PACK_3M_PRODUCT_ID?.trim();
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

const PRICE_TTL_MS = 5 * 60_000;
const _defaultPriceCache = new Map<
    string,
    { priceId: string; fetchedAt: number }
>();

/**
 * Resolve a Stripe product's active Price id (price_…), cached per
 * product for 5 minutes (process-local — fine for Cloud Run where each
 * instance is short-lived anyway). Order:
 *
 *   1. `Product.default_price` (what the dashboard marks as default);
 *   2. otherwise the product's single active price via `prices.list`
 *      (covers products where nobody clicked "set as default").
 *
 * Throws when the product has no usable price at all. Shared by the
 * subscription plans AND the token packs (#76).
 */
export async function resolveDefaultPriceForProduct(
    productId: string,
): Promise<string> {
    const cached = _defaultPriceCache.get(productId);
    if (cached && Date.now() - cached.fetchedAt < PRICE_TTL_MS) {
        return cached.priceId;
    }
    const stripe = getStripe();
    const product = (await stripe.products.retrieve(productId)) as {
        default_price?: string | { id: string } | null;
    };
    const dp = product.default_price;
    let priceId =
        typeof dp === "string"
            ? dp
            : dp && typeof dp === "object"
              ? dp.id
              : null;
    if (!priceId) {
        const prices = await stripe.prices.list({
            product: productId,
            active: true,
            limit: 1,
        });
        priceId = prices.data[0]?.id ?? null;
    }
    if (!priceId) {
        throw new Error(
            `Stripe product ${productId} has no default_price and no active price — pick one in the dashboard`,
        );
    }
    _defaultPriceCache.set(productId, { priceId, fetchedAt: Date.now() });
    return priceId;
}

/**
 * Resolve the active Price ID for a plan's checkout.
 *
 *   1. STRIPE_<PLAN>_PRICE_ID (explicit env pin) wins.
 *   2. Otherwise resolve the product's default/active price from
 *      Stripe (cached per product for 5 minutes).
 *
 * Throws if the plan has no product configured at all.
 */
export async function resolvePriceIdForPlan(plan: PaidPlan): Promise<string> {
    const def = getPlanDef(plan);
    if (!def) throw new Error(`Unknown plan: ${plan}`);
    if (def.priceOverride) return def.priceOverride;
    if (!def.productId) {
        throw new Error(
            `STRIPE_${plan.toUpperCase()}_PRODUCT_ID not configured — ${plan} subscription disabled`,
        );
    }
    try {
        return await resolveDefaultPriceForProduct(def.productId);
    } catch (err) {
        throw new Error(
            `${err instanceof Error ? err.message : String(err)}; set STRIPE_${plan.toUpperCase()}_PRICE_ID to pin one explicitly`,
        );
    }
}

/**
 * Turn a token pack's configured Stripe id into a guaranteed `price_…`
 * id for Checkout `line_items[].price` (#76):
 *
 *   • `price_…` — used as-is (the pre-#76 happy path);
 *   • `prod_…`  — resolved to the product's default/active price
 *     server-side, cached (same resolver the subscription plans use).
 *
 * Anything else throws so a typo'd env var fails loudly at checkout
 * instead of producing an opaque Stripe error.
 */
export async function resolvePackPriceId(pack: TokenPack): Promise<string> {
    const id = pack.priceId;
    if (id.startsWith("price_")) return id;
    if (id.startsWith("prod_")) return resolveDefaultPriceForProduct(id);
    throw new Error(
        `Token pack ${pack.id} has an unrecognised Stripe id (expected price_… or prod_…)`,
    );
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
