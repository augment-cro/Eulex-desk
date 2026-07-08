/**
 * OAuth 2.1 PKCE client for MikeOSS.
 *
 * Handles the Authorization Code + PKCE flow against the
 * eulex.ai WordPress OAuth server (eulex-mcp-oauth.php).
 *
 * Token storage: httpOnly cookies are ideal but require a
 * Next.js API route proxy. For this SPA-style client that
 * talks directly to a separate backend, we use localStorage
 * with short-lived access tokens (7 d) + refresh rotation.
 *
 * @module oauth
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OAUTH_ISSUER = "https://eulex.ai";
const AUTHORIZE_URL = `${OAUTH_ISSUER}/eulex-ai/mcp-oauth/authorize`;
const TOKEN_URL = `${OAUTH_ISSUER}/eulex-ai/mcp-oauth/token`;
const REVOKE_URL = `${OAUTH_ISSUER}/eulex-ai/mcp-oauth/revoke`;

const CLIENT_ID =
    process.env.NEXT_PUBLIC_OAUTH_CLIENT_ID ?? "mike_default_client";
const REDIRECT_URI =
    process.env.NEXT_PUBLIC_OAUTH_REDIRECT_URI ??
    (typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : "http://localhost:3000/auth/callback");

const STORAGE_KEY = "mike_oauth_tokens";
const PKCE_VERIFIER_KEY = "mike_oauth_pkce_verifier";
const PKCE_STATE_KEY = "mike_oauth_pkce_state";
const PKCE_EXPIRY_KEY = "mike_oauth_pkce_expiry";
const NEXT_URL_KEY = "mike_oauth_next_url";
// PKCE TTL: 15 minutes — matches WordPress transient TTL on eulex.ai
const PKCE_TTL_MS = 15 * 60 * 1000;

/**
 * Custom event fired whenever the local token set changes within the
 * same tab. The browser `storage` event only fires across tabs, so we
 * dispatch this in addition to localStorage writes to let AuthContext
 * (and any other in-tab consumers) re-hydrate immediately. Without it,
 * /auth/callback stores fresh tokens via client-side navigation but
 * AuthContext keeps its initial unauthenticated state — forcing the
 * user to click "Sign in" a second time to trigger a hard reload.
 */
export const AUTH_TOKEN_EVENT = "mike:auth:tokens-changed";

/**
 * Read PKCE value from localStorage, clearing if expired.
 * NOTE: We use localStorage (not sessionStorage) because Safari/WebKit
 * clears sessionStorage on cross-origin navigation, which breaks the
 * OAuth round-trip through eulex.ai.
 */
function getPkceItem(key: string): string | null {
    if (typeof window === "undefined") return null;
    const expiry = localStorage.getItem(PKCE_EXPIRY_KEY);
    if (expiry && Date.now() > parseInt(expiry, 10)) {
        // Stale PKCE — clear and force re-login
        localStorage.removeItem(PKCE_VERIFIER_KEY);
        localStorage.removeItem(PKCE_STATE_KEY);
        localStorage.removeItem(PKCE_EXPIRY_KEY);
        return null;
    }
    return localStorage.getItem(key);
}

function setPkceItem(key: string, value: string): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(key, value);
    // Always refresh expiry on write
    localStorage.setItem(PKCE_EXPIRY_KEY, String(Date.now() + PKCE_TTL_MS));
}

function removePkceItems(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(PKCE_VERIFIER_KEY);
    localStorage.removeItem(PKCE_STATE_KEY);
    localStorage.removeItem(PKCE_EXPIRY_KEY);
}

/**
 * Same-origin path whitelist for post-login deep linking.
 *
 * Anything that doesn't start with a single "/" (and isn't a protocol
 * like "//evil.com/...") is rejected so the URL parameter can't be
 * used as an open redirect. Returns the safe path, or null if not safe.
 */
function sanitizeNextPath(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (typeof raw !== "string") return null;
    // Must start with "/" but not "//" or "/\".
    if (!raw.startsWith("/")) return null;
    if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
    // Cap length defensively.
    if (raw.length > 2048) return null;
    return raw;
}

/**
 * Remember where to send the user after successful auth (deep links
 * like /share/<token>). Persisted in localStorage because the OAuth
 * round-trip is cross-origin and sessionStorage gets blown away by
 * Safari ITP.
 */
export function stashPostLoginRedirect(raw: string | null | undefined): void {
    if (typeof window === "undefined") return;
    const safe = sanitizeNextPath(raw);
    if (safe) {
        localStorage.setItem(NEXT_URL_KEY, safe);
    }
}

/** Consume + clear the stashed redirect. Returns null if none / unsafe. */
export function consumePostLoginRedirect(): string | null {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(NEXT_URL_KEY);
    localStorage.removeItem(NEXT_URL_KEY);
    return sanitizeNextPath(raw);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenSet {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    /** Unix ms when access_token expires (computed on storage) */
    expires_at: number;
    scope: string;
    token_type: string;
    /**
     * Which auth system issued this set. Absent/undefined = legacy
     * WordPress OAuth. "supabase" sets are refreshed and signed out via
     * supabase-js (see supabaseClient.ts mirror) instead of the WP
     * endpoints above.
     */
    provider?: "supabase";
}

export interface OAuthUser {
    /**
     * Stable internal users.id UUID (matches chats.user_id,
     * documents.user_id, tabular_reviews.user_id, …). Initially seeded
     * from the JWT `sub` (= WordPress user_id) on decode, then
     * overwritten with the DB UUID by AuthContext via /user/profile.
     * Comparisons against entity.user_id columns rely on this value
     * being the UUID, not the WP integer.
     */
    id: string;
    email: string;
    name: string;
    tier: "free" | "plus";
    tier_level_id: number;
    scope: string;
}

// ---------------------------------------------------------------------------
// PKCE Helpers (RFC 7636)
// ---------------------------------------------------------------------------

/** Generate a cryptographic random code_verifier (43-128 chars). */
export function generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
}

/** Derive SHA-256 code_challenge from a code_verifier. */
export async function generateCodeChallenge(
    verifier: string,
): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buffer: Uint8Array): string {
    let binary = "";
    for (const byte of buffer) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a random state parameter for CSRF protection. */
export function generateState(): string {
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
}

// ---------------------------------------------------------------------------
// Authorization Flow
// ---------------------------------------------------------------------------

/**
 * Build the full authorization URL and store PKCE verifier + state
 * in sessionStorage (survives redirect, cleared on tab close).
 */
export async function startAuthorizationFlow(
    scope = "mike:projects mike:documents mike:chat",
): Promise<string> {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    // Persist for the callback (localStorage survives cross-origin redirects on all browsers)
    setPkceItem(PKCE_VERIFIER_KEY, verifier);
    setPkceItem(PKCE_STATE_KEY, state);

    const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        scope,
    });

    return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * Called from the /auth/callback page.
 */
export async function exchangeCodeForTokens(
    code: string,
    state: string,
): Promise<TokenSet> {
    // Verify state matches
    const storedState = getPkceItem(PKCE_STATE_KEY);
    if (!storedState || storedState !== state) {
        throw new Error("State mismatch — possible CSRF attack");
    }

    const verifier = getPkceItem(PKCE_VERIFIER_KEY);
    if (!verifier) {
        throw new Error("Missing PKCE verifier — flow was interrupted");
    }

    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
        }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
            error.error_description || error.error || `Token exchange failed (${response.status})`,
        );
    }

    const data = await response.json();

    // Clean up PKCE state
    removePkceItems();

    const tokenSet: TokenSet = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in,
        expires_at: Date.now() + data.expires_in * 1000,
        scope: data.scope,
        token_type: data.token_type,
    };

    storeTokens(tokenSet);
    return tokenSet;
}

/**
 * Refresh the access token using the stored refresh_token.
 * The WordPress plugin rotates refresh tokens on each use.
 * Supabase-issued sets are refreshed via supabase-js instead (the client
 * owns the rotation; the mirror writes the fresh set back into storage).
 */
export async function refreshAccessToken(): Promise<TokenSet | null> {
    const current = getStoredTokens();
    if (!current?.refresh_token) return null;

    if (current.provider === "supabase") {
        try {
            // Dynamic import — supabaseClient statically imports this
            // module, so a top-level import would be circular.
            const { getSupabase, mirrorSupabaseSession } = await import(
                "./supabaseClient"
            );
            const { data, error } = await getSupabase().auth.refreshSession();
            if (error || !data.session) {
                clearTokens();
                return null;
            }
            mirrorSupabaseSession(data.session);
            return getStoredTokens();
        } catch {
            // Network/config error — keep tokens, let the caller retry.
            return null;
        }
    }

    try {
        const response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: current.refresh_token,
                client_id: CLIENT_ID,
            }),
        });

        if (!response.ok) {
            // Refresh token expired or revoked — force re-login
            clearTokens();
            return null;
        }

        const data = await response.json();
        const tokenSet: TokenSet = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_in: data.expires_in,
            expires_at: Date.now() + data.expires_in * 1000,
            scope: data.scope,
            token_type: data.token_type,
        };

        storeTokens(tokenSet);
        return tokenSet;
    } catch {
        // Network error during refresh — don't clear tokens, let user retry
        return null;
    }
}

// ---------------------------------------------------------------------------
// Token Storage
// ---------------------------------------------------------------------------

export function getStoredTokens(): TokenSet | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as TokenSet;
    } catch {
        return null;
    }
}

export function storeTokens(tokens: TokenSet): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    // Same-tab notification — see AUTH_TOKEN_EVENT comment.
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_EVENT));
}

export function clearTokens(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(STORAGE_KEY);
    removePkceItems();
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_EVENT));
}

// ---------------------------------------------------------------------------
// Token Introspection
// ---------------------------------------------------------------------------

/**
 * Check if the stored access token is expired (with 60s buffer).
 */
export function isAccessTokenExpired(): boolean {
    const tokens = getStoredTokens();
    if (!tokens) return true;
    // Add 60 second buffer before actual expiry
    return Date.now() >= tokens.expires_at - 60_000;
}

/**
 * Decode JWT payload WITHOUT verification (client-side user display only).
 * Actual verification happens on the backend.
 */
export function decodeJwtPayload(token: string): OAuthUser | null {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;

        const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));

        // Supabase access token (aud "authenticated", iss .../auth/v1):
        // carries no tier/scope claims — tier is enforced server-side from
        // user_tier_state; here we only need display values.
        if (
            payload.aud === "authenticated" ||
            (typeof payload.iss === "string" && payload.iss.endsWith("/auth/v1"))
        ) {
            const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
            const metaName = [meta.display_name, meta.full_name, meta.name].find(
                (v): v is string => typeof v === "string" && v.length > 0,
            );
            return {
                id: payload.sub,
                email: payload.email ?? "",
                name: metaName ?? (payload.email ? String(payload.email).split("@")[0] : ""),
                tier: "free",
                tier_level_id: 3,
                scope: "mike:projects mike:documents mike:chat",
            };
        }

        return {
            id: payload.sub,
            email: payload.email,
            name: payload.name,
            tier: payload.tier,
            tier_level_id: payload.tier_level_id,
            scope: payload.scope,
        };
    } catch {
        return null;
    }
}

/**
 * Get a valid access token, refreshing if needed.
 * Returns null if no tokens available and refresh fails.
 */
export async function getValidAccessToken(): Promise<string | null> {
    const tokens = getStoredTokens();
    if (!tokens) return null;

    if (!isAccessTokenExpired()) {
        return tokens.access_token;
    }

    // Try refresh
    const refreshed = await refreshAccessToken();
    return refreshed?.access_token ?? null;
}

// ---------------------------------------------------------------------------
// Sign Out
// ---------------------------------------------------------------------------

/**
 * Revoke tokens on the server and clear local storage.
 */
export async function signOut(): Promise<void> {
    const tokens = getStoredTokens();

    if (tokens?.provider === "supabase") {
        try {
            const { getSupabase } = await import("./supabaseClient");
            // Revokes the refresh token server-side and clears the
            // supabase-js session; the mirror's SIGNED_OUT handler also
            // clears our copy, but clear explicitly in case the mirror
            // isn't subscribed yet.
            await getSupabase().auth.signOut();
        } catch {
            // Best-effort — ignore network errors during sign-out
        }
        clearTokens();
        return;
    }

    if (tokens?.refresh_token) {
        // Best-effort revoke (don't block on failure)
        fetch(REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: tokens.refresh_token }),
        }).catch(() => {
            // Ignore network errors during sign-out
        });
    }

    clearTokens();
}
