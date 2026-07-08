/**
 * Supabase Admin API client (auth.admin) — server-side only.
 *
 * Used by AdminMax to enrich the user detail view with auth facts that
 * only Supabase knows (sign-in provider, last sign-in, email confirmed,
 * ban state) and to suspend/unsuspend a user.
 *
 * Env-gated like the rest of the Supabase integration:
 *   SUPABASE_URL          — project base URL (shared with supabaseAuth.ts)
 *   SUPABASE_SECRET_KEY   — service-role secret (Cloud Secret Manager;
 *                           same secret the user-migration script uses).
 *
 * When either is unset every helper returns null / throws a clear error —
 * AdminMax renders the section as "Supabase nije konfiguriran".
 *
 * @module supabaseAdmin
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = (process.env.SUPABASE_SECRET_KEY ?? "").trim();

export function isSupabaseAdminConfigured(): boolean {
    return SUPABASE_URL.length > 0 && SUPABASE_SECRET_KEY.length > 0;
}

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
    if (_client) return _client;
    if (!isSupabaseAdminConfigured()) {
        throw new Error(
            "Supabase admin is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY)",
        );
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
    return _client;
}

/**
 * Shared service-role client for PostgREST table access on OUR Supabase
 * Postgres (e.g. lib/tierLimitsStore.ts reading/writing `tier_limits`).
 * Throws when Supabase admin is not configured — gate calls with
 * `isSupabaseAdminConfigured()`.
 */
export function getSupabaseAdminClient(): SupabaseClient {
    return getClient();
}

/** Auth facts AdminMax shows next to the Cloud SQL user row. */
export interface SupabaseAuthInfo {
    supabase_user_id: string;
    /** Primary provider ('email', 'google', 'azure', 'linkedin_oidc', …). */
    provider: string | null;
    /** Every linked provider. */
    providers: string[];
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    created_at: string | null;
    /** ISO timestamp until which the user is banned; null = not banned. */
    banned_until: string | null;
}

/**
 * Fetch auth info for one Supabase user. Returns null when the user does
 * not exist in Supabase (e.g. legacy WP-only account) — callers should
 * render that as "nema Supabase računa", not as an error.
 */
export async function getSupabaseAuthInfo(
    supabaseUserId: string,
): Promise<SupabaseAuthInfo | null> {
    const { data, error } = await getClient().auth.admin.getUserById(
        supabaseUserId,
    );
    if (error) {
        if (/not.?found/i.test(error.message)) return null;
        throw new Error(`Supabase admin getUserById failed: ${error.message}`);
    }
    const u = data.user;
    if (!u) return null;
    const app = (u.app_metadata ?? {}) as {
        provider?: string;
        providers?: string[];
    };
    // banned_until is returned by GoTrue but missing from the SDK's User
    // type — read it structurally.
    const bannedUntil = (u as unknown as { banned_until?: string | null })
        .banned_until;
    return {
        supabase_user_id: u.id,
        provider: app.provider ?? null,
        providers: Array.isArray(app.providers) ? app.providers : [],
        email_confirmed_at: u.email_confirmed_at ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
        created_at: u.created_at ?? null,
        banned_until: bannedUntil ?? null,
    };
}

/**
 * Ban (suspend) a Supabase user. `durationHours` caps the ban; GoTrue
 * accepts Go duration strings, so 100 years ≈ permanent. Banned users
 * cannot sign in or refresh — existing access tokens still live out
 * their short TTL.
 */
export async function banSupabaseUser(
    supabaseUserId: string,
    durationHours: number,
): Promise<void> {
    const hours = Math.max(1, Math.floor(durationHours));
    const { error } = await getClient().auth.admin.updateUserById(
        supabaseUserId,
        { ban_duration: `${hours}h` },
    );
    if (error) {
        throw new Error(`Supabase admin ban failed: ${error.message}`);
    }
}

/** Lift a ban ('none' clears banned_until in GoTrue). */
export async function unbanSupabaseUser(
    supabaseUserId: string,
): Promise<void> {
    const { error } = await getClient().auth.admin.updateUserById(
        supabaseUserId,
        { ban_duration: "none" },
    );
    if (error) {
        throw new Error(`Supabase admin unban failed: ${error.message}`);
    }
}

/**
 * Permanently delete a Supabase auth user (GDPR erasure). Best-effort:
 * callers should not abort the Cloud SQL deletion if this throws — log and
 * continue. A "not found" is treated as success (already gone / WP-only user).
 */
export async function deleteSupabaseUser(
    supabaseUserId: string,
): Promise<void> {
    const { error } = await getClient().auth.admin.deleteUser(supabaseUserId);
    if (error && !/not.?found/i.test(error.message)) {
        throw new Error(`Supabase admin deleteUser failed: ${error.message}`);
    }
}

/** Tier fields mirrored into the Supabase user's `app_metadata`. */
export interface SupabaseTierMirror {
    tier_level_id: number | null;
    tier_slug: string | null;
    /** ISO-8601 expiry, or null for no expiry / cleared. */
    tier_until: string | null;
}

/**
 * Mirror a user's subscription tier into Supabase `app_metadata`, so the
 * info rides along with the auth user (visible in the JWT after the next
 * session refresh).
 *
 * This is a CONVENIENCE MIRROR — `public.user_tier_state` stays the
 * authoritative source, enforced server-side; the token may be stale until
 * it refreshes. GoTrue shallow-merges `app_metadata`, so `provider` /
 * `providers` are preserved. Pass nulls to clear the tier (downgrade /
 * cancellation).
 */
export async function updateSupabaseUserTier(
    supabaseUserId: string,
    tier: SupabaseTierMirror,
): Promise<void> {
    const { error } = await getClient().auth.admin.updateUserById(
        supabaseUserId,
        {
            app_metadata: {
                tier_level_id: tier.tier_level_id,
                tier_slug: tier.tier_slug,
                tier_until: tier.tier_until,
            },
        },
    );
    if (error) {
        throw new Error(`Supabase admin tier update failed: ${error.message}`);
    }
}
