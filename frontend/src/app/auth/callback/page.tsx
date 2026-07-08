"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    exchangeCodeForTokens,
    consumePostLoginRedirect,
} from "@/lib/oauth";
import { useAuth } from "@/contexts/AuthContext";
import { track } from "@/app/lib/analytics";
import { SiteLogo } from "@/components/site-logo";
import { Suspense } from "react";

function CallbackHandler() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated } = useAuth();
    const [error, setError] = useState<string | null>(null);
    const [tokensReady, setTokensReady] = useState(false);
    const [pendingNext, setPendingNext] = useState<string | null>(null);

    useEffect(() => {
        const code = searchParams.get("code");
        const state = searchParams.get("state");
        const oauthError = searchParams.get("error");
        const errorDesc = searchParams.get("error_description");

        if (oauthError) {
            setError(errorDesc || oauthError);
            return;
        }

        if (!code || !state) {
            setError("Missing authorization code or state parameter.");
            return;
        }

        exchangeCodeForTokens(code, state)
            .then(() => {
                // storeTokens() inside exchangeCodeForTokens dispatches
                // AUTH_TOKEN_EVENT which kicks AuthContext.loadUser().
                // We defer the actual route replace until isAuthenticated
                // flips to true, so the destination layout never sees a
                // stale unauthenticated state (which would bounce us
                // back to /login and force a second click).
                //
                // New-vs-returning signal: no reliable client-side indicator
                // is available (no `is_new`, `created_at`, or first-login
                // flag returned by the OAuth token endpoint or profile API).
                // CONCERN: `signup_completed` cannot be distinguished from
                // `login_completed` here. Firing `login_completed` for all
                // successful auth as a safe fallback. To properly split
                // new vs returning, the token endpoint or /user/profile
                // would need to return an `is_new_account` boolean.
                track("login_completed");
                setPendingNext(consumePostLoginRedirect() ?? "/assistant");
                setTokensReady(true);
            })
            .catch((err: Error) => {
                console.error("[auth/callback] Token exchange failed:", err);
                setError(err.message || "Authentication failed. Please try again.");
            });
    }, [searchParams]);

    useEffect(() => {
        if (tokensReady && isAuthenticated && pendingNext) {
            router.replace(pendingNext);
        }
    }, [tokensReady, isAuthenticated, pendingNext, router]);

    if (error) {
        return (
            <div className="min-h-dvh bg-background flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-card border border-border rounded-2xl p-8 text-center">
                        <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-6">
                            <svg
                                className="h-6 w-6 text-destructive"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={1.5}
                                stroke="currentColor"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                                />
                            </svg>
                        </div>
                        <h2 className="text-xl font-semibold text-foreground mb-3">
                            Authentication Failed
                        </h2>
                        <p className="text-muted-foreground text-sm mb-6">{error}</p>
                        <button
                            onClick={() => router.push("/login")}
                            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
                        >
                            Try Again
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-background flex items-center justify-center">
            <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-border border-t-foreground mx-auto mb-4" />
                <p className="text-muted-foreground text-sm">Completing sign-in...</p>
            </div>
        </div>
    );
}

export default function AuthCallbackPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-dvh bg-background flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-2 border-border border-t-foreground" />
                </div>
            }
        >
            <CallbackHandler />
        </Suspense>
    );
}
