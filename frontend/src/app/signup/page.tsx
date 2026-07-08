"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Mail, MailCheck } from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";
import { track } from "@/app/lib/analytics";
import {
    getSupabase,
    supabaseAuthEnabled,
} from "@/lib/supabaseClient";
import {
    GoogleIcon,
    LinkedInIcon,
    MicrosoftIcon,
} from "@/components/ui/social-icons";
import Link from "next/link";

export default function SignupPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const t = useTranslations("signup");
    // Shared passwordless / OTP copy lives in the `login` namespace.
    const tl = useTranslations("login");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [magicSending, setMagicSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmationSent, setConfirmationSent] = useState(false);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    /**
     * Passwordless registration via magic link. signInWithOtp with
     * shouldCreateUser auto-creates the account on first use, so sign-up and
     * sign-in share one flow; display_name is carried in user_metadata (only
     * applied on creation). The link redirects to /auth/supabase-callback and
     * is exchanged there exactly like the sign-in and social flows.
     */
    const handleMagicLink = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!supabaseAuthEnabled || magicSending) return;
        const addr = email.trim();
        if (!addr) {
            setError(tl("magicLinkNoEmail"));
            return;
        }
        setMagicSending(true);
        setError(null);
        try {
            const { error: sbError } = await getSupabase().auth.signInWithOtp({
                email: addr,
                options: {
                    shouldCreateUser: true,
                    emailRedirectTo: `${window.location.origin}/auth/supabase-callback`,
                    ...(name.trim()
                        ? { data: { display_name: name.trim() } }
                        : {}),
                },
            });
            if (sbError) {
                setError(sbError.message || t("genericError"));
                setMagicSending(false);
                return;
            }
            setConfirmationSent(true);
        } catch {
            setError(t("genericError"));
            setMagicSending(false);
        }
    };

    /** Supabase social sign-up (same flow as sign-in). */
    const handleSocial = async (
        provider: "google" | "linkedin_oidc" | "azure",
    ) => {
        if (!supabaseAuthEnabled) return;
        setError(null);
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
            setError(err?.message || t("genericError"));
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
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left h-display-l text-ink">
                            {t("title")}
                        </h2>
                        <div className="bg-surface p-1 rounded-s flex eu-label--s">
                            <Link
                                href="/login"
                                className="px-3 py-1.5 text-ink-60 hover:text-ink"
                            >
                                {t("logIn")}
                            </Link>
                            <span className="px-3 py-1.5 bg-card rounded-xs text-ink">
                                {t("signUp")}
                            </span>
                        </div>
                    </div>

                    {confirmationSent ? (
                        <div className="text-center py-6">
                            <div className="mx-auto w-16 h-16 bg-surface rounded-full flex items-center justify-center mb-4">
                                <MailCheck
                                    className="h-8 w-8 text-ink-60"
                                    aria-hidden="true"
                                />
                            </div>
                            <p className="text-ink mb-2 font-medium">
                                {t("checkEmailTitle")}
                            </p>
                            <p className="text-ink-60 text-sm">
                                {t("checkEmailBody", { email: email.trim() })}
                            </p>
                        </div>
                    ) : supabaseAuthEnabled ? (
                        <>
                            <form
                                onSubmit={handleMagicLink}
                                className="space-y-3"
                            >
                                <input
                                    type="text"
                                    autoComplete="name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t("nameLabel")}
                                    aria-label={t("nameLabel")}
                                    className={inputClass}
                                />
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
                                    disabled={magicSending}
                                    className="eu-btn eu-btn-brand w-full gap-2"
                                >
                                    {magicSending ? (
                                        <span className="flex items-center gap-2">
                                            <span className="animate-spin rounded-full h-4 w-4 border-2 border-ink border-t-transparent" />
                                            {tl("magicLinkSending")}
                                        </span>
                                    ) : (
                                        <>
                                            <Mail className="w-4 h-4" />
                                            {tl("magicLinkButton")}
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
                                    onClick={() => handleSocial("google")}
                                    className="eu-btn w-full gap-2"
                                >
                                    <GoogleIcon />
                                    Google
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleSocial("linkedin_oidc")}
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
                    ) : (
                        <div className="text-center py-6">
                            <p className="text-ink mb-2 font-medium">
                                {t("managedByEulex")}
                            </p>
                            <p className="text-ink-60 text-sm mb-6">
                                {t("createOnEulex")}
                            </p>
                            <a
                                href="https://eulex.ai/signup"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="eu-btn eu-btn-brand w-full"
                                onClick={() =>
                                    track("signup_started", {
                                        source: "signup",
                                    })
                                }
                            >
                                {t("createAccountOnEulex")}
                            </a>
                        </div>
                    )}

                    {error && (
                        <div className="mt-4 text-red-700 text-sm bg-red-50 p-3 rounded-s border border-red-100">
                            {error}
                        </div>
                    )}

                    <div className="border-t border-divider pt-4 mt-6 text-center">
                        <p className="text-xs text-ink-40">
                            {t("alreadyHaveAccount")}{" "}
                            <Link
                                href="/login"
                                className="text-ink underline decoration-ink-40 underline-offset-2 hover:decoration-ink"
                            >
                                {t("signIn")}
                            </Link>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
