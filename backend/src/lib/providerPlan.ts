/**
 * The plan as sent to an external billing provider: opaque to the
 * provider, priced from the plan's live Stripe price (net EUR per month).
 * The provider echoes tierLevelId back in the grants it posts; rank lets
 * it pick the better of two grants without knowing the tier ladder.
 */
import { getPlanDef, getStripe, resolvePriceIdForPlan } from "./stripe";
import { TIER_RANK, tierKeyForLevelId } from "./entitlements";

export interface ProviderPlan {
    key: string;
    name: string;
    tierLevelId: number;
    rank: number;
    productCode: string | null;
    netMonthlyPrice: number;
    currency: "EUR";
    perSeat: boolean;
    seats: number;
}

const PLAN_NAMES: Record<string, string> = {
    plus: "Eulex Plus",
    pro: "Eulex Pro",
    team: "Eulex Team",
    legal_pro: "Eulex Legal Pro",
    eulex_legal_team: "Eulex Legal Team",
};

/** Null when the plan is unknown, unsold, or its price can't be used. */
export async function providerPlan(planKey: unknown, seatsRaw: unknown): Promise<ProviderPlan | null> {
    if (typeof planKey !== "string") return null;
    const def = getPlanDef(planKey);
    if (!def || !def.productId) return null;
    const n = Math.floor(Number(seatsRaw));
    const seats = def.perSeat ? Math.min(1000, Math.max(def.minSeats, Number.isFinite(n) ? n : def.minSeats)) : 1;

    const price = (await getStripe().prices.retrieve(await resolvePriceIdForPlan(def.plan))) as unknown as {
        unit_amount: number | null;
        currency: string;
        product: string | { id: string };
        tax_behavior?: string | null;
        recurring?: { interval: string; interval_count?: number } | null;
    };
    if (price.currency?.toLowerCase() !== "eur" || typeof price.unit_amount !== "number") return null;
    if (price.tax_behavior === "inclusive") return null;
    const count = price.recurring?.interval_count ?? 1;
    const months =
        price.recurring?.interval === "year" ? 12 * count : price.recurring?.interval === "month" ? count : 0;
    if (!months) return null;
    const productId = typeof price.product === "string" ? price.product : price.product?.id ?? def.productId;

    return {
        key: def.plan,
        name: PLAN_NAMES[def.plan] ?? def.plan,
        tierLevelId: def.tierLevelId,
        rank: TIER_RANK[tierKeyForLevelId(def.tierLevelId)],
        productCode: productId,
        netMonthlyPrice: Math.round((price.unit_amount / months) * 100) / 10000,
        currency: "EUR",
        perSeat: def.perSeat,
        seats,
    };
}
