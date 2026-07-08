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

// Cache keyed by userId — avoids re-signing on every chat request.
const tokenCache = new Map<string, CachedToken>();

/**
 * Mint an EULEX partner JWT for the given max user.
 *
 * Returns `null` when `MAX_EULEX_PARTNER_SECRET` is not set (local dev
 * without the secret). The caller should skip the EULEX connector entirely
 * in that case.
 *
 * Tokens are cached per-user and refreshed 5 minutes before expiry.
 */
export function mintEulexPartnerToken(userId: string): string | null {
    const secret = process.env.MAX_EULEX_PARTNER_SECRET;
    if (!secret) return null;

    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still fresh
    const cached = tokenCache.get(userId);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) {
        return cached.token;
    }

    const exp = now + TOKEN_TTL_SECONDS;
    const payload = {
        sub: `max-${userId}`,
        // tier: dynamic tier will be added later within Eulex Desk app
        tier: "plus",
        scope: "mcp:all mcp:plus",
        partner: PARTNER_NAME,
        iss: PARTNER_ISSUER,
        aud: AUDIENCE,
        iat: now,
        exp,
    };

    const token = jwt.sign(payload, secret, { algorithm: "HS256" });
    tokenCache.set(userId, { token, expiresAt: exp });
    return token;
}

/**
 * Whether the EULEX partner integration is configured (secret is available).
 */
export function isEulexPartnerConfigured(): boolean {
    return !!process.env.MAX_EULEX_PARTNER_SECRET;
}
