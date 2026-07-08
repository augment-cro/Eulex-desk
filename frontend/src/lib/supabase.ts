/**
 * @deprecated – This file is a compatibility shim for files that still import
 * from "@/lib/supabase". All authentication is now handled by "@/lib/oauth".
 *
 * It provides a minimal "supabase.auth.getSession()" facade that returns
 * the OAuth access_token so callers work unchanged until fully refactored.
 *
 * TODO: Migrate all remaining `supabase` imports to use `@/lib/oauth` directly.
 */

import { getStoredTokens } from "@/lib/oauth";

const shimAuth = {
    async getSession() {
        const tokens = getStoredTokens();
        if (!tokens?.access_token) {
            return { data: { session: null }, error: null };
        }
        return {
            data: {
                session: {
                    access_token: tokens.access_token,
                    user: null, // Use AuthContext / decodeJwtPayload instead
                },
            },
            error: null,
        };
    },
};

export const supabase = {
    auth: shimAuth,
} as any;
