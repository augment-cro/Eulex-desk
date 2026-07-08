/**
 * Internal partner-site membership push.
 *
 * The Eulex Desk app owns the Plus subscription (Stripe Subscription created
 * by /billing/plus/checkout, webhook landing on /billing/stripe/webhook).
 * Whenever a subscription transitions to/from active, we mirror the
 * resulting tier into:
 *
 *   1. `public.user_tier_state` (local, authoritative for our auth
 *      middleware so requests rate-limit at the new tier instantly).
 *      Kept in a separate table because Cloud SQL often leaves
 *      `public.users` owned by `postgres`, so the app's IAM role cannot
 *      ALTER users.

 *   2. `public.ump_user_level_assignments` — optional mirror of UMP
 *      levels we observed (rebuilt when Stripe or UMP pull updates tier).

 *   3. The partner site's membership database via a single internal
 *      HTTP endpoint guarded by a shared secret. The partner site
 *      decides how to translate the push (e.g. assigning a UMP level
 *      on the existing customer record). The contract intentionally
 *      stays small — a dumb pipe — so we don't leak partner internals
 *      into this codebase.
 *
 * Required env:
 *
 *   EULEX_WP_INTERNAL_URL     — full URL to POST to. If missing, the
 *                               push is a silent no-op (tier still
 *                               mirrored locally so Eulex Desk keeps working
 *                               in isolation).
 *   EULEX_WP_INTERNAL_SECRET  — shared bearer token. Compared by
 *                               constant-time equality on the partner
 *                               side. If unset, we never make the call.
 *
 * @module membership
 */
import crypto from "node:crypto";
import { query } from "./db";
import { getTierLimitsRow } from "./tierLimitsStore";
import {
    getEnterpriseTierLevelId,
    getEulexLegalTeamTierLevelId,
    getFreeTierLevelId,
    getLegalProTierLevelId,
    getPlusTierLevelId,
    getProTierLevelId,
    getTeamTierLevelId,
} from "./stripe";
import {
    isSupabaseAdminConfigured,
    updateSupabaseUserTier,
} from "./supabaseAdmin";

/** Any recognised paid level (plus / pro / legal_pro / team / eulex_legal_team
 *  / enterprise) — i.e. not free/unknown. */
function isPaidLevel(levelId: number): boolean {
    return (
        levelId === getPlusTierLevelId() ||
        levelId === getProTierLevelId() ||
        levelId === getLegalProTierLevelId() ||
        levelId === getTeamTierLevelId() ||
        levelId === getEulexLegalTeamTierLevelId() ||
        levelId === getEnterpriseTierLevelId()
    );
}

export type MembershipAction = "assign" | "revoke";

export type MembershipPushPayload = {
    /** Internal user identifier for the partner site (WordPress user_id). */
    wp_user_id: number;
    /** Membership level the partner site should set or remove. */
    level_id: number;
    /** "assign" → set level active, "revoke" → mark expired/removed. */
    action: MembershipAction;
    /** ISO-8601 expiry; partner side may treat absence as "no change". */
    expires_at?: string | null;
    /** Optional Stripe customer/subscription correlation for audit. */
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
    /** Free-form note that the partner side may store next to the change. */
    reason?: string | null;
    /**
     * Idempotency key. Partner side should drop duplicates by this id
     * (e.g. Stripe event id) so retries don't double-extend membership.
     */
    request_id: string;
    /** ISO-8601 wall-clock for human-friendly audit logs. */
    sent_at: string;
};

function partnerUrl(): string | null {
    const u = process.env.EULEX_WP_INTERNAL_URL?.trim();
    return u && u.length > 0 ? u : null;
}

function partnerSecret(): string | null {
    const s = process.env.EULEX_WP_INTERNAL_SECRET?.trim();
    return s && s.length > 0 ? s : null;
}

/**
 * Base URL of the partner side's `/eulex-internal/v1` namespace,
 * derived from EULEX_WP_INTERNAL_URL (which points to the membership
 * push endpoint). Used so we don't need to add a second env var for
 * each new internal endpoint.
 */
function partnerBaseUrl(): string | null {
    const u = partnerUrl();
    if (!u) return null;
    // strip "/membership" if present, leave the namespace intact.
    return u.replace(/\/membership\/?$/, "");
}

/**
 * `true` once both the URL and the shared secret are configured. UI
 * surfaces (frontend `/billing/plus/config`) read this so they can
 * disable Plus checkout when the partner side is not yet wired.
 */
export function isPartnerPushConfigured(): boolean {
    return partnerUrl() !== null && partnerSecret() !== null;
}

/**
 * Push a membership change to the partner site. Returns the upstream
 * status + body for logging; never throws on non-2xx so the caller
 * (Stripe webhook) can still 200 back to Stripe and rely on retries.
 */
export async function pushMembershipChange(
    payload: MembershipPushPayload,
): Promise<{ ok: boolean; status: number; body: string }> {
    const url = partnerUrl();
    const secret = partnerSecret();
    if (!url || !secret) {
        console.warn(
            "[membership] partner push skipped — EULEX_WP_INTERNAL_URL or _SECRET unset",
        );
        return { ok: false, status: 0, body: "partner not configured" };
    }
    const body = JSON.stringify(payload);
    // HMAC the body with the shared secret so the partner can verify
    // both authenticity and integrity in one step. Header name follows
    // the same shape as Stripe's `Stripe-Signature` so it's easy to
    // remember on the partner side.
    const signature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${secret}`,
                "X-Eulex-Signature": `sha256=${signature}`,
                "X-Eulex-Request-Id": payload.request_id,
            },
            body,
            signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
            console.error(
                `[membership] partner push failed: ${res.status} ${text.slice(0, 500)}`,
            );
        } else {
            console.log(
                `[membership] partner push ok: user=${payload.wp_user_id} level=${payload.level_id} action=${payload.action}`,
            );
        }
        return { ok: res.ok, status: res.status, body: text };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[membership] partner push threw:", msg);
        return { ok: false, status: 0, body: msg };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Replace UMP mirror rows for this Eulex Desk user. Empty `levels` deletes all
 * rows — e.g. cancel / downgrade aligned with UMP.
 */
export async function replaceUmpUserLevels(
    userId: string,
    levels: Array<{
        level_id: number;
        expire_at: Date | null;
        status: string | null;
    }>,
): Promise<void> {
    const u = await query<{ wp_user_id: string | number | null }>(
        `SELECT wp_user_id FROM public.users WHERE id = $1`,
        [userId],
    );
    const wp = u.rows[0]?.wp_user_id;
    if (wp == null) return;
    const wpNum = typeof wp === "string" ? parseInt(wp, 10) : Number(wp);
    if (!Number.isFinite(wpNum)) return;
    await query(`DELETE FROM public.ump_user_level_assignments WHERE user_id = $1`, [
        userId,
    ]);
    for (const row of levels) {
        // Idempotent upsert: two concurrent requireAuth UMP pulls for the same
        // user can both DELETE then INSERT the same (user_id, level_id), and the
        // second INSERT would otherwise hit the PK and log a spurious
        // "duplicate key" warning. ON CONFLICT makes the write race-safe.
        await query(
            `INSERT INTO public.ump_user_level_assignments (
                user_id, wp_user_id, level_id, expire_at, status, synced_at
            ) VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (user_id, level_id) DO UPDATE SET
                wp_user_id = excluded.wp_user_id,
                expire_at  = excluded.expire_at,
                status     = excluded.status,
                synced_at  = now()`,
            [userId, wpNum, row.level_id, row.expire_at, row.status],
        );
    }
}

// ─── Local tier override ────────────────────────────────────────────────

/** Who initiated a tier transition — lands in tier_change_history. */
export type TierChangeSource = "stripe" | "ump_sync" | "admin";

/**
 * Read the current override so we can detect whether a write actually
 * changes the tier (Stripe replays the same event family several times
 * per order — created → updated → invoice.paid — and we want ONE
 * history row per real transition, not three).
 */
async function readTierState(userId: string): Promise<{
    level: number | null;
    until: string | null;
}> {
    const r = await query<{
        active_tier_level_id: number | null;
        active_tier_until: string | null;
    }>(
        `SELECT active_tier_level_id, active_tier_until
           FROM public.user_tier_state WHERE user_id = $1`,
        [userId],
    );
    return {
        level: r.rows[0]?.active_tier_level_id ?? null,
        until: r.rows[0]?.active_tier_until ?? null,
    };
}

/**
 * Append a tier transition to the audit log iff something changed.
 * Best-effort: an audit insert must never fail the webhook / auth path
 * that triggered the tier write.
 */
async function recordTierChange(
    userId: string,
    before: { level: number | null; until: string | null },
    after: { level: number | null; until: Date | string | null },
    source: TierChangeSource,
    reason: string | null,
): Promise<void> {
    const afterUntilIso =
        after.until == null
            ? null
            : after.until instanceof Date
              ? after.until.toISOString()
              : new Date(after.until).toISOString();
    const beforeUntilIso = before.until
        ? new Date(before.until).toISOString()
        : null;
    const levelChanged = (before.level ?? null) !== (after.level ?? null);
    const untilChanged = beforeUntilIso !== afterUntilIso;
    if (!levelChanged && !untilChanged) return;
    try {
        await query(
            `INSERT INTO public.tier_change_history (
                user_id, old_tier_level_id, new_tier_level_id,
                old_until, new_until, source, reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                userId,
                before.level,
                after.level,
                beforeUntilIso,
                afterUntilIso,
                source,
                reason,
            ],
        );
    } catch (err) {
        console.warn(
            `[membership] tier_change_history insert failed for user=${userId}:`,
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Best-effort mirror of a user's tier into the Supabase user's
 * `app_metadata`. Called from setLocalTierActive / clearLocalTierOverride
 * so EVERY tier change (Stripe webhook, AdminMax, ump_sync) propagates to
 * the Supabase auth user.
 *
 * Convenience denormalization only — `user_tier_state` stays authoritative
 * and is enforced server-side; the JWT picks the mirrored value up on its
 * next session refresh. No-ops when Supabase admin isn't configured (dev)
 * or the user has no Supabase identity (WP-only account). Never throws — a
 * mirror failure must not break the local tier write that triggered it.
 */
async function mirrorTierToSupabase(
    userId: string,
    levelId: number | null,
    until: Date | string | null,
): Promise<void> {
    if (!isSupabaseAdminConfigured()) return;
    try {
        const ident = await query<{ supabase_user_id: string }>(
            `SELECT supabase_user_id FROM public.user_supabase_identity
              WHERE user_id = $1 LIMIT 1`,
            [userId],
        );
        const supabaseUserId = ident.rows[0]?.supabase_user_id;
        if (!supabaseUserId) return; // WP-only user — nothing to mirror.

        let slug: string | null = null;
        if (levelId != null) {
            // Tier DEFINITION lookup (slug for the level id) goes through
            // tierLimitsStore — Supabase or legacy mike table per flag.
            slug = (await getTierLimitsRow(levelId))?.tier_slug ?? null;
        }

        const untilIso =
            until == null
                ? null
                : until instanceof Date
                  ? until.toISOString()
                  : new Date(until).toISOString();

        await updateSupabaseUserTier(supabaseUserId, {
            tier_level_id: levelId,
            tier_slug: slug,
            tier_until: untilIso,
        });
    } catch (err) {
        console.warn(
            `[membership] supabase tier mirror failed for user=${userId}:`,
            err instanceof Error ? err.message : err,
        );
    }
}

/**
 * Mark a user as Plus locally. Auth middleware reads
 * `user_tier_state` and prefers it over the JWT, so the
 * next request rate-limits at Plus immediately, even before the JWT
 * (issued by the partner site) refreshes. `until` is hard-bounded by
 * the Stripe period_end so a missed cancellation can't keep someone on
 * Plus forever.
 */
export async function setLocalTierActive(
    userId: string,
    tierLevelId: number,
    until: Date | null,
    correlations: {
        stripeCustomerId?: string | null;
        stripeSubscriptionId?: string | null;
    } = {},
    audit: { source?: TierChangeSource; reason?: string | null } = {},
): Promise<void> {
    const before = await readTierState(userId);
    await query(
        `INSERT INTO public.user_tier_state (
            user_id, active_tier_level_id, active_tier_until,
            stripe_customer_id, active_tier_synced_at
         ) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE SET
            active_tier_level_id = EXCLUDED.active_tier_level_id,
            active_tier_until    = EXCLUDED.active_tier_until,
            stripe_customer_id   = COALESCE(
                EXCLUDED.stripe_customer_id,
                public.user_tier_state.stripe_customer_id
            ),
            active_tier_synced_at = now()`,
        [
            userId,
            tierLevelId,
            until,
            correlations.stripeCustomerId ?? null,
        ],
    );
    await recordTierChange(
        userId,
        before,
        { level: tierLevelId, until },
        audit.source ?? "stripe",
        audit.reason ?? null,
    );
    await mirrorTierToSupabase(userId, tierLevelId, until);
}

/** Clear the tier override — used on cancellation / non-payment. */
export async function clearLocalTierOverride(
    userId: string,
    audit: { source?: TierChangeSource; reason?: string | null } = {},
): Promise<void> {
    const before = await readTierState(userId);
    await query(
        `INSERT INTO public.user_tier_state (user_id, active_tier_synced_at)
         VALUES ($1, now())
         ON CONFLICT (user_id) DO UPDATE SET
            active_tier_level_id  = NULL,
            active_tier_until     = NULL,
            active_tier_synced_at = now()`,
        [userId],
    );
    await query(
        `DELETE FROM public.ump_user_level_assignments WHERE user_id = $1`,
        [userId],
    );
    await recordTierChange(
        userId,
        before,
        { level: null, until: null },
        audit.source ?? "stripe",
        audit.reason ?? null,
    );
    await mirrorTierToSupabase(userId, null, null);
}

/**
 * Lookup helper used by the Stripe webhook: given a Stripe customer
 * id, find the local user. Uses `user_tier_state.stripe_customer_id`.
 */
export async function findUserByStripeCustomer(
    stripeCustomerId: string,
): Promise<{ id: string; wp_user_id: number | null } | null> {
    const result = await query<{
        id: string;
        wp_user_id: number | null;
    }>(
        `SELECT u.id, u.wp_user_id
           FROM public.users u
           JOIN public.user_tier_state s ON s.user_id = u.id
          WHERE s.stripe_customer_id = $1
          LIMIT 1`,
        [stripeCustomerId],
    );
    return result.rows[0] ?? null;
}

/** Persist the Stripe customer linkage on first-seen events. */
export async function rememberStripeCustomer(
    userId: string,
    stripeCustomerId: string,
): Promise<void> {
    await query(
        `INSERT INTO public.user_tier_state (
            user_id, stripe_customer_id, active_tier_synced_at
         ) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            active_tier_synced_at = now()`,
        [userId, stripeCustomerId],
    );
}

// ─── Pull from partner site (UMP → Eulex Desk) ─────────────────────────────────

export type MembershipStatusSnapshot = {
    /** UMP `tier_level_id` currently active for this user. */
    level_id: number;
    /** ISO-8601 expiry of the level (null = no expiry). */
    expires_at: string | null;
    /** UMP-side status string: "active", "expired", "canceled", … */
    status: string | null;
    /**
     * ISO-3166-1 alpha-2 country code stored on the partner side
     * (eulex.ai → WP user meta `billing_country` or UMP profile field).
     * Optional — UMP responses that predate the WP plugin update will
     * omit it and the puller leaves any local value untouched.
     */
    country?: string | null;
    /**
     * EU VAT registration number from the partner side (WP user meta
     * `billing_vat_number`). Used for Stripe customer.tax_id so the
     * invoice can show a valid VAT ID and zero-rate reverse-charge B2B
     * sales. Optional / nullable — only EEA businesses typically have one.
     */
    vat_number?: string | null;
};

/**
 * Pull the live UMP status for a wp_user_id from the partner site.
 *
 * Used by the auth middleware as a fallback when the local override
 * is empty or stale and we suspect the JWT may be lagging behind a
 * change made outside Eulex Desk (e.g. eulex.ai homepage checkout, AdminMax
 * manual UMP edit, refund flow on the WP side).
 *
 * Returns `null` if:
 *   • partner is not configured,
 *   • the request times out / fails,
 *   • the partner returns 404 (unknown user).
 *
 * Caller must treat null as "no info, fall back to JWT" — never
 * downgrade a user just because the pull failed.
 */
export async function pullMembershipStatus(
    wpUserId: number,
): Promise<MembershipStatusSnapshot | null> {
    const base = partnerBaseUrl();
    const secret = partnerSecret();
    if (!base || !secret) return null;

    const url = `${base}/membership-status?wp_user_id=${encodeURIComponent(String(wpUserId))}`;

    // GET request still gets a body-less HMAC — we sign the path+query
    // so the partner can verify both intent and target user without
    // needing per-request body bytes. Header name matches the POST flow.
    const sigBase = `GET ${new URL(url).pathname}${new URL(url).search}`;
    const signature = crypto
        .createHmac("sha256", secret)
        .update(sigBase)
        .digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${secret}`,
                "X-Eulex-Signature": `sha256=${signature}`,
            },
            signal: controller.signal,
        });
        if (res.status === 404) return null;
        if (!res.ok) {
            console.warn(
                `[membership] pull non-2xx: ${res.status} for wp_user=${wpUserId}`,
            );
            return null;
        }
        const data = (await res.json()) as Partial<MembershipStatusSnapshot>;
        if (typeof data.level_id !== "number") return null;
        // Normalise country to upper-case ISO-2; reject anything else
        // so we don't pollute user_profiles.country with garbage from a
        // misconfigured WP plugin response.
        const rawCountry =
            typeof data.country === "string" ? data.country.trim() : "";
        const country = /^[A-Za-z]{2}$/.test(rawCountry)
            ? rawCountry.toUpperCase()
            : null;
        // Normalise VAT number: trim whitespace only, don't uppercase
        // (VAT formats vary by country). Empty string → null.
        const rawVat =
            typeof data.vat_number === "string" ? data.vat_number.trim() : "";
        const vat_number = rawVat.length > 0 ? rawVat : null;

        return {
            level_id: data.level_id,
            expires_at: data.expires_at ?? null,
            status: data.status ?? null,
            country,
            vat_number,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[membership] pull threw for wp_user=${wpUserId}: ${msg}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Update the local override based on a pull result. Any paid level
 * (plus / pro / team) → set the override to that exact level; Free (or
 * any unknown level) → clear; sync timestamp is bumped either way so we
 * don't re-pull for the next 5 minutes.
 */
export async function applyPulledStatus(
    userId: string,
    snapshot: MembershipStatusSnapshot,
): Promise<void> {
    if (isPaidLevel(snapshot.level_id)) {
        const until = snapshot.expires_at ? new Date(snapshot.expires_at) : null;
        await setLocalTierActive(userId, snapshot.level_id, until, {}, {
            source: "ump_sync",
            reason: snapshot.status ? `UMP status=${snapshot.status}` : null,
        });
        await replaceUmpUserLevels(userId, [
            {
                level_id: snapshot.level_id,
                expire_at: until,
                status: snapshot.status,
            },
        ]);
    } else {
        await clearLocalTierOverride(userId, {
            source: "ump_sync",
            reason: snapshot.status ? `UMP status=${snapshot.status}` : null,
        });
    }
    // Backfill the country column from UMP when the user has never
    // touched the field locally. Lives on user_tier_state (not
    // user_profiles) because the IAM DB user can't ALTER user_profiles
    // — see ensureSchema.user_tier_state.country. COALESCE keeps any
    // value the user already typed in /account (their preference
    // always wins over the WP profile, which is often stale). The
    // INSERT path covers users who don't yet have a tier-state row
    // (free users who never bought Plus); the UPDATE path covers the
    // common case where setLocalTierActive / clearLocalTierOverride
    // already created the row above.
    // Backfill country + VAT from UMP. COALESCE-on-update means the
    // user's own value (typed in /account) always wins — we only fill
    // in the blank. A single upsert handles both fields at once so we
    // don't issue a second round-trip when both are present.
    const hasCountry = !!snapshot.country;
    const hasVat = !!snapshot.vat_number;
    if (hasCountry || hasVat) {
        try {
            await query(
                `INSERT INTO public.user_tier_state (
                    user_id, country, vat_number, active_tier_synced_at
                 ) VALUES ($1, $2, $3, now())
                 ON CONFLICT (user_id) DO UPDATE SET
                    country     = COALESCE(public.user_tier_state.country,     EXCLUDED.country),
                    vat_number  = COALESCE(public.user_tier_state.vat_number,  EXCLUDED.vat_number)`,
                [userId, snapshot.country ?? null, snapshot.vat_number ?? null],
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
                `[membership] country/VAT backfill failed for user=${userId}: ${msg}`,
            );
        }
    }
}

export { getPlusTierLevelId, getFreeTierLevelId };
