/**
 * AdminMax operator state — a tiny KV store over public.admin_state.
 *
 * AdminMax auth is a single shared password (no per-admin identity), so
 * the state here is global across all operators. First consumer is the
 * "new users since last look" corner badge:
 *
 *   key `new_users_seen` → { last_checked_at: ISO-8601 }
 *
 * Keep values small (jsonb) — this is operator UI state, not app data.
 *
 * @module adminState
 */
import { query } from "./db";

export async function getAdminState<T extends Record<string, unknown>>(
    key: string,
): Promise<T | null> {
    const r = await query<{ value: T }>(
        `SELECT value FROM public.admin_state WHERE key = $1`,
        [key],
    );
    return r.rows[0]?.value ?? null;
}

export async function setAdminState(
    key: string,
    value: Record<string, unknown>,
): Promise<void> {
    await query(
        `INSERT INTO public.admin_state (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = now()`,
        [key, JSON.stringify(value)],
    );
}

/** admin_state key for the new-users badge. */
export const NEW_USERS_SEEN_KEY = "new_users_seen";

/**
 * When the operator last reset the new-users badge. Falls back to
 * 7 days ago for a fresh install so the first render shows recent
 * signups instead of every user ever.
 */
export async function getNewUsersLastCheckedAt(): Promise<Date> {
    const state = await getAdminState<{ last_checked_at?: string }>(
        NEW_USERS_SEEN_KEY,
    );
    const raw = state?.last_checked_at;
    if (raw) {
        const d = new Date(raw);
        if (!isNaN(d.getTime())) return d;
    }
    return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

export async function markNewUsersSeen(at: Date = new Date()): Promise<void> {
    await setAdminState(NEW_USERS_SEEN_KEY, {
        last_checked_at: at.toISOString(),
    });
}

// ── admin login bookkeeping ────────────────────────────────────────────────
//
// AdminMax has no per-admin identity (one shared password), so we track a
// single global pair: the current login and the one before it. The
// "new users since last login" surfaces count against `previous` — i.e.
// what registered between the operator's prior and current sign-in.

/** admin_state key for the operator login pair. */
export const ADMIN_LOGIN_KEY = "admin_login";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Record a successful AdminMax login: shift the stored `current` timestamp
 * into `previous` and stamp `current = now`. Returns the new `previous`
 * (the reference point for "new users since last login").
 */
export async function recordAdminLogin(at: Date = new Date()): Promise<Date | null> {
    const prev = await getAdminState<{ current?: string }>(ADMIN_LOGIN_KEY);
    const previousIso = prev?.current ?? null;
    await setAdminState(ADMIN_LOGIN_KEY, {
        current: at.toISOString(),
        previous: previousIso,
    });
    if (previousIso) {
        const d = new Date(previousIso);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
}

/**
 * Reference timestamp for the new-users surfaces: "since the operator's
 * previous login". Falls back to 7 days ago on a fresh install (no prior
 * login). The operator's mid-session "mark seen" dismissal still wins when
 * it is more recent, so the badge can be cleared without a re-login.
 */
export async function getNewUsersSince(): Promise<Date> {
    const login = await getAdminState<{ previous?: string }>(ADMIN_LOGIN_KEY);
    const seenAt = await getNewUsersLastCheckedAt();

    let since = new Date(Date.now() - SEVEN_DAYS_MS);
    const prevRaw = login?.previous;
    if (prevRaw) {
        const d = new Date(prevRaw);
        if (!isNaN(d.getTime())) since = d;
    }
    // A more recent "mark seen" dismissal takes precedence.
    return seenAt > since ? seenAt : since;
}
