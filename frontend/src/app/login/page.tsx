"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight, Mail, MailCheck } from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";
import {
    stashPostLoginRedirect,
    consumePostLoginRedirect,
} from "@/lib/oauth";
import {
    getSupabase,
    mirrorSupabaseSession,
    supabaseAuthEnabled,
} from "@/lib/supabaseClient";
import {
    GoogleIcon,
    LinkedInIcon,
    MicrosoftIcon,
} from "@/components/ui/social-icons";
import Link from "next/link";
import { track } from "@/app/lib/analytics";

export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const t = useTranslations("login");
    const [error, setError] = useState<string | null>(null);
    const [email, setEmail] = useState("");
    const [magicSending, setMagicSending] = useState(false);
    const [magicLinkSent, setMagicLinkSent] = useState(false);
    const [otpCode, setOtpCode] = useState("");
    const [verifyingOtp, setVerifyingOtp] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const raw = params.get("next") ?? params.get("redirect");
        if (raw) stashPostLoginRedirect(raw);
        // Prefill from an eulex.ai hero hand-off: /login?email=…
        const prefill = params.get("email");
        if (prefill) setEmail(prefill);
    }, []);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            const next = consumePostLoginRedirect();
            router.replace(next ?? "/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    /**
     * Passwordless sign-in via magic link. signInWithOtp sends the default
     * {{ .ConfirmationURL }} which, under PKCE, redirects back to
     * /auth/supabase-callback with ?code= — exchanged there exactly like the
     * social and signup flows. The code-verifier lives in this browser's
     * localStorage, so the link must be opened in the same browser (the
     * "open it in this browser" copy nudges that). shouldCreateUser is left
     * at its default (auto-create + backend email-link), matching social
     * sign-in; flip it to false to restrict magic links to existing accounts.
     */
    const handleMagicLink = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!supabaseAuthEnabled || magicSending) return;
        const addr = email.trim();
        if (!addr) {
            setError(t("magicLinkNoEmail"));
            return;
        }
        setMagicSending(true);
        setError(null);
        track("signup_started", { source: "login", method: "magic_link" });
        try {
            const { error: sbError } = await getSupabase().auth.signInWithOtp({
                email: addr,
                options: {
                    emailRedirectTo: `${window.location.origin}/auth/supabase-callback`,
                },
            });
            if (sbError) {
                setError(sbError.message || t("magicLinkError"));
                setMagicSending(false);
                return;
            }
            setMagicLinkSent(true);
        } catch {
            setError(t("magicLinkError"));
            setMagicSending(false);
        }
    };

    /**
     * Cross-device fallback for the magic link. The same signInWithOtp call
     * also e-mails a 6-digit code once the Magic Link template includes
     * {{ .Token }}. verifyOtp doesn't consume the PKCE code-verifier, so the
     * code works on any device/browser (unlike the link). On success
     * mirrorSupabaseSession primes the legacy token store and AuthContext's
     * isAuthenticated effect performs the redirect — same as the link flow.
     */
    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        if (verifyingOtp) return;
        const code = otpCode.trim();
        if (!code) return;
        setVerifyingOtp(true);
        setError(null);
        try {
            const { data, error: sbError } =
                await getSupabase().auth.verifyOtp({
                    email: email.trim(),
                    token: code,
                    type: "email",
                });
            if (sbError || !data.session) {
                setError(t("otpInvalid"));
                setVerifyingOtp(false);
                return;
            }
            mirrorSupabaseSession(data.session);
        } catch {
            setError(t("otpInvalid"));
            setVerifyingOtp(false);
        }
    };

    /** Supabase social sign-in (Google / LinkedIn OIDC / Microsoft). */
    const handleSocial = async (
        provider: "google" | "linkedin_oidc" | "azure",
    ) => {
        if (!supabaseAuthEnabled) return;
        setError(null);
        track("signup_started", { source: "login", method: provider });
        try {
            await getSupabase().auth.signInWithOAuth({
                provider,
                options: {
                    redirectTo: `${window.location.origin}/auth/supabase-callback`,
                    // Azure (Microsoft Entra) needs the email scope to put
                    // the address on the token for our account auto-link.
                    ...(provider === "azure" ? { scopes: "email" } : {}),
                },
            });
            // Browser navigates away to the provider.
        } catch (err: any) {
            setError(err?.message || t("invalidCredentials"));
        }
    };

    // Deep-link from the eulex.ai hero: /login?provider=… auto-starts that
    // social flow once, so the provider buttons there feel direct. (Email is
    // only prefilled, never auto-sent — that would be an e-mail-bomb vector.)
    const socialAutostarted = useRef(false);
    useEffect(() => {
        if (typeof window === "undefined" || socialAutostarted.current) return;
        const provider = new URLSearchParams(window.location.search).get(
            "provider",
        );
        if (
            supabaseAuthEnabled &&
            (provider === "google" ||
                provider === "linkedin_oidc" ||
                provider === "azure")
        ) {
            socialAutostarted.current = true;
            void handleSocial(provider);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const inputClass =
        "w-full rounded-s border border-divider bg-card px-3 py-2.5 text-sm text-ink placeholder:text-ink-40 focus:outline-none focus:border-ink-60";

    return (
        <div className="min-h-dvh bg-paper flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="xl" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-card border border-divider rounded-m p-8">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left h-display-l text-ink">
                            {t("title")}
                        </h2>
                        <div className="bg-surface p-1 rounded-s flex eu-label--s">
                            <span className="text-ink px-3 py-1.5 bg-card rounded-xs">
                                {t("logIn")}
                            </span>
                            <Link
                                href="/signup"
                                className="px-3 py-1.5 text-ink-60 hover:text-ink"
                            >
                                {t("signUp")}
                            </Link>
                        </div>
                    </div>

                    {magicLinkSent ? (
                        <div className="py-6">
                            <div className="mx-auto w-16 h-16 bg-surface rounded-full flex items-center justify-center mb-4">
                                <MailCheck
                                    className="h-8 w-8 text-ink-60"
                                    aria-hidden="true"
                                />
                            </div>
                            <p className="text-center text-ink mb-2 font-medium">
                                {t("magicLinkSentTitle")}
                            </p>
                            <p className="text-center text-ink-60 text-sm">
                                {t("magicLinkSentBody", { email: email.trim() })}
                            </p>

                            <div className="my-5 flex items-center gap-3">
                                <span className="h-px flex-1 bg-divider" />
                                <span className="text-xs text-ink-40 text-center">
                                    {t("otpOrEnterCode")}
                                </span>
                                <span className="h-px flex-1 bg-divider" />
                            </div>

                            <form
                                onSubmit={handleVerifyOtp}
                                className="space-y-3"
                            >
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    // Supabase "Email OTP Length" is set to 8 for this
                                    // project; keep this in sync if that dashboard value changes.
                                    maxLength={8}
                                    required
                                    value={otpCode}
                                    onChange={(e) =>
                                        setOtpCode(
                                            e.target.value.replace(/\D/g, ""),
                                        )
                                    }
                                    placeholder={t("otpCodeLabel")}
                                    aria-label={t("otpCodeLabel")}
                                    className={`${inputClass} text-center tracking-[0.4em]`}
                                />
                                <button
                                    type="submit"
                                    disabled={verifyingOtp}
                                    className="eu-btn eu-btn-brand w-full"
                                >
                                    {verifyingOtp ? (
                                        <span className="flex items-center gap-2">
                                            <span className="animate-spin rounded-full h-4 w-4 border-2 border-ink border-t-transparent" />
                                            {t("otpVerifying")}
                                        </span>
                                    ) : (
                                        <>
                                            {t("otpVerifyButton")}
                                            <ArrowRight className="w-4 h-4" />
                                        </>
                                    )}
                                </button>
                            </form>

                            {error && (
                                <div className="mt-4 text-red-700 text-sm bg-red-50 p-3 rounded-s border border-red-100">
                                    {error}
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={() => {
                                    setMagicLinkSent(false);
                                    setMagicSending(false);
                                    setOtpCode("");
                                    setError(null);
                                }}
                                className="eu-btn w-full mt-3"
                            >
                                {t("backToLogin")}
                            </button>
                        </div>
                    ) : (
                        <>
                            {supabaseAuthEnabled && (
                                <>
                                    <form
                                        onSubmit={handleMagicLink}
                                        className="space-y-3"
                                    >
                                        <input
                                            type="email"
                                            autoComplete="email"
                                            required
                                            value={email}
                                            onChange={(e) =>
                                                setEmail(e.target.value)
                                            }
                                            placeholder={t("emailLabel")}
                                            aria-label={t("emailLabel")}
                                            className={inputClass}
                                        />
                                        <button
                                            type="submit"
                                            disabled={magicSending}
                                            className="eu-btn eu-btn-brand w-full gap-2"
                                        >
                                            {magicSending ? (
                                                <span className="flex items-center gap-2">
                                                    <span className="animate-spin rounded-full h-4 w-4 border-2 border-ink border-t-transparent" />
                                                    {t("magicLinkSending")}
                                                </span>
                                            ) : (
                                                <>
                                                    <Mail className="w-4 h-4" />
                                                    {t("magicLinkButton")}
                                                </>
                                            )}
                                        </button>
                                    </form>

                                    <div className="my-5 flex items-center gap-3">
                                        <span className="h-px flex-1 bg-divider" />
                                        <span className="text-xs text-ink-40">
                                            {t("orContinueWith")}
                                        </span>
                                        <span className="h-px flex-1 bg-divider" />
                                    </div>

                                    <div className="grid grid-cols-3 gap-3">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                handleSocial("google")
                                            }
                                            className="eu-btn w-full gap-2"
                                        >
                                            <GoogleIcon />
                                            Google
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                handleSocial("linkedin_oidc")
                                            }
                                            className="eu-btn w-full gap-2"
                                        >
                                            <LinkedInIcon />
                                            LinkedIn
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleSocial("azure")}
                                            className="eu-btn w-full gap-2"
                                        >
                                            <MicrosoftIcon />
                                            Microsoft
                                        </button>
                                    </div>
                                </>
                            )}

                            <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-60">
                                {t.rich("legalNotice", {
                                    terms: (chunks) => (
                                        <a
                                            href="https://eulex.ai/terms"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-ink underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                                        >
                                            {chunks}
                                        </a>
                                    ),
                                    privacy: (chunks) => (
                                        <a
                                            href="https://eulex.ai/privacy"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-ink underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                                        >
                                            {chunks}
                                        </a>
                                    ),
                                })}
                            </p>

                            {error && (
                                <div className="mt-4 text-red-700 text-sm bg-red-50 p-3 rounded-s border border-red-100">
                                    {error}
                                </div>
                            )}

                            <p className="mt-5 text-center text-xs text-ink-40">
                                {t("noAccount")}{" "}
                                <Link
                                    href="/signup"
                                    className="text-ink underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                                >
                                    {t("createAccount")}
                                </Link>
                            </p>
                            {process.env.NEXT_PUBLIC_SOURCE_URL && (
                                <p className="mt-3 text-center text-xs text-ink-40">
                                    <a
                                        href={process.env.NEXT_PUBLIC_SOURCE_URL}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                                    >
                                        {t("sourceCode")}
                                    </a>
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
