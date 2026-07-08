/**
 * Tier-definition store — the single read/write surface for the
 * `tier_limits` table (tier DEFINITIONS: daily token quota, entitlement
 * overrides, marketing copy). Per-user tier assignment
 * (`user_tier_state`) is NOT handled here.
 *
 * Tracker #15 Phase A: tier definitions move out of the AGPL core's mike
 * DB into OUR Supabase Postgres. This module hides the cutover behind an
 * env flag so every consumer (rateLimit / entitlements / planCatalog /
 * AdminMax tiers CRUD) is source-agnostic:
 *
 *   TIERS_FROM_SUPABASE truthy AND Supabase admin configured
 *     → reads/writes go to the Supabase `tier_limits` table via the
 *       service-role PostgREST client (lib/supabaseAdmin.ts).
 *   otherwise
 *     → the legacy mike-DB table (unchanged behavior).
 *
 * Resilience (reads are on the chat/rate-limit hot path):
 *   - one in-memory row cache, TTL ~60s (`TIER_LIMITS_TTL_MS`);
 *   - Supabase fetch failure → serve last-known cached rows (warn);
 *   - Supabase failure with NO cache yet → fall back to the mike-DB read
 *     (transition safety while both tables exist);
 *   - an error only propagates when every layer fails — exactly the
 *     failure mode consumers already handle today.
 *
 * Writes (AdminMax editing, boot seeders, the lazy default-row upsert)
 * invalidate the cache so the next read is fresh on this instance; other
 * Cloud Run instances converge within the TTL.
 *
 * NOTE the code-default LAYER stays where it is: lib/entitlements.ts and
 * lib/planCatalog.ts still merge "DB value wins; absent → code default".
 * Only the DB read/write moved here.
 *
 * @module tierLimitsStore
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { query } from "./db";
import {
    getSupabaseAdminClient,
    isSupabaseAdminConfigured,
} from "./supabaseAdmin";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Normalized `tier_limits` row (numbers are numbers, jsonb never null). */
export interface TierLimitsRow {
    tier_level_id: number;
    tier_slug: string;
    display_label: string;
    daily_tokens: number;
    entitlements: Record<string, unknown>;
    marketing: Record<string, unknown>;
    /** ISO-8601. */
    updated_at: string;
}

/** Partial update for AdminMax PATCH — only provided fields are written. */
export interface TierDefinitionPatch {
    tier_slug?: string;
    display_label?: string;
    daily_tokens?: number;
    /** Shallow-merged over the existing `entitlements` jsonb. */
    entitlementsMerge?: Record<string, unknown>;
    /** Full replace of the `marketing` jsonb. */
    marketing?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

interface TierLimitsDeps {
    query: typeof query;
    getSupabaseClient: () => SupabaseClient;
    isSupabaseConfigured: () => boolean;
    ttlMs: number;
    now: () => number;
}

const DEFAULT_TTL_MS = 60_000;

function defaultDeps(): TierLimitsDeps {
    return {
        query,
        getSupabaseClient: getSupabaseAdminClient,
        isSupabaseConfigured: isSupabaseAdminConfigured,
        ttlMs: DEFAULT_TTL_MS,
        now: Date.now,
    };
}

let deps: TierLimitsDeps = defaultDeps();

/** Test hook — override individual dependencies. */
export function _setTierLimitsDepsForTesting(
    partial: Partial<TierLimitsDeps>,
): void {
    deps = { ...deps, ...partial };
}

/** Test hook — restore real dependencies and drop the cache. */
export function _resetTierLimitsStoreForTesting(): void {
    deps = defaultDeps();
    _cache = null;
}

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/** True when tier definitions are served from Supabase. */
export function tiersFromSupabase(): boolean {
    const raw = (process.env.TIERS_FROM_SUPABASE ?? "").trim().toLowerCase();
    const on = raw !== "" && raw !== "0" && raw !== "false" && raw !== "off";
    return on && deps.isSupabaseConfigured();
}

// ---------------------------------------------------------------------------
// Row normalization
// ---------------------------------------------------------------------------

const COLS =
    "tier_level_id, tier_slug, display_label, daily_tokens, entitlements, marketing, updated_at";

function normalizeRow(r: Record<string, unknown>): TierLimitsRow {
    const updated = r.updated_at;
    return {
        tier_level_id: Number(r.tier_level_id),
        tier_slug: String(r.tier_slug),
        display_label: String(r.display_label),
        daily_tokens: Number(r.daily_tokens),
        entitlements: (r.entitlements ?? {}) as Record<string, unknown>,
        marketing: (r.marketing ?? {}) as Record<string, unknown>,
        updated_at:
            updated instanceof Date
                ? updated.toISOString()
                : String(updated ?? ""),
    };
}

// ---------------------------------------------------------------------------
// Cache + reads
// ---------------------------------------------------------------------------

let _cache: { at: number; rows: TierLimitsRow[] } | null = null;

/** Drop the row cache so the next read re-fetches (write paths call this). */
export function invalidateTierLimitsCache(): void {
    _cache = null;
}

async function fetchFromSupabase(): Promise<TierLimitsRow[]> {
    const sb = deps.getSupabaseClient();
    const { data, error } = await sb.from("tier_limits").select(COLS);
    if (error) {
        throw new Error(`supabase tier_limits select failed: ${error.message}`);
    }
    return ((data ?? []) as Record<string, unknown>[]).map(normalizeRow);
}

async function fetchFromMikeDb(): Promise<TierLimitsRow[]> {
    const { rows } = await deps.query<Record<string, unknown>>(
        `SELECT ${COLS} FROM public.tier_limits`,
    );
    return rows.map(normalizeRow);
}

/**
 * All tier-definition rows, cached for `ttlMs`. Fallback chain on the
 * Supabase path: fresh cache → Supabase → stale cache → mike DB.
 */
export async function getAllTierLimits(): Promise<TierLimitsRow[]> {
    const now = deps.now();
    if (_cache && now - _cache.at < deps.ttlMs) return _cache.rows;

    if (tiersFromSupabase()) {
        try {
            const rows = await fetchFromSupabase();
            _cache = { at: now, rows };
            return rows;
        } catch (err) {
            console.warn(
                "[tierLimitsStore] supabase read failed:",
                err instanceof Error ? err.message : err,
            );
            if (_cache) {
                // Serve last-known rows; retry Supabase on the next call.
                return _cache.rows;
            }
            // No cache yet — transition safety: the mike table still holds
            // the same definitions, read it instead of failing the request.
            const rows = await fetchFromMikeDb();
            _cache = { at: now, rows };
            return rows;
        }
    }

    try {
        const rows = await fetchFromMikeDb();
        _cache = { at: now, rows };
        return rows;
    } catch (err) {
        if (_cache) {
            console.warn(
                "[tierLimitsStore] mike-DB read failed; serving cached rows:",
                err instanceof Error ? err.message : err,
            );
            return _cache.rows;
        }
        throw err;
    }
}

/** One tier-definition row by level id (from the cached list), or null. */
export async function getTierLimitsRow(
    tierLevelId: number,
): Promise<TierLimitsRow | null> {
    const rows = await getAllTierLimits();
    return rows.find((r) => r.tier_level_id === tierLevelId) ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a row iff the tier id is unknown (the rate limiter's lazy
 * default for a never-seen tier_level_id). ON CONFLICT DO NOTHING
 * semantics on both paths.
 */
export async function ensureTierRow(row: {
    tier_level_id: number;
    tier_slug: string;
    display_label: string;
    daily_tokens: number;
}): Promise<void> {
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        const { error } = await sb
            .from("tier_limits")
            .upsert(
                {
                    tier_level_id: row.tier_level_id,
                    tier_slug: row.tier_slug,
                    display_label: row.display_label,
                    daily_tokens: row.daily_tokens,
                },
                { onConflict: "tier_level_id", ignoreDuplicates: true },
            );
        if (error) {
            throw new Error(
                `supabase tier_limits insert failed: ${error.message}`,
            );
        }
    } else {
        await deps.query(
            `INSERT INTO public.tier_limits
                (tier_level_id, tier_slug, display_label, daily_tokens)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tier_level_id) DO NOTHING`,
            [
                row.tier_level_id,
                row.tier_slug,
                row.display_label,
                row.daily_tokens,
            ],
        );
    }
    invalidateTierLimitsCache();
}

/**
 * Partial update of one tier definition (AdminMax PATCH).
 * `entitlementsMerge` is shallow-merged over the stored jsonb; `marketing`
 * replaces it wholesale (the editor sends the complete object). Returns
 * the updated row, or null when the tier does not exist.
 */
export async function updateTierDefinition(
    tierLevelId: number,
    patch: TierDefinitionPatch,
): Promise<TierLimitsRow | null> {
    let result: TierLimitsRow | null;
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        // PostgREST has no server-side jsonb merge — read-modify-write.
        // Tier edits are a rare, single-operator action; last write wins.
        const cur = await sb
            .from("tier_limits")
            .select(COLS)
            .eq("tier_level_id", tierLevelId)
            .maybeSingle();
        if (cur.error) {
            throw new Error(
                `supabase tier_limits select failed: ${cur.error.message}`,
            );
        }
        if (!cur.data) return null;
        const existing = normalizeRow(cur.data as Record<string, unknown>);
        const upd: Record<string, unknown> = {
            updated_at: new Date().toISOString(),
        };
        if (patch.tier_slug !== undefined) upd.tier_slug = patch.tier_slug;
        if (patch.display_label !== undefined)
            upd.display_label = patch.display_label;
        if (patch.daily_tokens !== undefined)
            upd.daily_tokens = patch.daily_tokens;
        if (patch.entitlementsMerge !== undefined) {
            upd.entitlements = {
                ...existing.entitlements,
                ...patch.entitlementsMerge,
            };
        }
        if (patch.marketing !== undefined) upd.marketing = patch.marketing;
        const updated = await sb
            .from("tier_limits")
            .update(upd)
            .eq("tier_level_id", tierLevelId)
            .select(COLS)
            .maybeSingle();
        if (updated.error) {
            throw new Error(
                `supabase tier_limits update failed: ${updated.error.message}`,
            );
        }
        result = updated.data
            ? normalizeRow(updated.data as Record<string, unknown>)
            : null;
    } else {
        const updates: string[] = [];
        const values: unknown[] = [];
        let p = 1;
        if (patch.daily_tokens !== undefined) {
            updates.push(`daily_tokens = $${p++}`);
            values.push(patch.daily_tokens);
        }
        if (patch.display_label !== undefined) {
            updates.push(`display_label = $${p++}`);
            values.push(patch.display_label);
        }
        if (patch.tier_slug !== undefined) {
            updates.push(`tier_slug = $${p++}`);
            values.push(patch.tier_slug);
        }
        if (patch.entitlementsMerge !== undefined) {
            updates.push(`entitlements = entitlements || $${p++}::jsonb`);
            values.push(JSON.stringify(patch.entitlementsMerge));
        }
        if (patch.marketing !== undefined) {
            updates.push(`marketing = $${p++}::jsonb`);
            values.push(JSON.stringify(patch.marketing));
        }
        if (updates.length === 0) return getTierLimitsRow(tierLevelId);
        updates.push(`updated_at = NOW()`);
        values.push(tierLevelId);
        const res = await deps.query<Record<string, unknown>>(
            `UPDATE public.tier_limits
             SET ${updates.join(", ")}
             WHERE tier_level_id = $${p}
             RETURNING ${COLS}`,
            values,
        );
        result = res.rows.length > 0 ? normalizeRow(res.rows[0]) : null;
    }
    invalidateTierLimitsCache();
    return result;
}

/**
 * Create-or-update a tier definition (AdminMax POST). On conflict the
 * scalar columns are replaced and `entitlements` is merged (existing keys
 * survive unless overridden) — `marketing` is never touched here, matching
 * the legacy `ON CONFLICT DO UPDATE` statement.
 */
export async function upsertTierDefinition(row: {
    tier_level_id: number;
    tier_slug: string;
    display_label: string;
    daily_tokens: number;
    entitlements: Record<string, unknown>;
}): Promise<void> {
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        const cur = await sb
            .from("tier_limits")
            .select("entitlements")
            .eq("tier_level_id", row.tier_level_id)
            .maybeSingle();
        if (cur.error) {
            throw new Error(
                `supabase tier_limits select failed: ${cur.error.message}`,
            );
        }
        const merged = {
            ...(((cur.data as { entitlements?: Record<string, unknown> } | null)
                ?.entitlements ?? {}) as Record<string, unknown>),
            ...row.entitlements,
        };
        const { error } = await sb.from("tier_limits").upsert(
            {
                tier_level_id: row.tier_level_id,
                tier_slug: row.tier_slug,
                display_label: row.display_label,
                daily_tokens: row.daily_tokens,
                entitlements: merged,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "tier_level_id" },
        );
        if (error) {
            throw new Error(
                `supabase tier_limits upsert failed: ${error.message}`,
            );
        }
    } else {
        await deps.query(
            `INSERT INTO public.tier_limits
                (tier_level_id, tier_slug, display_label, daily_tokens, entitlements)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT (tier_level_id) DO UPDATE
             SET tier_slug = EXCLUDED.tier_slug,
                 display_label = EXCLUDED.display_label,
                 daily_tokens = EXCLUDED.daily_tokens,
                 entitlements = public.tier_limits.entitlements || EXCLUDED.entitlements,
                 updated_at = NOW()`,
            [
                row.tier_level_id,
                row.tier_slug,
                row.display_label,
                row.daily_tokens,
                JSON.stringify(row.entitlements),
            ],
        );
    }
    invalidateTierLimitsCache();
}

/**
 * Fill `entitlements` with code-catalog defaults ONLY where the column is
 * still empty (`{}` / NULL) — the boot seeder contract that never clobbers
 * an admin's later edits. No-op when the tier row does not exist.
 */
export async function seedEntitlementsIfEmpty(
    tierLevelId: number,
    values: Record<string, unknown>,
): Promise<void> {
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        const cur = await sb
            .from("tier_limits")
            .select("entitlements")
            .eq("tier_level_id", tierLevelId)
            .maybeSingle();
        if (cur.error) {
            throw new Error(
                `supabase tier_limits select failed: ${cur.error.message}`,
            );
        }
        if (!cur.data) return;
        const existing = (cur.data as { entitlements?: unknown }).entitlements;
        if (existing && Object.keys(existing as object).length > 0) return;
        const { error } = await sb
            .from("tier_limits")
            .update({ entitlements: values })
            .eq("tier_level_id", tierLevelId);
        if (error) {
            throw new Error(
                `supabase tier_limits update failed: ${error.message}`,
            );
        }
    } else {
        await deps.query(
            `UPDATE public.tier_limits
                SET entitlements = $2::jsonb
              WHERE tier_level_id = $1
                AND (entitlements IS NULL OR entitlements = '{}'::jsonb)`,
            [tierLevelId, JSON.stringify(values)],
        );
    }
    invalidateTierLimitsCache();
}

/** Same fill-if-empty contract for the `marketing` jsonb. */
export async function seedMarketingIfEmpty(
    tierLevelId: number,
    values: Record<string, unknown>,
): Promise<void> {
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        const cur = await sb
            .from("tier_limits")
            .select("marketing")
            .eq("tier_level_id", tierLevelId)
            .maybeSingle();
        if (cur.error) {
            throw new Error(
                `supabase tier_limits select failed: ${cur.error.message}`,
            );
        }
        if (!cur.data) return;
        const existing = (cur.data as { marketing?: unknown }).marketing;
        if (existing && Object.keys(existing as object).length > 0) return;
        const { error } = await sb
            .from("tier_limits")
            .update({ marketing: values })
            .eq("tier_level_id", tierLevelId);
        if (error) {
            throw new Error(
                `supabase tier_limits update failed: ${error.message}`,
            );
        }
    } else {
        await deps.query(
            `UPDATE public.tier_limits
                SET marketing = $2::jsonb
              WHERE tier_level_id = $1
                AND (marketing IS NULL OR marketing = '{}'::jsonb)`,
            [tierLevelId, JSON.stringify(values)],
        );
    }
    invalidateTierLimitsCache();
}

/**
 * Unconditional replace of the `marketing` jsonb (the one-time pricing
 * relaunch in lib/planCatalog.ts — guarded there by `app_migrations`).
 */
export async function overwriteMarketing(
    tierLevelId: number,
    values: Record<string, unknown>,
): Promise<void> {
    if (tiersFromSupabase()) {
        const sb = deps.getSupabaseClient();
        const { error } = await sb
            .from("tier_limits")
            .update({ marketing: values })
            .eq("tier_level_id", tierLevelId);
        if (error) {
            throw new Error(
                `supabase tier_limits update failed: ${error.message}`,
            );
        }
    } else {
        await deps.query(
            `UPDATE public.tier_limits
                SET marketing = $2::jsonb
              WHERE tier_level_id = $1`,
            [tierLevelId, JSON.stringify(values)],
        );
    }
    invalidateTierLimitsCache();
}
