/**
 * Supabase browser client — Auth only.
 *
 * Eulex Desk uses Supabase purely as an identity provider; all data lives in the
 * Node backend + Cloud SQL. The session's access token is a JWT the
 * backend verifies via the project JWKS (see backend/src/lib/supabaseAuth.ts).
 *
 * Integration strategy ("mirror"): instead of teaching the 19 existing
 * consumers of @/lib/oauth about a second token source, every Supabase
 * session change is mirrored INTO the legacy token store (storeTokens →
 * mike_oauth_tokens + AUTH_TOKEN_EVENT). AuthContext, mikeApi and friends
 * keep working unchanged; oauth.ts routes refresh/sign-out back here when
 * the stored set is marked `provider: "supabase"`.
 *
 * Env-gated: without NEXT_PUBLIC_SUPABASE_URL + publishable key the module
 * reports `supabaseAuthEnabled === false` and the legacy WordPress flow is
 * the only login path.
 *
 * @module supabaseClient
 */

import {
    createClient,
    type Session,
    type SupabaseClient,
} from "@supabase/supabase-js";
import {
    clearTokens,
    getStoredTokens,
    storeTokens,
    type TokenSet,
} from "@/lib/oauth";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const SUPABASE_KEY = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ?? ""
).trim();

/** True when the Supabase login path is configured for this build. */
export const supabaseAuthEnabled =
    SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0;

/** Scope string mirrored into the legacy TokenSet (display/compat only). */
const MIKE_SCOPE = "mike:projects mike:documents mike:chat";

let client: SupabaseClient | null = null;

/**
 * Lazy singleton. PKCE flow; URL detection is OFF because the exchange is
 * done explicitly on /auth/supabase-callback — the legacy WordPress
 * callback also uses ?code= and must not be intercepted by supabase-js.
 */
export function getSupabase(): SupabaseClient {
    if (!supabaseAuthEnabled) {
        throw new Error(
            "Supabase auth is not configured (NEXT_PUBLIC_SUPABASE_URL / publishable key missing)",
        );
    }
    if (!client) {
        client = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: {
                flowType: "pkce",
                detectSessionInUrl: false,
                persistSession: true,
                autoRefreshToken: true,
            },
        });
    }
    return client;
}

/**
 * Mirror a Supabase session into the legacy token store so every existing
 * consumer of @/lib/oauth sees it. Passing null is a no-op (sign-out is
 * handled separately so a WP session is never clobbered by Supabase noise).
 */
export function mirrorSupabaseSession(session: Session | null): void {
    if (!session) return;
    const expiresAtMs = (session.expires_at ?? 0) * 1000;
    const tokenSet: TokenSet = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in ?? 3600,
        expires_at: expiresAtMs || Date.now() + (session.expires_in ?? 3600) * 1000,
        scope: MIKE_SCOPE,
        token_type: "bearer",
        provider: "supabase",
    };
    storeTokens(tokenSet);
}

let mirrorInitialized = false;

/**
 * Subscribe the mirror to Supabase auth state changes (sign-in, automatic
 * token refresh, sign-out). Called once from AuthContext on mount; safe to
 * call repeatedly. No-op when Supabase is not configured or during SSR.
 */
export function initSupabaseAuthMirror(): void {
    if (!supabaseAuthEnabled || typeof window === "undefined") return;
    if (mirrorInitialized) return;
    mirrorInitialized = true;

    const supabase = getSupabase();

    supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
            // Only clear when the active local session IS the Supabase one —
            // a parallel WordPress login must survive Supabase sign-outs.
            if (getStoredTokens()?.provider === "supabase") {
                clearTokens();
            }
            return;
        }
        if (
            event === "SIGNED_IN" ||
            event === "TOKEN_REFRESHED" ||
            event === "USER_UPDATED"
        ) {
            mirrorSupabaseSession(session);
        }
    });

    // Re-hydrate after a full reload: supabase-js restores its own session
    // from localStorage; make sure the mirrored copy is fresh too (it may
    // have been refreshed in another tab).
    void supabase.auth.getSession().then(({ data }) => {
        if (data.session && getStoredTokens()?.provider === "supabase") {
            mirrorSupabaseSession(data.session);
        }
    });
}
