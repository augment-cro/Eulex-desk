/**
 * Service-identity minting for the license-boundary seams (design §7).
 *
 * Generalizes the eulex partner-JWT pattern (lib/mcp/partnerJwt.ts):
 * short-TTL HS256 tokens, one DISTINCT shared secret per external service,
 * cached per (service, user), refreshed 5 min before expiry. The core
 * also verifies inbound tokens (service → core, e.g. /internal/notifications)
 * signed with the same per-service secrets, direction reversed.
 *
 * Contract: contracts/service-identity.md
 */
import jwt from "jsonwebtoken";

export type SeamService = "contexts" | "governance" | "audit";

const SECRET_ENV: Record<SeamService, string> = {
    contexts: "CONTEXTS_SERVICE_SECRET",
    governance: "GOVERNANCE_SERVICE_SECRET",
    audit: "AUDIT_SINK_SECRET",
};

const CORE_ISSUER = "eulex-desk";
const TOKEN_TTL_SECONDS = 3600;
const REFRESH_MARGIN_SECONDS = 300;

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

function seamSecret(service: SeamService): string | null {
    const v = process.env[SECRET_ENV[service]]?.trim();
    return v || null;
}

/**
 * Mint a core→service identity token. Returns null when the service's
 * secret is not configured (the seam then calls without Authorization —
 * dev/localhost posture, same as the PII client).
 *
 * `email` is an OPTIONAL claim: services that support email-based sharing
 * consume it to resolve shares; without it the caller simply sees no
 * shared items.
 */
export function mintServiceToken(
    service: SeamService,
    userId: string,
    tenant: string | null = null,
    email: string | null = null,
): string | null {
    const secret = seamSecret(service);
    if (!secret) return null;

    const now = Math.floor(Date.now() / 1000);
    const key = `${service}:${userId}:${email ?? ""}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_SECONDS) {
        return cached.token;
    }

    const exp = now + TOKEN_TTL_SECONDS;
    const token = jwt.sign(
        {
            sub: `desk-${userId}`,
            tenant,
            scope: `seam:${service}`,
            ...(email ? { email } : {}),
            iss: CORE_ISSUER,
            aud: service,
            iat: now,
            exp,
        },
        secret,
        { algorithm: "HS256" },
    );
    tokenCache.set(key, { token, expiresAt: exp });
    return token;
}

export interface InboundServiceIdentity {
    service: SeamService;
    sub: string;
}

/**
 * Verify a service→core token against every configured seam secret.
 * Returns the matching service identity, or null when nothing verifies
 * (including when no secrets are configured at all).
 */
export function verifyInboundServiceToken(
    token: string,
): InboundServiceIdentity | null {
    for (const service of Object.keys(SECRET_ENV) as SeamService[]) {
        const secret = seamSecret(service);
        if (!secret) continue;
        try {
            const payload = jwt.verify(token, secret, {
                algorithms: ["HS256"],
                audience: CORE_ISSUER,
                issuer: service,
            }) as jwt.JwtPayload;
            return { service, sub: String(payload.sub ?? "") };
        } catch {
            // try the next configured secret
        }
    }
    return null;
}
