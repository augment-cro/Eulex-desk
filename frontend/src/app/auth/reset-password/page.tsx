"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertCircle, ArrowRight } from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { getSupabase, mirrorSupabaseSession } from "@/lib/supabaseClient";
import Link from "next/link";

/**
 * Landing page for the Supabase password-recovery e-mail. The link
 * carries a PKCE ?code= — exchange it for a session, then let the user
 * set a new password (updateUser) and continue into the app signed in.
 *
 * NOTE (PKCE): the recovery link must be opened in the same browser the
 * reset was requested from (the code verifier lives in localStorage).
 * A cross-browser open fails the exchange — we show a friendly error
 * pointing back to /forgot-password.
 */
function ResetPasswordHandler() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const t = useTranslations("login");
    const [phase, setPhase] = useState<"exchanging" | "form" | "done">(
        "exchanging",
    );
    const [error, setError] = useState<string | null>(null);
    const [password, setPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
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

        const code = searchParams.get("code");
        if (!code) {
            setError(t("resetInvalidLink"));
            return;
        }

        getSupabase()
            .auth.exchangeCodeForSession(code)
            .then(({ data, error: sbError }) => {
                if (sbError || !data.session) {
                    setError(t("resetInvalidLink"));
                    return;
                }
                mirrorSupabaseSession(data.session);
                setPhase("form");
            })
            .catch(() => setError(t("resetInvalidLink")));
    }, [searchParams, t]);

    const handleSetPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const { data, error: sbError } = await getSupabase().auth.updateUser({
                password,
            });
            if (sbError) {
                setError(sbError.message);
                setSubmitting(false);
                return;
            }
            // Refresh the mirrored token set, then enter the app.
            const { data: s } = await getSupabase().auth.getSession();
            mirrorSupabaseSession(s.session);
            setPhase("done");
            if (data.user) router.replace("/assistant");
        } catch {
            setError(t("resetInvalidLink"));
            setSubmitting(false);
        }
    };

    const inputClass =
        "w-full rounded-s border border-divider bg-card px-3 py-2.5 text-sm text-ink placeholder:text-ink-40 focus:outline-none focus:border-ink-60";

    return (
        <div className="min-h-dvh bg-paper flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-card border border-divider rounded-m p-8">
                    <h2 className="text-left h-display-l text-ink mb-5">
                        {t("resetTitle")}
                    </h2>

                    {error ? (
                        <div className="text-center py-4">
                            <div className="mx-auto w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mb-4">
                                <AlertCircle
                                    className="h-6 w-6 text-red-600"
                                    aria-hidden="true"
                                />
                            </div>
                            <p className="text-ink-60 text-sm mb-6">{error}</p>
                            <Link
                                href="/forgot-password"
                                className="eu-btn eu-btn-brand w-full"
                            >
                                {t("resetRequestAgain")}
                            </Link>
                        </div>
                    ) : phase === "exchanging" ? (
                        <div className="text-center py-8">
                            <div
                                className="animate-spin rounded-full h-8 w-8 border-2 border-divider border-t-ink mx-auto mb-4"
                                aria-hidden="true"
                            />
                            <p className="text-ink-60 text-sm">
                                {t("callbackCompleting")}
                            </p>
                        </div>
                    ) : (
                        <form onSubmit={handleSetPassword} className="space-y-3">
                            <input
                                type="password"
                                autoComplete="new-password"
                                required
                                minLength={8}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={t("resetNewPassword")}
                                aria-label={t("resetNewPassword")}
                                className={inputClass}
                            />
                            <button
                                type="submit"
                                disabled={submitting}
                                className="eu-btn eu-btn-brand w-full"
                            >
                                {submitting ? (
                                    <span className="flex items-center gap-2">
                                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-ink border-t-transparent" />
                                        {t("resetSaving")}
                                    </span>
                                ) : (
                                    <>
                                        {t("resetSubmit")}
                                        <ArrowRight className="w-4 h-4" />
                                    </>
                                )}
                            </button>
                        </form>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function ResetPasswordPage() {
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
            <ResetPasswordHandler />
        </Suspense>
    );
}
