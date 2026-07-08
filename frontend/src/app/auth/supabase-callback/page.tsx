"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import type { EmailOtpType, Session } from "@supabase/supabase-js";
import { consumePostLoginRedirect } from "@/lib/oauth";
import { getSupabase, mirrorSupabaseSession } from "@/lib/supabaseClient";
import { useAuth } from "@/contexts/AuthContext";
import { SiteLogo } from "@/components/site-logo";

/**
 * Callback for Supabase auth flows (social OAuth PKCE + signup e-mail
 * confirmation links). Deliberately separate from /auth/callback, which
 * belongs to the legacy WordPress OAuth flow — both use ?code=, so sharing
 * a route would make the two flows ambiguous.
 */
function SupabaseCallbackHandler() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated } = useAuth();
    const t = useTranslations("login");
    const [error, setError] = useState<string | null>(null);
    const [tokensReady, setTokensReady] = useState(false);
    const [pendingNext, setPendingNext] = useState<string | null>(null);
    const exchanged = useRef(false);

    useEffect(() => {
        if (exchanged.current) return;
        exchanged.current = true;

        const oauthError = searchParams.get("error");
        const errorDesc = searchParams.get("error_description");
        if (oauthError) {
            setError(errorDesc || oauthError);
            return;
        }

        const onSession = (session: Session) => {
            mirrorSupabaseSession(session);
            // Same two-stage redirect as the WP callback: wait for AuthContext
            // to flip isAuthenticated so the destination layout never sees a
            // stale unauthenticated state.
            setPendingNext(consumePostLoginRedirect() ?? "/assistant");
            setTokensReady(true);
        };
        const fail = (msg?: string, err?: unknown) => {
            if (err) console.error("[auth/supabase-callback]", err);
            setError(msg || "Authentication failed.");
        };

        // Passwordless magic link / e-mail confirmation arrive as a stateless
        // ?token_hash=…&type=… — verifiable on any origin (including links
        // requested on the eulex.ai hero), no PKCE code-verifier needed. Social
        // OAuth still arrives as ?code= and needs the PKCE code exchange.
        const tokenHash = searchParams.get("token_hash");
        const type = searchParams.get("type") as EmailOtpType | null;
        const code = searchParams.get("code");

        if (tokenHash) {
            getSupabase()
                .auth.verifyOtp({ token_hash: tokenHash, type: type ?? "email" })
                .then(({ data, error: sbError }) => {
                    if (sbError || !data.session) {
                        fail(sbError?.message);
                        return;
                    }
                    onSession(data.session);
                })
                .catch((err: Error) => fail(err.message, err));
        } else if (code) {
            getSupabase()
                .auth.exchangeCodeForSession(code)
                .then(({ data, error: sbError }) => {
                    if (sbError || !data.session) {
                        fail(sbError?.message);
                        return;
                    }
                    onSession(data.session);
                })
                .catch((err: Error) => fail(err.message, err));
        } else {
            setError("Missing authorization code.");
        }
    }, [searchParams]);

    useEffect(() => {
        if (tokensReady && isAuthenticated && pendingNext) {
            router.replace(pendingNext);
        }
    }, [tokensReady, isAuthenticated, pendingNext, router]);

    if (error) {
        return (
            <div className="min-h-dvh bg-paper flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="md" className="md:text-4xl" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className="bg-card border border-divider rounded-m p-8 text-center">
                        <div className="mx-auto w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mb-6">
                            <AlertCircle
                                className="h-6 w-6 text-red-600"
                                aria-hidden="true"
                            />
                        </div>
                        <h2 className="text-xl font-semibold text-ink mb-3">
                            {t("callbackFailedTitle")}
                        </h2>
                        <p className="text-ink-60 text-sm mb-6">{error}</p>
                        <button
                            onClick={() => router.push("/login")}
                            className="eu-btn eu-btn-brand w-full"
                        >
                            {t("callbackTryAgain")}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-paper flex items-center justify-center">
            <div className="text-center">
                <div
                    className="animate-spin rounded-full h-8 w-8 border-2 border-divider border-t-ink mx-auto mb-4"
                    aria-hidden="true"
                />
                <p className="text-ink-60 text-sm">{t("callbackCompleting")}</p>
            </div>
        </div>
    );
}

export default function SupabaseCallbackPage() {
    return (
        <Suspense
            fallback={
                <div className="min-h-dvh bg-paper flex items-center justify-center">
                    <div
                        className="animate-spin rounded-full h-8 w-8 border-2 border-divider border-t-ink"
                        aria-hidden="true"
                    />
                </div>
            }
        >
            <SupabaseCallbackHandler />
        </Suspense>
    );
}
