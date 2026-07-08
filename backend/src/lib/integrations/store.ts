/**
 * Persistence layer for integration_accounts.
 *
 * Tokens stored encrypted via lib/crypto.encryptApiKey(); transparently
 * decrypted on read. Refresh-on-read returns a fresh access_token to
 * the caller without leaking the encryption envelope.
 */

import { getPool } from "../db";
import { encryptApiKey, decryptApiKey } from "../crypto";
import { getAdapter } from "./registry";
import type { OAuthTokenSet, ProviderId } from "./types";

export interface StoredAccount {
    id: string;
    user_id: string;
    provider: ProviderId;
    account_email: string | null;
    account_name: string | null;
    expires_at: Date | null;
    scopes: string[];
}

interface RawAccount {
    id: string;
    user_id: string;
    provider: ProviderId;
    account_email: string | null;
    account_name: string | null;
    access_token: string;
    refresh_token: string | null;
    token_type: string | null;
    expires_at: Date | null;
    scopes: string[] | null;
}

function safeDecrypt(val: string | null): string | null {
    if (!val?.trim()) return null;
    try {
        return decryptApiKey(val);
    } catch {
        return val;
    }
}

function rawToPublic(r: RawAccount): StoredAccount {
    return {
        id: r.id,
        user_id: r.user_id,
        provider: r.provider,
        account_email: r.account_email,
        account_name: r.account_name,
        expires_at: r.expires_at,
        scopes: r.scopes ?? [],
    };
}

export async function listAccountsForUser(
    userId: string,
): Promise<StoredAccount[]> {
    const pool = await getPool();
    const { rows } = await pool.query<RawAccount>(
        `SELECT id, user_id, provider, account_email, account_name,
                access_token, refresh_token, token_type, expires_at, scopes
           FROM integration_accounts
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
    );
    return rows.map(rawToPublic);
}

/**
 * Insert or update (one row per (user, provider)). Caller is the
 * /oauth/callback handler — fresh from token exchange.
 */
export async function upsertAccount(params: {
    user_id: string;
    provider: ProviderId;
    account_email: string | null;
    account_name: string | null;
    tokens: OAuthTokenSet;
}): Promise<StoredAccount> {
    const { user_id, provider, account_email, account_name, tokens } = params;
    const pool = await getPool();
    const { rows } = await pool.query<RawAccount>(
        `INSERT INTO integration_accounts (
             user_id, provider, account_email, account_name,
             access_token, refresh_token, token_type, expires_at, scopes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, provider)
         DO UPDATE SET
             account_email = EXCLUDED.account_email,
             account_name  = EXCLUDED.account_name,
             access_token  = EXCLUDED.access_token,
             refresh_token = COALESCE(EXCLUDED.refresh_token, integration_accounts.refresh_token),
             token_type    = EXCLUDED.token_type,
             expires_at    = EXCLUDED.expires_at,
             scopes        = EXCLUDED.scopes,
             updated_at    = now()
         RETURNING id, user_id, provider, account_email, account_name,
                   access_token, refresh_token, token_type, expires_at, scopes`,
        [
            user_id,
            provider,
            account_email,
            account_name,
            encryptApiKey(tokens.access_token),
            tokens.refresh_token
                ? encryptApiKey(tokens.refresh_token)
                : null,
            tokens.token_type ?? "Bearer",
            tokens.expires_at ?? null,
            tokens.scopes ?? [],
        ],
    );
    if (rows.length === 0) {
        throw new Error("Failed to upsert integration_account");
    }
    return rawToPublic(rows[0]);
}

export async function deleteAccount(
    user_id: string,
    provider: ProviderId,
): Promise<void> {
    const pool = await getPool();
    await pool.query(
        `DELETE FROM integration_accounts
          WHERE user_id = $1 AND provider = $2`,
        [user_id, provider],
    );
}

/**
 * Return a valid (refreshed if needed) access_token for the given user
 * + provider. Refresh tokens are rotated when the provider returns a
 * new value (Microsoft + Box do, Google does not). Throws if no row
 * exists or refresh failed beyond recovery (caller should treat as
 * "user must reconnect").
 */
export async function getValidAccessToken(
    user_id: string,
    provider: ProviderId,
): Promise<string> {
    const pool = await getPool();
    const { rows } = await pool.query<RawAccount>(
        `SELECT id, user_id, provider, account_email, account_name,
                access_token, refresh_token, token_type, expires_at, scopes
           FROM integration_accounts
          WHERE user_id = $1 AND provider = $2`,
        [user_id, provider],
    );
    const row = rows[0];
    if (!row) {
        throw new Error(`No ${provider} account connected`);
    }

    const access = safeDecrypt(row.access_token);
    if (!access) throw new Error(`Stored access_token is empty`);

    // 60s safety margin — refresh just before actual expiry to avoid
    // the access_token expiring mid-request between our check and the
    // provider receiving it.
    const buffer = 60_000;
    const stillValid =
        !row.expires_at ||
        row.expires_at.getTime() - Date.now() > buffer;
    if (stillValid) return access;

    const refresh = safeDecrypt(row.refresh_token);
    if (!refresh) {
        throw new Error(
            `${provider} access_token expired and no refresh_token on file — user must reconnect`,
        );
    }

    const adapter = getAdapter(provider);
    if (!adapter) throw new Error(`Unknown provider: ${provider}`);

    const refreshed = await adapter.refreshTokens(refresh);

    // Box rotates refresh tokens; Microsoft sometimes does; Google
    // never does. COALESCE inside upsert handles the "null = keep
    // existing" semantics, but we explicitly pass the rotated value
    // through here so it actually lands on disk.
    await pool.query(
        `UPDATE integration_accounts
            SET access_token  = $1,
                refresh_token = COALESCE($2, refresh_token),
                expires_at    = $3,
                token_type    = $4,
                scopes        = COALESCE($5, scopes),
                updated_at    = now()
          WHERE id = $6`,
        [
            encryptApiKey(refreshed.access_token),
            refreshed.refresh_token
                ? encryptApiKey(refreshed.refresh_token)
                : null,
            refreshed.expires_at ?? null,
            refreshed.token_type ?? "Bearer",
            refreshed.scopes ?? null,
            row.id,
        ],
    );

    return refreshed.access_token;
}
