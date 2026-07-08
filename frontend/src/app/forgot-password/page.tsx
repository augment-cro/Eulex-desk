"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, MailCheck } from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { getSupabase, supabaseAuthEnabled } from "@/lib/supabaseClient";
import Link from "next/link";

/**
 * Request a Supabase password-reset e-mail. The link in the e-mail lands
 * on /auth/reset-password (PKCE recovery code), where the user sets the
 * new password. Existing WP-migrated users use this exact flow to get
 * their first Supabase password.
 */
export default function ForgotPasswordPage() {
    const t = useTranslations("login");
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabaseAuthEnabled || submitting) return;
        setSubmitting(true);
        setError(null);
        try {
            const { error: sbError } =
                await getSupabase().auth.resetPasswordForEmail(email.trim(), {
                    redirectTo: `${window.location.origin}/auth/reset-password`,
                });
            if (sbError) {
                setError(sbError.message);
                setSubmitting(false);
                return;
            }
            setSent(true);
        } catch {
            setError(t("invalidCredentials"));
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
                    <h2 className="text-left h-display-l text-ink mb-2">
                        {t("forgotTitle")}
                    </h2>

                    {sent ? (
                        <div className="text-center py-6">
                            <div className="mx-auto w-16 h-16 bg-surface rounded-full flex items-center justify-center mb-4">
                                <MailCheck
                                    className="h-8 w-8 text-ink-60"
                                    aria-hidden="true"
                                />
                            </div>
                            <p className="text-ink mb-2 font-medium">
                                {t("forgotSentTitle")}
                            </p>
                            <p className="text-ink-60 text-sm">
                                {t("forgotSentBody", { email: email.trim() })}
                            </p>
                        </div>
                    ) : (
                        <>
                            <p className="text-ink-60 text-sm mb-5">
                                {t("forgotInstructions")}
                            </p>
                            <form onSubmit={handleSubmit} className="space-y-3">
                                <input
                                    type="email"
                                    autoComplete="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder={t("emailLabel")}
                                    aria-label={t("emailLabel")}
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
                                            {t("forgotSending")}
                                        </span>
                                    ) : (
                                        <>
                                            {t("forgotSubmit")}
                                            <ArrowRight className="w-4 h-4" />
                                        </>
                                    )}
                                </button>
                            </form>
                        </>
                    )}

                    {error && (
                        <div className="mt-4 text-red-700 text-sm bg-red-50 p-3 rounded-s border border-red-100">
                            {error}
                        </div>
                    )}

                    <p className="mt-5 text-center text-xs text-ink-40">
                        <Link
                            href="/login"
                            className="text-ink underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                        >
                            {t("backToLogin")}
                        </Link>
                    </p>
                </div>
            </div>
        </div>
    );
}
