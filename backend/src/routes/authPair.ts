/**
 * Pairing-code endpoints for the Word add-in.
 *
 *   POST /auth/pair/start   (auth required)
 *     Generates a 6-digit code bound to the caller's JWT. Returns the code
 *     and its expiry timestamp. Any prior unredeemed code for the same user
 *     is invalidated so re-clicking "Generate code" doesn't leave dangling
 *     codes lying around in the table.
 *
 *   POST /auth/pair/redeem  (NO auth)
 *     Body: { code }. If a non-expired row exists, returns the bound JWT
 *     and deletes the row. Wrong attempts increment the row's `attempts`
 *     counter; after 5 wrong tries the code is invalidated.
 *
 * The `token` stored alongside each code is the eulex.ai-issued JWT
 * verbatim — no re-signing, no separate audience. The add-in stores it
 * in localStorage and uses it as a Bearer for every subsequent call,
 * exactly like the web frontend does.
 */

import { Router } from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { requireEntitlement } from "../lib/entitlements";
import { getPool } from "../lib/db";

export const authPairRouter = Router();

const CODE_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;

/**
 * Cryptographically random 6-digit code, zero-padded. Uses
 * `crypto.randomInt` (rejection-sampled) so the distribution is uniform
 * across [0, 999999] — `Math.random()` is biased and predictable.
 */
function generateCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}

// POST /auth/pair/start
// Gated on the `wordPlugin` entitlement (Pro+): pairing is the only way
// the Word add-in obtains a token, so blocking it here keeps the entire
// add-in surface Pro-only without gating each downstream endpoint.
authPairRouter.post("/start", requireAuth, requireEntitlement("wordPlugin"), async (req, res) => {
  const userId = res.locals.userId as string;
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const pool = await getPool();

  try {
    // Drop any prior codes for this user; a new one supersedes the old.
    await pool.query("DELETE FROM auth_pair_codes WHERE user_id = $1", [
      userId,
    ]);

    // Try a few times in case of rare collision on the 6-digit space.
    let code: string | null = null;
    let expiresAt: Date | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode();
      try {
        const { rows } = await pool.query<{ expires_at: Date }>(
          `INSERT INTO auth_pair_codes (code, user_id, token, expires_at)
             VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)
             RETURNING expires_at`,
          [candidate, userId, token, CODE_TTL_MINUTES.toString()],
        );
        code = candidate;
        expiresAt = rows[0].expires_at;
        break;
      } catch (err: unknown) {
        // 23505 = unique_violation — try a new code.
        const pgErr = err as { code?: string };
        if (pgErr?.code !== "23505") throw err;
      }
    }

    if (!code || !expiresAt) {
      res.status(500).json({
        detail: "Could not generate a unique pairing code, try again",
      });
      return;
    }

    res.json({
      code,
      expires_at: expiresAt.toISOString(),
      ttl_seconds: CODE_TTL_MINUTES * 60,
    });
  } catch (err) {
    console.error("[auth/pair/start]", err);
    res.status(500).json({ detail: "Failed to create pairing code" });
  }
});

// POST /auth/pair/redeem
authPairRouter.post("/redeem", async (req, res) => {
  const code = (req.body?.code ?? "").toString().trim();
  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ detail: "Code must be 6 digits" });
    return;
  }

  const pool = await getPool();
  try {
    const { rows } = await pool.query<{
      token: string;
      attempts: number;
      expired: boolean;
    }>(
      `SELECT token, attempts, expires_at < now() AS expired
         FROM auth_pair_codes
        WHERE code = $1`,
      [code],
    );

    if (rows.length === 0) {
      res.status(404).json({ detail: "Invalid or expired code" });
      return;
    }

    const row = rows[0];
    if (row.expired) {
      await pool.query("DELETE FROM auth_pair_codes WHERE code = $1", [code]);
      res.status(410).json({ detail: "Code expired" });
      return;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await pool.query("DELETE FROM auth_pair_codes WHERE code = $1", [code]);
      res.status(429).json({ detail: "Too many attempts" });
      return;
    }

    // Success: hand over the JWT and burn the code.
    await pool.query("DELETE FROM auth_pair_codes WHERE code = $1", [code]);
    res.json({ token: row.token });
  } catch (err) {
    console.error("[auth/pair/redeem]", err);
    res.status(500).json({ detail: "Failed to redeem code" });
  }
});
