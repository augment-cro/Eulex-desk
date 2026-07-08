"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
    ReactNode,
} from "react";
import {
    getStoredTokens,
    isAccessTokenExpired,
    refreshAccessToken,
    decodeJwtPayload,
    signOut as oauthSignOut,
    AUTH_TOKEN_EVENT,
    type OAuthUser,
} from "@/lib/oauth";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

// JWT `sub` is the WordPress user_id (numeric string). All app tables
// (chats.user_id, documents.user_id, tabular_reviews.user_id, …) store
// the *internal* users.id UUID instead. Owner-check UI compares
// entity.user_id with user.id, so we must replace the WP id with the
// internal UUID here. /user/profile returns it as `id`.
async function fetchInternalUserId(accessToken: string): Promise<string | null> {
    try {
        const res = await fetch(`${API_BASE}/user/profile`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store",
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { id?: string };
        return typeof json.id === "string" && json.id.length > 0
            ? json.id
            : null;
    } catch {
        return null;
    }
}

interface AuthContextType {
    user: OAuthUser | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    tier: "free" | "plus";
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<OAuthUser | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    const applyDecoded = useCallback(
        async (decoded: OAuthUser | null, accessToken: string | null) => {
            if (!decoded) {
                setUser(null);
                setAuthLoading(false);
                return;
            }
            // Show the UI as soon as possible with the JWT-derived user.
            setUser(decoded);
            setAuthLoading(false);
            if (!accessToken) return;
            // Then upgrade `id` to the internal UUID in the background so
            // owner-check comparisons (chat/doc/review delete + rename)
            // start matching. Without this every owned-resource action
            // hits the "owner-only action" modal because the JWT sub is
            // a WordPress integer, not the UUID stored in DB.
            const internalId = await fetchInternalUserId(accessToken);
            if (internalId) {
                setUser((prev) =>
                    prev ? { ...prev, id: internalId } : prev,
                );
            }
        },
        [],
    );

    const loadUser = useCallback(async () => {
        const tokens = getStoredTokens();
        if (!tokens) {
            setUser(null);
            setAuthLoading(false);
            return;
        }

        // If access token expired, try refresh
        if (isAccessTokenExpired()) {
            const refreshed = await refreshAccessToken();
            if (!refreshed) {
                setUser(null);
                setAuthLoading(false);
                return;
            }

            const decoded = decodeJwtPayload(refreshed.access_token);
            await applyDecoded(decoded, refreshed.access_token);
            return;
        }

        // Token is still valid — decode for user info
        const decoded = decodeJwtPayload(tokens.access_token);
        await applyDecoded(decoded, tokens.access_token);
    }, [applyDecoded]);

    // Keep the Supabase session mirrored into the legacy token store for
    // the whole app lifetime (auto-refresh fires TOKEN_REFRESHED events
    // that must land in mike_oauth_tokens). No-op when Supabase auth is
    // not configured.
    useEffect(() => {
        import("@/lib/supabaseClient")
            .then((m) => {
                if (m.supabaseAuthEnabled) m.initSupabaseAuthMirror();
            })
            .catch(() => {
                // Module load failure must never break legacy auth.
            });
    }, []);

    useEffect(() => {
        loadUser();

        // Cross-tab: browser `storage` event fires only in OTHER tabs.
        const onStorage = (e: StorageEvent) => {
            if (e.key === "mike_oauth_tokens") {
                loadUser();
            }
        };
        // Same-tab: storeTokens()/clearTokens() dispatch this so the
        // post-/auth/callback `router.replace("/assistant")` doesn't
        // land in a layout that still thinks we're logged out.
        const onTokenEvent = () => {
            loadUser();
        };
        window.addEventListener("storage", onStorage);
        window.addEventListener(AUTH_TOKEN_EVENT, onTokenEvent);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(AUTH_TOKEN_EVENT, onTokenEvent);
        };
    }, [loadUser]);

    const handleSignOut = async () => {
        await oauthSignOut();
        setUser(null);
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading,
                tier: user?.tier ?? "free",
                signOut: handleSignOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
