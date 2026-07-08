/**
 * Frontend tier ranking — mirrors the backend `TIER_RANK` in
 * `backend/src/lib/entitlements.ts`. Used by the UI to decide which
 * tier-gated affordances to show. The authoritative gate is still the
 * backend (entitlement checks on every protected route); this only keeps
 * the UI honest so we don't dangle controls a user can't actually use.
 */

export type TierKey =
    | "free"
    | "plus"
    | "pro"
    | "legal_pro"
    | "team"
    | "eulex_legal_team"
    | "enterprise";

export const TIER_RANK: Record<TierKey, number> = {
    free: 0,
    plus: 1,
    pro: 2,
    legal_pro: 3,
    team: 4,
    eulex_legal_team: 5,
    enterprise: 6,
};

/**
 * Whether the tier unlocks the "pro" entitlement group — PII anonymization
 * and the Word add-in. Mirrors `ENTITLEMENT_CATALOG` group "pro": off for
 * free/plus, on for pro and everything above it.
 */
export function hasProFeatures(tierKey: TierKey | null | undefined): boolean {
    if (!tierKey) return false;
    return TIER_RANK[tierKey] >= TIER_RANK.pro;
}
