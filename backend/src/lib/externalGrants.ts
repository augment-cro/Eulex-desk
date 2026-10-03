/**
 * Plan grants posted by an external seam service (today: the billing
 * provider, for offline-paid plans). The service decides WHAT the user
 * should have and until when; the core decides whether to write it:
 *
 *   • only paid plan levels the core itself sells, bounded in time;
 *   • never over a live grant from someone else (Stripe, AdminMax,
 *     the partner site) of equal or higher rank;
 *   • withdrawing (grant = null) only ends a grant this service wrote.
 *
 * Grants land in user_tier_state like every other override (source
 * "admin", reason prefixed "ext:<service>:"), so auth, entitlements and
 * the tier history need nothing new.
 */
import { query } from "./db";
import { setLocalTierActive } from "./membership";
import { TIER_RANK, tierKeyForLevelId } from "./entitlements";
import { getPlanDefs } from "./stripe";
import type { SeamService } from "./seams/serviceIdentity";

const MAX_GRANT_DAYS = 400;

export interface ExternalGrant {
    tierLevelId: number;
    until: Date;
    label: string;
}

export function grantReasonPrefix(service: SeamService): string {
    return `ext:${service}:`;
}

/** Parse + bound a grant body. Null grant = "nothing from this service". */
export function parseExternalGrant(
    raw: unknown,
    now: Date = new Date(),
): { ok: true; grant: ExternalGrant | null } | { ok: false; error: string } {
    if (raw === null) return { ok: true, grant: null };
    if (!raw || typeof raw !== "object") return { ok: false, error: "grant must be an object or null" };
    const g = raw as Record<string, unknown>;
    const level = Number(g.tier_level_id);
    if (!getPlanDefs().some((p) => p.tierLevelId === level)) {
        return { ok: false, error: "tier_level_id is not a paid plan" };
    }
    const until = new Date(String(g.until ?? ""));
    if (Number.isNaN(until.getTime())) return { ok: false, error: "until must be an ISO timestamp" };
    if (until.getTime() > now.getTime() + MAX_GRANT_DAYS * 86_400_000) {
        return { ok: false, error: "until is too far in the future" };
    }
    const label = typeof g.label === "string" ? g.label.trim().slice(0, 200) : "";
    return { ok: true, grant: { tierLevelId: level, until, label } };
}

export interface CurrentOverride {
    level: number | null;
    until: Date | null;
    /** Reason on the newest tier_change_history row. */
    reason: string | null;
}

export type GrantDecision =
    | { action: "none"; why: "unchanged" | "stronger-grant" | "nothing-to-end" }
    | { action: "set"; level: number; until: Date; reason: string };

/** Pure decision, unit-tested; applyExternalGrant does the I/O. */
export function decideExternalGrant(
    service: SeamService,
    current: CurrentOverride,
    grant: ExternalGrant | null,
    now: Date = new Date(),
): GrantDecision {
    const prefix = grantReasonPrefix(service);
    const active = current.level != null && (!current.until || current.until > now);
    const ours = (current.reason ?? "").startsWith(prefix);
    if (!grant) {
        if (active && ours) {
            return { action: "set", level: current.level!, until: now, reason: `${prefix} pristup završen` };
        }
        return { action: "none", why: "nothing-to-end" };
    }
    if (active && !ours) {
        const curRank = TIER_RANK[tierKeyForLevelId(current.level!)];
        const newRank = TIER_RANK[tierKeyForLevelId(grant.tierLevelId)];
        if (curRank >= newRank) return { action: "none", why: "stronger-grant" };
    }
    if (current.level === grant.tierLevelId && current.until?.getTime() === grant.until.getTime()) {
        return { action: "none", why: "unchanged" };
    }
    return {
        action: "set",
        level: grant.tierLevelId,
        until: grant.until,
        reason: `${prefix} ${grant.label}`.trim(),
    };
}

export async function applyExternalGrant(
    service: SeamService,
    userId: string,
    grant: ExternalGrant | null,
): Promise<GrantDecision> {
    const r = await query<{
        active_tier_level_id: number | null;
        active_tier_until: string | Date | null;
        reason: string | null;
    }>(
        `SELECT s.active_tier_level_id, s.active_tier_until, h.reason
           FROM public.user_tier_state s
           LEFT JOIN LATERAL (
               SELECT reason FROM public.tier_change_history
                WHERE user_id = s.user_id
                ORDER BY created_at DESC LIMIT 1
           ) h ON true
          WHERE s.user_id = $1`,
        [userId],
    );
    const row = r.rows[0];
    const decision = decideExternalGrant(service, {
        level: row?.active_tier_level_id ?? null,
        until: row?.active_tier_until ? new Date(row.active_tier_until) : null,
        reason: row?.reason ?? null,
    }, grant);
    if (decision.action === "set") {
        await setLocalTierActive(userId, decision.level, decision.until, {}, {
            source: "admin",
            reason: decision.reason,
        });
    }
    return decision;
}

/**
 * True when the user's live grant comes from a Stripe subscription — an
 * offline-paid plan would then fight the Stripe webhook over the tier.
 */
export async function stripeGrantActive(userId: string): Promise<boolean> {
    const r = await query<{ source: string }>(
        `SELECT h.source
           FROM public.user_tier_state s
           JOIN LATERAL (
               SELECT source FROM public.tier_change_history
                WHERE user_id = s.user_id
                ORDER BY created_at DESC LIMIT 1
           ) h ON true
          WHERE s.user_id = $1
            AND s.active_tier_level_id IS NOT NULL
            AND (s.active_tier_until IS NULL OR s.active_tier_until > now())`,
        [userId],
    );
    return r.rows[0]?.source === "stripe";
}
