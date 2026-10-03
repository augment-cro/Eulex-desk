/**
 * How an operator should read a user's tier in AdminMax.
 *
 * `user_tier_state` keeps the last grant as written — level and
 * `active_tier_until` — and the tier simply stops applying once the date
 * passes. Nothing is written at that moment, so the raw row still says
 * "Legal Pro" and the history has no "→ Free" row, while the user is on
 * Free everywhere else (auth, quotas, the users list). Trial grants
 * ("5 dana gratis") made that look like a lost downgrade (BugFix 2. 10.).
 *
 * The newest tier_change_history row is the write that produced the
 * current state (recordTierChange only logs real transitions), so its
 * source + reason tell who granted it: a Stripe subscription, an offline
 * payment posted by the billing service (source "admin", reason
 * "ext:<service>:…"), the partner site, or an operator by hand.
 */
export type GrantKind = "manual" | "stripe" | "external" | "ump" | "unknown";

/** Every seam service writes "ext:<service>:…" (externalGrants.grantReasonPrefix). */
const EXTERNAL_REASON_PREFIX = "ext:";

export function grantKind(
    source: string | null | undefined,
    reason: string | null | undefined,
): GrantKind {
    if (source === "stripe") return "stripe";
    if (source === "ump_sync") return "ump";
    if (source === "admin") {
        return (reason ?? "").startsWith(EXTERNAL_REASON_PREFIX)
            ? "external"
            : "manual";
    }
    return "unknown";
}

export interface TierGrantView {
    /** Level the user actually has now; null = free (none or expired). */
    effectiveLevelId: number | null;
    /** A paid grant exists but its `until` has passed. */
    expired: boolean;
    /** Who wrote the grant; null when there is no grant at all. */
    kind: GrantKind | null;
}

export function describeTierGrant(
    state: {
        level: number | null;
        until: Date | string | null;
        source: string | null;
        reason: string | null;
    },
    now: Date = new Date(),
): TierGrantView {
    if (state.level == null) {
        return { effectiveLevelId: null, expired: false, kind: null };
    }
    const until = state.until == null ? null : new Date(state.until);
    const expired =
        until != null && !Number.isNaN(until.getTime()) && until <= now;
    return {
        effectiveLevelId: expired ? null : state.level,
        expired,
        kind: grantKind(state.source, state.reason),
    };
}

export interface TierHistoryEntry {
    id: string;
    old_tier_level_id: number | null;
    new_tier_level_id: number | null;
    old_until: string | null;
    new_until: string | null;
    source: string;
    reason: string | null;
    created_at: string;
    old_label: string | null;
    new_label: string | null;
}

/**
 * The "→ Free" row the history never got: dated at `until`, computed on
 * read (not stored), and only while the expired grant is still the
 * current state — a later grant or clear would have replaced it.
 */
export function expiryHistoryEntry(
    state: {
        level: number | null;
        until: Date | string | null;
        label: string | null;
    },
    now: Date = new Date(),
): TierHistoryEntry | null {
    if (state.level == null || state.until == null) return null;
    const until = new Date(state.until);
    if (Number.isNaN(until.getTime()) || until > now) return null;
    const iso = until.toISOString();
    return {
        id: `expiry-${iso}`,
        old_tier_level_id: state.level,
        new_tier_level_id: null,
        old_until: iso,
        new_until: null,
        source: "expiry",
        reason: "Istekao rok dodjele",
        created_at: iso,
        old_label: state.label,
        new_label: null,
    };
}
