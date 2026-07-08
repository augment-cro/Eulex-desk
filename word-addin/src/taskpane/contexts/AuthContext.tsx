import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import {
    clearMikeToken,
    getMikeToken,
    isTokenValid,
    redeemPairingCode,
} from "../lib/auth";

interface AuthState {
    isAuthenticated: boolean;
    loading: boolean;
    pairWithCode: (code: string) => Promise<void>;
    logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const token = getMikeToken();
            if (!token) {
                if (!cancelled) {
                    setIsAuthenticated(false);
                    setLoading(false);
                }
                return;
            }
            const ok = await isTokenValid();
            if (!cancelled) {
                if (!ok) clearMikeToken();
                setIsAuthenticated(ok);
                setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Listen for "mike:auth-expired" — fired by apiFetch() whenever the
    // backend returns 401. We can't run OAuth refresh inside Office, so
    // any expired JWT means the user has to re-pair from the Eulex Desk web
    // app. Reset to the Login view immediately so they're not staring
    // at confusing "chat 401" / "projects 401" error rows.
    useEffect(() => {
        const onExpired = (): void => {
            setIsAuthenticated(false);
        };
        window.addEventListener("mike:auth-expired", onExpired);
        return () => window.removeEventListener("mike:auth-expired", onExpired);
    }, []);

    const pairWithCode = useCallback(async (code: string) => {
        await redeemPairingCode(code);
        setIsAuthenticated(true);
    }, []);

    const logout = useCallback(() => {
        clearMikeToken();
        setIsAuthenticated(false);
    }, []);

    const value = useMemo<AuthState>(
        () => ({ isAuthenticated, loading, pairWithCode, logout }),
        [isAuthenticated, loading, pairWithCode, logout],
    );

    return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
    const ctx = useContext(AuthCtx);
    if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
    return ctx;
}
