// Partner JWT minting for the EULEX MCP B2B integration.
//
// The max-backend acts as a trusted partner: it mints short-lived HS256 JWTs
// that let its end-users call EULEX MCP tools without each user needing a
// separate EULEX account. The secret is stored in GCP Secret Manager and
// injected into Cloud Run as MAX_EULEX_PARTNER_SECRET.

import jwt from "jsonwebtoken";

const PARTNER_NAME = "max";
const PARTNER_ISSUER = "https://max.eulex.ai/";
const AUDIENCE = "eulex-mcp";
const TOKEN_TTL_SECONDS = 3600; // 1 hour
const REFRESH_MARGIN_SECONDS = 300; // refresh 5 min before expiry

type CachedToken = {
    token: string;
    expiresAt: number; // unix epoch seconds
};

/** EULEX-side tier granted to the end-user via the partner token. */
export type EulexPartnerTier = "free" | "plus";

// Cache keyed by userId:tier — avoids re-signing on every chat request while
// still rotating the token immediately when the user's tier changes.
const tokenCache = new Map<string, CachedToken>();

/**
 * Mint an EULEX partner JWT for the given max user.
 *
 * Returns `null` when `MAX_EULEX_PARTNER_SECRET` is not set (local dev
 * without the secret). The caller should skip the EULEX connector entirely
 * in that case.
 *
 * `tier` is the EULEX tier the token asserts for this end-user (Max free
 * tier → "free", every paid tier → "plus"); callers that cannot resolve the
 * tier should pass "plus" to preserve the historical default.
 *
 * Tokens are cached per user+tier and refreshed 5 minutes before expiry.
 */
export function mintEulexPartnerToken(
    userId: string,
    tier: EulexPartnerTier = "plus",
): string | null {
    const secret = process.env.MAX_EULEX_PARTNER_SECRET;
    if (!secret) return null;

    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still fresh
    const cacheKey = `${userId}:${tier}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) {
        return cached.token;
    }

    const exp = now + TOKEN_TTL_SECONDS;
    const payload = {
        sub: `max-${userId}`,
        tier,
        scope: tier === "plus" ? "mcp:all mcp:plus" : "mcp:all",
        partner: PARTNER_NAME,
        iss: PARTNER_ISSUER,
        aud: AUDIENCE,
        iat: now,
        exp,
    };

    const token = jwt.sign(payload, secret, { algorithm: "HS256" });
    tokenCache.set(cacheKey, { token, expiresAt: exp });
    return token;
}

/**
 * Whether the EULEX partner integration is configured (secret is available).
 */
export function isEulexPartnerConfigured(): boolean {
    return !!process.env.MAX_EULEX_PARTNER_SECRET;
}
