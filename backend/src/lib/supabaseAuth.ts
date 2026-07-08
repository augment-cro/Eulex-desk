/**
 * Supabase Auth token verification.
 *
 * Eulex Desk uses Supabase **only as an Auth provider** — identity lives in
 * Supabase, all business data stays in Cloud SQL. This module verifies a
 * Supabase access token (a JWT signed with the project's asymmetric key,
 * ES256 by default on new projects) against the project's public JWKS.
 *
 * It is intentionally side-effect-free and env-gated: when `SUPABASE_URL`
 * is unset the whole Supabase auth path is disabled and the legacy
 * WordPress-OAuth flow in `requireAuth` runs unchanged (see middleware/auth.ts).
 *
 * @module supabaseAuth
 */

import { createRemoteJWKSet, jwtVerify, decodeJwt, type JWTPayload } from "jose";

/** Project base URL, e.g. https://<project-ref>.supabase.co (no trailing slash). */
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");

/** Issuer baked into every Supabase access token: `${SUPABASE_URL}/auth/v1`. */
const SUPABASE_ISSUER = SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : "";

/** Audience Supabase puts on authenticated user tokens. */
const SUPABASE_AUDIENCE = "authenticated";

/** True when Supabase auth is configured; gates the dual-token path. */
export const supabaseAuthEnabled = SUPABASE_URL.length > 0;

/**
 * Remote JWK set, created lazily on first verify. `jose` caches the keys
 * and only refetches on key rotation / unknown `kid`, so this is a single
 * cheap HTTPS call amortised across all requests — no per-request fetch.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
    if (!jwks) {
        jwks = createRemoteJWKSet(
            new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
        );
    }
    return jwks;
}

/** Identity extracted from a verified Supabase access token. */
export interface SupabaseClaims {
    /** Supabase auth.users UUID (token `sub`). */
    sub: string;
    /** User email (lowercased). May be empty for phone-only signups. */
    email: string;
    /** Full raw payload, for callers that need more claims. */
    raw: JWTPayload;
}

/**
 * Cheap, UNVERIFIED check of whether a bearer token was issued by our
 * Supabase project — used only to ROUTE to the right verifier. The token
 * is still fully verified by {@link verifySupabaseToken} before we trust
 * anything in it. Returns false when Supabase auth is disabled.
 */
export function isSupabaseToken(token: string): boolean {
    if (!supabaseAuthEnabled) return false;
    try {
        const iss = decodeJwt(token).iss;
        return typeof iss === "string" && iss === SUPABASE_ISSUER;
    } catch {
        return false;
    }
}

/**
 * Verify a Supabase access token against the project JWKS and return the
 * caller identity. Throws (jose JWS/JWT errors) on any failure — the
 * middleware maps that to a 401.
 */
export async function verifySupabaseToken(
    token: string,
): Promise<SupabaseClaims> {
    if (!supabaseAuthEnabled) {
        throw new Error("Supabase auth is not configured (SUPABASE_URL unset)");
    }

    const { payload } = await jwtVerify(token, getJwks(), {
        issuer: SUPABASE_ISSUER,
        audience: SUPABASE_AUDIENCE,
    });

    if (!payload.sub) {
        throw new Error("Supabase token missing sub claim");
    }

    const email =
        typeof payload.email === "string" ? payload.email.toLowerCase().trim() : "";

    return { sub: String(payload.sub), email, raw: payload };
}
