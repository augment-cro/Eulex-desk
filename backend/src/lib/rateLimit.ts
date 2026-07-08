/**
 * Tier-based, token-only rate limiting for LLM-fronting routes.
 *
 * Source of truth is the `llm_usage` table (Postgres). We compute used
 * tokens for the rolling 24h window directly from there — no Redis,
 * no in-memory counters, no shadow store. With <1k rows per user per
 * day and the existing `idx_llm_usage_user_created` index, the lookup
 * is single-digit ms.
 *
 * Effective budget = tier daily quota (rolling 24h) + active credit
 * packs (`user_token_credits`, FIFO). Daily quota replenishes; credit
 * packs are static. Rate limiter sums both for the "remaining" number
 * exposed to the UI and to enforcement.
 *
 * Header conventions follow the IETF `RateLimit-*` draft so our banner
 * picks them up without bespoke parsing per route. We keep the window
 * fixed at 86400 seconds (24h rolling) — see plan section 1.
 *
 * @module rateLimit
 */

import type { RequestHandler } from "express";
import { query } from "./db";
import { can, getEntitlements } from "./entitlements";
import { ensureTierRow, getTierLimitsRow } from "./tierLimitsStore";

/** Window width in seconds, exposed via `RateLimit-Limit` w= parameter. */
export const WINDOW_SECONDS = 86_400;

/** Soft warning threshold (banner switches from hidden to "soft"). */
export const SOFT_WARNING_THRESHOLD = 0.8;

/** Default tier when no row exists in tier_limits AND no JWT field. */
const FREE_DEFAULT_LABEL = "Eulex FREE";
const FREE_DEFAULT_SLUG = "eulex_free";
const FREE_DEFAULT_TOKENS = 1_000_000;

export type TierInfo = {
    tierLevelId: number;
    slug: string;
    label: string;
};

export type ActiveCredits = {
    /** Sum of `tokens_granted - tokens_consumed` over active packs. */
    bonusRemaining: number;
    /** Number of active (non-voided, non-expired) packs. */
    packCount: number;
    /** Earliest expires_at among active packs (null = never). */
    earliestExpiresAt: Date | null;
};

export type RateLimitSnapshot = {
    tier: TierInfo;
    /** Tokens consumed in rolling 24h window. */
    usedTokensWindow: number;
    /** Daily quota from tier_limits.daily_tokens. */
    dailyTokens: number;
    /** Bonus tokens left in active credit packs (FIFO sum). */
    bonusRemaining: number;
    /** dailyTokens + bonusRemaining (never negative). */
    effectiveLimit: number;
    /** max(0, effectiveLimit - usedTokensWindow). */
    remainingTokens: number;
    /** Number of LLM requests in window (info only — never enforces). */
    questionsInWindow: number;
    /** Estimated time when oldest usage row falls out of window. */
    nextReliefAt: Date | null;
    /** Whether the user is currently over the cap. */
    over: boolean;
    /**
     * Whether this tier may buy token packs (the `buyTokenPacks`
     * entitlement — Plus and up). Drives the banner's "Nadoplati" CTA vs
     * the Free-only "Pogledaj Plus" upsell, so higher tiers are never told
     * to "upgrade to Plus" (a downgrade).
     */
    topupAvailable: boolean;
};

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/**
 * Look up the tier definition for the given JWT tier_level_id (via
 * tierLimitsStore — Supabase or the legacy mike table, 60s row cache).
 * If the row is missing, lazy-upsert one with eulex_free defaults so the
 * next call is cheap and the admin can adjust it later without a code
 * change.
 */
export async function resolveTierLimits(
    tierLevelId: number,
    tierSlugFromJwt: string | null | undefined,
): Promise<{ daily_tokens: number; tier_slug: string; display_label: string }> {
    const existing = await getTierLimitsRow(tierLevelId);
    if (existing) {
        return {
            daily_tokens: existing.daily_tokens,
            tier_slug: existing.tier_slug,
            display_label: existing.display_label,
        };
    }

    // Unknown tier_level_id — best-effort defaults. Use the JWT slug
    // verbatim so admin sees what to label it; default cap is the free
    // tier so a misconfigured prod doesn't accidentally hand out 3M
    // tokens to a brand-new tier.
    const slug = (tierSlugFromJwt && tierSlugFromJwt.trim()) || FREE_DEFAULT_SLUG;
    const label = slug === "eulex_plus" ? "Eulex Plus" : FREE_DEFAULT_LABEL;
    await ensureTierRow({
        tier_level_id: tierLevelId,
        tier_slug: slug,
        display_label: label,
        daily_tokens: FREE_DEFAULT_TOKENS,
    });
    return {
        daily_tokens: FREE_DEFAULT_TOKENS,
        tier_slug: slug,
        display_label: label,
    };
}

// ---------------------------------------------------------------------------
// Rolling-window aggregate
// ---------------------------------------------------------------------------

/**
 * Single-query aggregate over the 24h rolling window. Sums the four
 * Anthropic-shape token columns (input + output + cache_creation +
 * cache_read) — the "billing total" formula. Switch to the cache-aware
 * variant by dropping `cache_read_input_tokens` from the SUM expression
 * if Anthropic-aligned semantics are needed (no migration required).
 */
export async function getRollingTokenUsage(userId: string): Promise<{
    tokens: number;
    questions: number;
    nextReliefAt: Date | null;
}> {
    const { rows } = await query<{
        tokens: string | number | null;
        questions: string | number | null;
        oldest: string | Date | null;
    }>(
        `SELECT
            COALESCE(SUM(
                input_tokens
              + output_tokens
              + cache_creation_input_tokens
              + cache_read_input_tokens
            ), 0)::bigint AS tokens,
            COUNT(*)      AS questions,
            MIN(created_at) AS oldest
        FROM public.llm_usage
        WHERE user_id = $1
          AND created_at >= NOW() - INTERVAL '24 hours'`,
        [userId],
    );
    const r = rows[0];
    const oldest = r.oldest ? new Date(r.oldest as string) : null;
    return {
        tokens: Number(r.tokens ?? 0),
        questions: Number(r.questions ?? 0),
        nextReliefAt: oldest
            ? new Date(oldest.getTime() + WINDOW_SECONDS * 1000)
            : null,
    };
}

// ---------------------------------------------------------------------------
// Credit packs (top-up)
// ---------------------------------------------------------------------------

/**
 * Sum of remaining bonus tokens over all active credit packs (non-
 * voided, not expired, with positive remainder). Earliest expiry is
 * returned so the banner can warn before a pack burns out.
 */
export async function getActiveCredits(userId: string): Promise<ActiveCredits> {
    const { rows } = await query<{
        bonus_remaining: string | number | null;
        pack_count: string | number | null;
        earliest_expires_at: string | Date | null;
    }>(
        `SELECT
            COALESCE(SUM(tokens_granted - tokens_consumed), 0)::bigint AS bonus_remaining,
            COUNT(*)                                                   AS pack_count,
            MIN(expires_at)                                            AS earliest_expires_at
        FROM public.user_token_credits
        WHERE user_id = $1
          AND voided_at IS NULL
          AND tokens_consumed < tokens_granted
          AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId],
    );
    const r = rows[0];
    return {
        bonusRemaining: Number(r.bonus_remaining ?? 0),
        packCount: Number(r.pack_count ?? 0),
        earliestExpiresAt: r.earliest_expires_at
            ? new Date(r.earliest_expires_at as string)
            : null,
    };
}

/**
 * Consume `overage` tokens from active credit packs in FIFO order
 * (oldest pack first). Called AFTER `recordLlmUsage` whenever the
 * post-call rolling-window total exceeds the daily tier quota — only
 * the part beyond the quota draws from the bonus pool.
 *
 * Returns the actual amount drawn (may be less than `overage` if the
 * user has fewer credits than needed).
 */
export async function consumeCredits(
    userId: string,
    overage: number,
): Promise<number> {
    if (overage <= 0) return 0;
    let remaining = overage;
    let drawn = 0;
    const { rows: packs } = await query<{
        id: string;
        available: string | number;
    }>(
        `SELECT
            id,
            (tokens_granted - tokens_consumed)::bigint AS available
        FROM public.user_token_credits
        WHERE user_id = $1
          AND voided_at IS NULL
          AND tokens_consumed < tokens_granted
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY granted_at ASC, id ASC
        FOR UPDATE`,
        [userId],
    );
    for (const p of packs) {
        if (remaining <= 0) break;
        const avail = Number(p.available);
        if (avail <= 0) continue;
        const take = Math.min(avail, remaining);
        await query(
            `UPDATE public.user_token_credits
             SET tokens_consumed = tokens_consumed + $1
             WHERE id = $2`,
            [take, p.id],
        );
        remaining -= take;
        drawn += take;
    }
    return drawn;
}

// ---------------------------------------------------------------------------
// Snapshot + check
// ---------------------------------------------------------------------------

/**
 * Build the full rate-limit snapshot for a single user. Used by the
 * status endpoint and by `enforceRateLimit` for header population.
 */
export async function getRateLimitSnapshot(
    userId: string,
    tierLevelId: number,
    tierSlugFromJwt: string | null | undefined,
): Promise<RateLimitSnapshot> {
    const [tierLimits, usage, credits] = await Promise.all([
        resolveTierLimits(tierLevelId, tierSlugFromJwt),
        getRollingTokenUsage(userId),
        getActiveCredits(userId),
    ]);
    const dailyTokens = tierLimits.daily_tokens;
    const bonusRemaining = credits.bonusRemaining;
    const effectiveLimit = dailyTokens + bonusRemaining;
    const remainingTokens = Math.max(0, effectiveLimit - usage.tokens);
    // Never fail the whole snapshot on an entitlement-lookup hiccup — a
    // metering bug must not block the user. Default to false (Free-like).
    let topupAvailable = false;
    try {
        topupAvailable = can(await getEntitlements(tierLevelId), "buyTokenPacks");
    } catch {
        /* default false on lookup failure */
    }
    return {
        tier: {
            tierLevelId,
            slug: tierLimits.tier_slug,
            label: tierLimits.display_label,
        },
        usedTokensWindow: usage.tokens,
        dailyTokens,
        bonusRemaining,
        effectiveLimit,
        remainingTokens,
        questionsInWindow: usage.questions,
        nextReliefAt: usage.nextReliefAt,
        over: usage.tokens >= effectiveLimit,
        topupAvailable,
    };
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/**
 * Apply IETF `RateLimit-*` headers to a response. Safe to call before
 * `flushHeaders()`. Adds Eulex Desk-specific extensions (`X-RateLimit-*`) so
 * the frontend hook can also surface bonus tokens and tier label
 * without a separate fetch.
 */
export function setRateLimitHeaders(
    res: import("express").Response,
    snap: RateLimitSnapshot,
): void {
    const reset = nextReliefSeconds(snap.nextReliefAt);
    res.setHeader(
        "RateLimit-Limit",
        `${snap.effectiveLimit};w=${WINDOW_SECONDS}`,
    );
    res.setHeader("RateLimit-Remaining", String(snap.remainingTokens));
    res.setHeader("RateLimit-Reset", String(reset));
    res.setHeader("X-RateLimit-Used-Tokens", String(snap.usedTokensWindow));
    res.setHeader("X-RateLimit-Daily-Tokens", String(snap.dailyTokens));
    res.setHeader("X-RateLimit-Bonus-Tokens", String(snap.bonusRemaining));
    res.setHeader("X-RateLimit-Questions", String(snap.questionsInWindow));
    res.setHeader("X-RateLimit-Tier-Slug", snap.tier.slug);
    res.setHeader("X-RateLimit-Tier-Label", snap.tier.label);
    res.setHeader(
        "X-RateLimit-Topup-Available",
        snap.topupAvailable ? "1" : "0",
    );
}

function nextReliefSeconds(nextReliefAt: Date | null): number {
    if (!nextReliefAt) return WINDOW_SECONDS;
    const ms = nextReliefAt.getTime() - Date.now();
    if (ms <= 0) return 1;
    return Math.min(WINDOW_SECONDS, Math.max(1, Math.round(ms / 1000)));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware: blocks requests with HTTP 429 when the rolling
 * 24h window plus active credits is exhausted. Always sets the
 * `RateLimit-*` headers — frontend banner reads them on every reply.
 *
 * Looks for `res.locals.userId` and `res.locals.tierLevelId` (set by
 * `requireAuth`). If either is missing the middleware is a no-op
 * (treats the route as un-authenticated).
 */
export function enforceRateLimit(): RequestHandler {
    return async (_req, res, next) => {
        const userId = res.locals.userId as string | undefined;
        const tierLevelId = res.locals.tierLevelId as number | undefined;
        const tierSlug = res.locals.tier as string | undefined;
        if (!userId || typeof tierLevelId !== "number") {
            next();
            return;
        }
        try {
            const snap = await getRateLimitSnapshot(
                userId,
                tierLevelId,
                tierSlug ?? null,
            );
            setRateLimitHeaders(res, snap);
            // Stash the snapshot so the route can read it without a
            // second DB query (e.g. tabular batch loops).
            res.locals.rateLimit = snap;
            if (!snap.over) {
                next();
                return;
            }
            const retrySec = nextReliefSeconds(snap.nextReliefAt);
            res.setHeader("Retry-After", String(retrySec));
            console.log(
                `[ratelimit] hit user=${userId} tier=${snap.tier.slug} ` +
                    `used=${snap.usedTokensWindow} limit=${snap.effectiveLimit} ` +
                    `daily=${snap.dailyTokens} bonus=${snap.bonusRemaining}`,
            );
            // Top-up is offered to any tier whose `buyTokenPacks`
            // entitlement is on (Plus and up) — not a hardcoded slug check,
            // so Pro/Team get the "Nadoplati" hint too. Already resolved on
            // the snapshot; reuse it rather than a second entitlement lookup.
            const topupAvailable = snap.topupAvailable;
            res.status(429).json({
                detail: "Token quota exceeded for this 24h rolling window.",
                code: "RATE_LIMITED",
                reason: "tokens",
                limit_tokens: snap.effectiveLimit,
                used_tokens: snap.usedTokensWindow,
                daily_tokens: snap.dailyTokens,
                bonus_remaining: snap.bonusRemaining,
                next_relief_at: snap.nextReliefAt?.toISOString() ?? null,
                tier: { slug: snap.tier.slug, label: snap.tier.label },
                upgrade_hint: topupAvailable
                    ? "Možete nadoplatiti dodatne tokene s 'Nadoplati' u banneru."
                    : "Nadogradite na višu pretplatu za veću dnevnu kvotu.",
                topup_available: topupAvailable,
            });
        } catch (err) {
            // Never block the user on a metering bug — log and pass.
            // The request still records usage, so this only widens the
            // window slightly during a Postgres outage.
            console.error("[ratelimit] check failed:", err);
            next();
        }
    };
}

/**
 * Pure-headers variant: sets `RateLimit-*` headers without enforcement.
 * Use on routes where the frontend wants the banner data but we don't
 * want to gate the call (e.g. `GET /user/profile`).
 */
export function attachRateLimitHeaders(): RequestHandler {
    return async (_req, res, next) => {
        const userId = res.locals.userId as string | undefined;
        const tierLevelId = res.locals.tierLevelId as number | undefined;
        const tierSlug = res.locals.tier as string | undefined;
        if (!userId || typeof tierLevelId !== "number") {
            next();
            return;
        }
        try {
            const snap = await getRateLimitSnapshot(
                userId,
                tierLevelId,
                tierSlug ?? null,
            );
            setRateLimitHeaders(res, snap);
            res.locals.rateLimit = snap;
        } catch (err) {
            console.error("[ratelimit] header attach failed:", err);
        }
        next();
    };
}
