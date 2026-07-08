/**
 * JWT-based auth middleware for MikeOSS.
 *
 * Validates JWTs issued by eulex.ai WordPress OAuth 2.1 server
 * (eulex-mcp-oauth.php). On first login, auto-creates the user
 * in Cloud SQL using data from the JWT payload.
 *
 * @module auth
 */

import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { getPool } from '../lib/db';
import {
    applyPulledStatus,
    pullMembershipStatus,
} from '../lib/membership';
import { linkInvitesForUser } from '../lib/teams';
import { isSupabaseToken, verifySupabaseToken } from '../lib/supabaseAuth';
import { getFreeTierLevelId } from '../lib/stripe';

/**
 * Stale window before we re-poll the partner UMP. Keeps the partner
 * site from being hammered (at most one pull per user per window)
 * while still picking up out-of-band changes — homepage checkout,
 * UMP admin upgrade/downgrade, refund — within ~1 minute of a fresh
 * JWT-bearing request. We re-poll regardless of the current tier so
 * plan changes in *either* direction (free→paid AND paid→free or
 * paid→other-paid) converge within the window.
 */
const UMP_PULL_STALE_MS = 60_000;

/**
 * Throttled "user was here" tracking → public.user_login_state.
 *
 * requireAuth runs on every API call, so we must not add a write per
 * request. The in-memory map skips the DB round-trip entirely within the
 * throttle window (per Cloud Run instance); the SQL itself only bumps
 * login_count when the previous touch is >1h old, so the count reads as
 * "distinct active hours / sessions", not raw requests. Fire-and-forget:
 * tracking must never block or fail auth.
 */
const LOGIN_TOUCH_THROTTLE_MS = 15 * 60_000;
const lastLoginTouch = new Map<string, number>();

function touchUserLogin(userId: string): void {
  const now = Date.now();
  const last = lastLoginTouch.get(userId) ?? 0;
  if (now - last < LOGIN_TOUCH_THROTTLE_MS) return;
  lastLoginTouch.set(userId, now);
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `INSERT INTO public.user_login_state (user_id, last_login_at, login_count)
         VALUES ($1, now(), 1)
         ON CONFLICT (user_id) DO UPDATE SET
            login_count = public.user_login_state.login_count
                + CASE WHEN public.user_login_state.last_login_at < now() - interval '1 hour'
                       THEN 1 ELSE 0 END,
            last_login_at = now()`,
        [userId],
      );
    } catch (err) {
      console.warn(
        '[auth] user_login_state touch failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/**
 * JWT payload structure from eulex-mcp-oauth.php L553-564.
 * The `sub` field contains the WordPress user_id (not UUID).
 */
interface EulexJwtPayload {
  iss: string;          // "https://eulex.ai/"
  sub: string;          // WP user_id as string
  email: string;
  name: string;
  tier: 'free' | 'plus';
  tier_level_id: number;
  tier_expires: string | null;
  scope: string;        // "mike:projects mike:documents mike:chat"
  aud: string;          // "mike" (audience-separated from eulex-mcp)
  iat: number;
  exp: number;
}

/**
 * Express middleware: validates Bearer JWT and populates res.locals.
 *
 * Sets:
 *   - res.locals.userId       (uuid — Cloud SQL users.id)
 *   - res.locals.userEmail    (string)
 *   - res.locals.wpUserId     (number — WordPress user_id)
 *   - res.locals.tier         ('free' | 'plus')
 *   - res.locals.tierLevelId  (number — UMP tier_level_id, e.g. 2=plus, 3=free
 *                              — DB override wins over JWT for fresh upgrades)
 *   - res.locals.scope        (string — space-separated scopes)
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Missing or invalid Authorization header' });
    return;
  }

  const token = auth.slice(7).trim();

  // ── Dual-token auth ──────────────────────────────────────────────────
  // When Supabase is configured AND the bearer was issued by our Supabase
  // project, verify it via JWKS and resolve the user by Supabase identity.
  // Otherwise fall through to the legacy WordPress-OAuth path below. When
  // SUPABASE_URL is unset isSupabaseToken() is always false, so behaviour
  // is byte-identical to the pre-Supabase middleware.
  if (isSupabaseToken(token)) {
    await handleSupabaseAuth(token, res, next);
    return;
  }

  const secret = process.env.EULEX_MCP_JWT_SECRET;
  if (!secret) {
    console.error('[auth] EULEX_MCP_JWT_SECRET not configured');
    res.status(500).json({ detail: 'Server auth is not configured' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'https://eulex.ai/',
      audience: ['mike', 'eulex-mcp'],
    }) as EulexJwtPayload;

    const wpUserId = parseInt(decoded.sub, 10);
    if (isNaN(wpUserId)) {
      res.status(401).json({ detail: 'Invalid token subject' });
      return;
    }

    // Lookup or auto-create user in Cloud SQL
    const pool = await getPool();
    let { rows } = await pool.query(
      'SELECT id, email FROM users WHERE wp_user_id = $1',
      [wpUserId],
    );
    const wasNewUser = rows.length === 0;

    if (rows.length === 0) {
      // First login: try email match (migration from Supabase)
      const emailMatch = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND wp_user_id IS NULL',
        [decoded.email],
      );

      if (emailMatch.rows.length > 0) {
        // Link existing Supabase-migrated user to WP ID
        const updateResult = await pool.query(
          'UPDATE users SET wp_user_id = $1, display_name = COALESCE(display_name, $2) WHERE id = $3 RETURNING id, email',
          [wpUserId, decoded.name, emailMatch.rows[0].id],
        );
        rows = updateResult.rows;
      } else {
        // Brand new user — create from JWT data
        const insertResult = await pool.query(
          `INSERT INTO users (wp_user_id, email, display_name)
           VALUES ($1, $2, $3) RETURNING id, email`,
          [wpUserId, decoded.email, decoded.name],
        );
        rows = insertResult.rows;
      }
    }

    // First login → link any pending team invites for this email so the
    // invitee becomes an active team member automatically.
    if (wasNewUser) {
      await linkInvitesForUser(rows[0].id, rows[0].email ?? decoded.email);
    }

    res.locals.userId = rows[0].id;
    res.locals.userEmail = rows[0].email;
    res.locals.wpUserId = wpUserId;
    res.locals.tier = decoded.tier;
    // UMP tier_level_id resolution — DB override (set by the Stripe
    // webhook on a fresh Plus checkout) wins over the JWT, which can
    // be up to ~24h stale. The override is cleared on subscription
    // cancellation by the same webhook, so a downgrade is also
    // reflected immediately.
    const jwtTierLevelId =
        typeof decoded.tier_level_id === "number" ? decoded.tier_level_id : 3;
    let effectiveTier = jwtTierLevelId;

    // ── Tier resolution order ──────────────────────────────────────────
    //   1. Local DB override (set by Stripe webhook for Eulex Desk-originated
    //      Plus checkouts, OR by the UMP pull below for changes made
    //      outside Eulex Desk).
    //   2. UMP pull from the partner site, when the local override is
    //      missing AND the JWT still says "free" AND the last sync
    //      is older than UMP_PULL_STALE_MS. Catches eulex.ai homepage
    //      checkouts and AdminMax manual UMP edits without forcing
    //      the user to re-login.
    //   3. JWT tier_level_id, as a final fallback.
    let overrideSyncedAt: Date | null = null;
    try {
        const ovr = await pool.query<{
            active_tier_level_id: number | null;
            active_tier_until: string | null;
            active_tier_synced_at: string | null;
        }>(
            `SELECT s.active_tier_level_id, s.active_tier_until, s.active_tier_synced_at
               FROM public.user_tier_state s
              WHERE s.user_id = $1`,
            [rows[0].id],
        );
        const o = ovr.rows[0];
        if (o && o.active_tier_level_id != null) {
            const expired =
                o.active_tier_until && new Date(o.active_tier_until) < new Date();
            if (!expired) {
                effectiveTier = o.active_tier_level_id;
            }
        }
        overrideSyncedAt = o?.active_tier_synced_at
            ? new Date(o.active_tier_synced_at)
            : null;
    } catch (err) {
        // Override is opportunistic — never block auth on its lookup.
        console.error(
            "[auth] tier override lookup failed (using JWT tier):",
            err instanceof Error ? err.message : err,
        );
    }

    // Pull from UMP whenever the local sync is stale — regardless of
    // whether a paid override is currently active. This is the single
    // convergence path for every out-of-band change made outside Eulex Desk:
    //   • free → paid      (homepage checkout, UMP admin upgrade)
    //   • paid → free       (cancellation, refund, UMP admin downgrade)
    //   • paid → other paid (plan change in UMP)
    // applyPulledStatus is the authority: a paid snapshot refreshes the
    // override to that exact level; a free/unknown snapshot CLEARS it.
    // It also COALESCE-backfills country/VAT, so the previous
    // "country-only" pull for already-paid users is now redundant.
    //
    // On pull failure / null (timeout, 404, partner down) we deliberately
    // do NOT touch effectiveTier — never downgrade a user just because
    // the partner was briefly unreachable; the local override stands.
    const stale =
        !overrideSyncedAt ||
        Date.now() - overrideSyncedAt.getTime() > UMP_PULL_STALE_MS;

    if (stale) {
        try {
            const snapshot = await pullMembershipStatus(wpUserId);
            if (snapshot) {
                await applyPulledStatus(rows[0].id, snapshot);
                effectiveTier = snapshot.level_id;
            }
        } catch (err) {
            console.warn(
                "[auth] UMP pull failed (keeping current tier):",
                err instanceof Error ? err.message : err,
            );
        }
    }

    res.locals.tierLevelId = effectiveTier;
    res.locals.scope = decoded.scope;
    touchUserLogin(rows[0].id);
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ detail: 'Token expired', code: 'TOKEN_EXPIRED' });
    } else if (err instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ detail: 'Invalid token', code: 'TOKEN_INVALID' });
    } else {
      console.error('[auth] Authentication error:', err);
      res.status(401).json({ detail: 'Authentication failed' });
    }
  }
}

/**
 * Supabase access-token auth path (dual-token — see requireAuth).
 *
 * Verifies the token via JWKS, resolves the caller to a public.users row
 * (Supabase identity → email link → create), and populates res.locals with
 * the SAME shape the WordPress path sets, so all downstream routes are
 * unaffected.
 *
 * Tier: Supabase tokens carry no tier claim. The authoritative source is
 * the local user_tier_state override (fed by the Stripe webhook); absent an
 * active override the user is free. There is deliberately NO UMP pull here
 * — that is a WordPress-only concern.
 */
async function handleSupabaseAuth(
  token: string,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let claims: Awaited<ReturnType<typeof verifySupabaseToken>>;
  try {
    claims = await verifySupabaseToken(token);
  } catch (err) {
    const expired = err instanceof Error && /"exp"|expired/i.test(err.message);
    res.status(401).json(
      expired
        ? { detail: 'Token expired', code: 'TOKEN_EXPIRED' }
        : { detail: 'Invalid token', code: 'TOKEN_INVALID' },
    );
    return;
  }

  const email = claims.email;
  if (!email) {
    res.status(401).json({ detail: 'Supabase token has no email' });
    return;
  }

  try {
    const pool = await getPool();

    let userId: string | null = null;
    let userEmail = email;
    let wasNewUser = false;

    // 1. Returning user — resolve via the identity mapping.
    const ident = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM public.user_supabase_identity WHERE supabase_user_id = $1',
      [claims.sub],
    );

    if (ident.rows.length > 0) {
      userId = ident.rows[0].user_id;
      const u = await pool.query<{ email: string }>(
        'SELECT email FROM public.users WHERE id = $1',
        [userId],
      );
      if (u.rows.length > 0) userEmail = u.rows[0].email ?? email;
    } else {
      // 2+3. Resolve-or-create the user row atomically.
      //
      // This used to be a check-then-INSERT (SELECT by email, INSERT on
      // miss), which raced: on first login the SPA fires several
      // authenticated bootstrap requests at once (profile, chats, MCP
      // lists…). Each missed both the identity lookup above and the email
      // SELECT, then ran a bare INSERT — leaving 2–3 duplicate rows per new
      // user (same email, distinct UUIDs), which surfaced as triplicated
      // emails in AdminMax. A single upsert against the unique lower(email)
      // index (migration 129) collapses all concurrent first-logins onto one
      // row: the loser's INSERT degrades to an UPDATE returning the winner's
      // id. `xmax = 0` distinguishes a fresh insert from that update so we
      // only link invites for genuinely new users.
      const meta = claims.raw.user_metadata as Record<string, unknown> | undefined;
      const display =
        meta && typeof meta.display_name === 'string'
          ? meta.display_name
          : email.split('@')[0];
      const upsert = await pool.query<{
        id: string;
        email: string;
        inserted: boolean;
      }>(
        `INSERT INTO public.users (email, display_name)
         VALUES ($1, $2)
         ON CONFLICT (lower(email)) DO UPDATE
           SET display_name = COALESCE(public.users.display_name, EXCLUDED.display_name)
         RETURNING id, email, (xmax = 0) AS inserted`,
        [email, display],
      );
      userId = upsert.rows[0].id;
      userEmail = upsert.rows[0].email ?? email;
      wasNewUser = upsert.rows[0].inserted;

      // Backfill the identity mapping for next time.
      await pool.query(
        `INSERT INTO public.user_supabase_identity (supabase_user_id, user_id, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (supabase_user_id) DO NOTHING`,
        [claims.sub, userId, email],
      );
    }

    if (wasNewUser && userId) {
      await linkInvitesForUser(userId, userEmail);
    }

    // Proactively ensure a settings profile exists. Provisioning above
    // creates public.users + the identity mapping but historically never
    // a user_profiles row — that was created lazily only when the user
    // touched settings (routes/user.ts). Most users never did, so ~92%
    // had no row, and getUserModelSettings fell back to a model that
    // can't run in prod (tabular review failed for them). Idempotent on
    // every auth so existing profile-less users self-heal on next request
    // and new users get the row (and its claude-sonnet-5 default, see
    // migration 131) immediately. ON CONFLICT keeps it a cheap no-op once
    // the row exists.
    if (userId) {
      await pool.query(
        `INSERT INTO public.user_profiles (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
    }

    // Tier — local override only; default free. No UMP pull.
    const freeLevel = getFreeTierLevelId();
    let effectiveTier = freeLevel;
    try {
      const ovr = await pool.query<{
        active_tier_level_id: number | null;
        active_tier_until: string | null;
      }>(
        `SELECT active_tier_level_id, active_tier_until
           FROM public.user_tier_state WHERE user_id = $1`,
        [userId],
      );
      const o = ovr.rows[0];
      if (o && o.active_tier_level_id != null) {
        const expired =
          o.active_tier_until && new Date(o.active_tier_until) < new Date();
        if (!expired) effectiveTier = o.active_tier_level_id;
      }
    } catch (err) {
      console.error(
        '[auth] supabase tier override lookup failed (defaulting free):',
        err instanceof Error ? err.message : err,
      );
    }

    res.locals.userId = userId;
    res.locals.userEmail = userEmail;
    res.locals.wpUserId = null;
    res.locals.tier = effectiveTier === freeLevel ? 'free' : 'plus';
    res.locals.tierLevelId = effectiveTier;
    res.locals.scope = 'mike:projects mike:documents mike:chat';
    if (userId) touchUserLogin(userId);
    next();
  } catch (err) {
    console.error('[auth] Supabase auth error:', err);
    res.status(401).json({ detail: 'Authentication failed' });
  }
}
