/**
 * Per-user tier resolution from Supabase `app_metadata` — tracker #15
 * Phase B (GH #143).
 *
 * READ side only. The WRITE side is unchanged and already complete:
 * every tier change (Stripe webhook, AdminMax, backfills) mirrors into
 * the Supabase user's `app_metadata` synchronously via
 * `updateSupabaseUserTier` (lib/supabaseAdmin.ts / lib/membership.ts).
 *
 * Resolution ladder for a Supabase-authenticated request:
 *   1. `app_metadata.tier_level_id` from the VERIFIED JWT — authoritative.
 *      An explicit `null` (the write side's downgrade/clear) and an
 *      expired `tier_until` both resolve to the free tier.
 *   2. `public.user_tier_state` — legacy fallback ONLY when app_metadata
 *      carries no tier field at all (users never backfilled). Logged every
 *      time it fires so the remaining legacy population is visible.
 *   3. Free tier — fail closed when neither source yields a tier.
 *
 * Token staleness: Supabase access tokens live ~1h, so the JWT claim can
 * lag a tier change. Quota-ENFORCEMENT paths therefore re-read the tier
 * with a fresh auth-admin lookup (`getFreshSupabaseTier`), amortised by a
 * short in-process cache (60s per user) so hot paths don't hammer the
 * admin API. A lookup failure NEVER blocks the request — the caller keeps
 * the auth-time resolution.
 *
 * `user_tier_state` is deliberately NOT dropped — it stays written by the
 * same write paths and serves as the legacy fallback/cache. No schema
 * change in this phase.
 *
 * @module tierResolution
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { query } from "./db";
import {
    getSupabaseAdminClient,
    isSupabaseAdminConfigured,
} from "./supabaseAdmin";
import { getFreeTierLevelId } from "./stripe";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of reading the tier out of a user's `app_metadata`. */
export type AppMetadataTier =
    /** app_metadata is authoritative: use this tier (expiry/clear already applied). */
    | { kind: "tier"; tierLevelId: number; tierSlug: string | null }
    /** No tier field at all (legacy, never-backfilled user) — fall back. */
    | { kind: "none" }
    /** Fresh lookup failed / not configured — keep whatever you already have. */
    | { kind: "error" };

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests — same pattern as tierLimitsStore)
// ---------------------------------------------------------------------------

interface TierResolutionDeps {
    query: typeof query;
    getSupabaseClient: () => SupabaseClient;
    isSupabaseConfigured: () => boolean;
    ttlMs: number;
    now: () => number;
}

/** Fresh-lookup cache TTL — quota checks re-read at most once per user/min. */
const FRESH_TIER_TTL_MS = 60_000;

function defaultDeps(): TierResolutionDeps {
    return {
        query,
        getSupabaseClient: getSupabaseAdminClient,
        isSupabaseConfigured: isSupabaseAdminConfigured,
        ttlMs: FRESH_TIER_TTL_MS,
        now: Date.now,
    };
}

let deps: TierResolutionDeps = defaultDeps();

/** Test hook — override individual dependencies. */
export function _setTierResolutionDepsForTesting(
    partial: Partial<TierResolutionDeps>,
): void {
    deps = { ...deps, ...partial };
}

/** Test hook — restore real dependencies and drop the fresh-lookup cache. */
export function _resetTierResolutionForTesting(): void {
    deps = defaultDeps();
    freshTierCache.clear();
}

// ---------------------------------------------------------------------------
// app_metadata parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Read the tier out of an `app_metadata` object (from the verified JWT or
 * an admin `getUserById`).
 *
 *   - `tier_level_id` a finite number → that tier; an expired `tier_until`
 *     resolves to free (same expiry semantics as the legacy
 *     `user_tier_state.active_tier_until` check in middleware/auth.ts).
 *   - `tier_level_id` explicitly `null` → free. The write side clears the
 *     tier with nulls on downgrade/cancellation (`updateSupabaseUserTier`),
 *     so a null is an authoritative "no active tier", NOT a legacy gap —
 *     falling back to a possibly-stale `user_tier_state` row here could
 *     resurrect a cancelled subscription.
 *   - key absent or malformed → `{ kind: "none" }`: legacy user whose
 *     app_metadata was never backfilled — caller falls back.
 */
export function resolveTierFromAppMetadata(
    appMetadata: unknown,
): Extract<AppMetadataTier, { kind: "tier" | "none" }> {
    if (!appMetadata || typeof appMetadata !== "object") {
        return { kind: "none" };
    }
    const meta = appMetadata as Record<string, unknown>;
    if (!("tier_level_id" in meta)) return { kind: "none" };

    const level = meta.tier_level_id;
    const free = getFreeTierLevelId();

    if (level === null) {
        // Explicit clear by the write side — authoritative free.
        return { kind: "tier", tierLevelId: free, tierSlug: null };
    }
    if (typeof level !== "number" || !Number.isFinite(level)) {
        // Malformed value (the write side only ever writes number|null) —
        // treat as "no tier field" and let the trusted local fallback decide.
        return { kind: "none" };
    }

    // Expiry — mirror the user_tier_state semantics exactly: expired only
    // when tier_until parses to a real date in the past.
    const until = typeof meta.tier_until === "string" ? meta.tier_until : null;
    if (until) {
        const ts = new Date(until);
        if (!Number.isNaN(ts.getTime()) && ts < new Date(deps.now())) {
            return { kind: "tier", tierLevelId: free, tierSlug: null };
        }
    }

    const slug = typeof meta.tier_slug === "string" ? meta.tier_slug : null;
    return { kind: "tier", tierLevelId: level, tierSlug: slug };
}

// ---------------------------------------------------------------------------
// Auth-time ladder (JWT app_metadata → user_tier_state fallback → free)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective tier_level_id for a Supabase-authenticated user at
 * auth time. Never throws — every failure resolves toward the free tier
 * (fail closed), matching the previous middleware behavior.
 */
export async function resolveSupabaseUserTier(args: {
    /** Cloud SQL users.id (for the user_tier_state fallback). */
    userId: string;
    /** Supabase auth UUID (log context only). */
    supabaseUserId: string;
    /** `app_metadata` claim from the VERIFIED access token. */
    appMetadata: unknown;
}): Promise<number> {
    const free = getFreeTierLevelId();

    const fromMeta = resolveTierFromAppMetadata(args.appMetadata);
    if (fromMeta.kind === "tier") return fromMeta.tierLevelId;

    // Legacy fallback — app_metadata has no tier field (user predates the
    // Supabase tier mirror and was never backfilled). Logged so the
    // remaining legacy population is measurable before any future drop of
    // user_tier_state.
    console.log(
        `[tier] app_metadata has no tier for supabase_user=${args.supabaseUserId} ` +
            `user=${args.userId} — falling back to user_tier_state`,
    );
    try {
        const { rows } = await deps.query<{
            active_tier_level_id: number | null;
            active_tier_until: string | null;
        }>(
            `SELECT active_tier_level_id, active_tier_until
               FROM public.user_tier_state WHERE user_id = $1`,
            [args.userId],
        );
        const o = rows[0];
        if (o && o.active_tier_level_id != null) {
            const expired =
                o.active_tier_until &&
                new Date(o.active_tier_until) < new Date(deps.now());
            if (!expired) return Number(o.active_tier_level_id);
        }
    } catch (err) {
        console.error(
            "[tier] user_tier_state fallback lookup failed (defaulting free):",
            err instanceof Error ? err.message : err,
        );
    }
    return free;
}

// ---------------------------------------------------------------------------
// Fresh admin lookup (quota-enforcement paths)
// ---------------------------------------------------------------------------

/** Per-user cache of the last fresh lookup (per Cloud Run instance). */
const freshTierCache = new Map<string, { at: number; result: AppMetadataTier }>();

/** Keep the cache bounded on long-lived instances. */
const FRESH_TIER_CACHE_MAX = 10_000;

function cacheFreshTier(supabaseUserId: string, result: AppMetadataTier): void {
    if (freshTierCache.size >= FRESH_TIER_CACHE_MAX) {
        const cutoff = deps.now() - deps.ttlMs;
        for (const [k, v] of freshTierCache) {
            if (v.at < cutoff) freshTierCache.delete(k);
        }
        if (freshTierCache.size >= FRESH_TIER_CACHE_MAX) freshTierCache.clear();
    }
    freshTierCache.set(supabaseUserId, { at: deps.now(), result });
}

/**
 * Fresh per-user tier read for QUOTA-ENFORCEMENT paths (lib/rateLimit.ts).
 *
 * The JWT's app_metadata can be up to ~1h stale (access-token lifetime),
 * which on a quota check could over-grant (cancelled sub still burning a
 * paid quota) or under-grant (fresh upgrade still capped at free). This
 * re-reads the user via auth-admin `getUserById`, amortised by a 60s
 * in-process cache per user.
 *
 * Never throws. `{ kind: "error" }` (admin API down / not configured) and
 * `{ kind: "none" }` (legacy user, or auth user deleted) both mean the
 * caller should KEEP the auth-time resolution from res.locals — the
 * failure of a freshness upgrade must never block or downgrade a request
 * on its own. Failed lookups are cached for the same TTL so an outage
 * doesn't add a failing admin call to every quota check.
 */
export async function getFreshSupabaseTier(
    supabaseUserId: string,
): Promise<AppMetadataTier> {
    if (!deps.isSupabaseConfigured()) return { kind: "error" };

    const cached = freshTierCache.get(supabaseUserId);
    if (cached && deps.now() - cached.at < deps.ttlMs) return cached.result;

    let result: AppMetadataTier;
    try {
        const { data, error } = await deps
            .getSupabaseClient()
            .auth.admin.getUserById(supabaseUserId);
        if (error) {
            if (/not.?found/i.test(error.message)) {
                // Auth user gone (deleted after token issue) — no
                // app_metadata source exists; let the caller keep its
                // fallback-based resolution.
                result = { kind: "none" };
            } else {
                console.warn(
                    `[tier] fresh admin lookup failed for supabase_user=${supabaseUserId}:`,
                    error.message,
                );
                result = { kind: "error" };
            }
        } else if (!data.user) {
            result = { kind: "none" };
        } else {
            result = resolveTierFromAppMetadata(data.user.app_metadata);
        }
    } catch (err) {
        console.warn(
            `[tier] fresh admin lookup threw for supabase_user=${supabaseUserId}:`,
            err instanceof Error ? err.message : err,
        );
        result = { kind: "error" };
    }
    cacheFreshTier(supabaseUserId, result);
    return result;
}
