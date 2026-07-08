"use client";

/**
 * Email-bound chat share landing page (deep link from invite email).
 *
 * Lives OUTSIDE the `(pages)` route group on purpose:
 *   - the (pages) layout force-redirects unauthenticated users to /login
 *     without preserving the deep link; we need `/login?next=/share/<token>`
 *     so the recipient lands back here after sign-in
 *   - the share view is a standalone snapshot — sidebar + chat history
 *     navigation would be confusing for a recipient who has no chats
 *     of their own yet
 *
 * Backend contract: GET /share/:token returns a structured `code` on
 * failure (`email_mismatch`, `expired`, `revoked`, `not_found`,
 * `chat_missing`) so we can render distinct UX for each.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    ArrowRight,
    Loader2,
    MailWarning,
    ShieldAlert,
    Clock,
    Lock,
    LogIn,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
    getSharedChat,
    getSharedChatPreview,
    acceptSharedChat,
    type SharedChatView,
    type SharedChatPreview,
} from "@/app/lib/mikeApi";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { SiteLogo } from "@/components/site-logo";

type ErrorCode =
    | "email_mismatch"
    | "expired"
    | "revoked"
    | "not_found"
    | "chat_missing"
    | "unknown";

interface ApiErrorBody {
    detail?: string;
    code?: ErrorCode;
    expectedEmail?: string;
}

function parseApiError(err: unknown): ApiErrorBody {
    const raw = err instanceof Error ? err.message : String(err);
    try {
        return JSON.parse(raw) as ApiErrorBody;
    } catch {
        return { detail: raw };
    }
}

export default function SharedChatPage() {
    const params = useParams();
    const router = useRouter();
    const { isAuthenticated, authLoading, signOut } = useAuth();
    const t = useTranslations("shareChat");

    const token = (params?.token as string | undefined) ?? "";

    const [view, setView] = useState<SharedChatView | null>(null);
    const [preview, setPreview] = useState<SharedChatPreview | null>(null);
    // Set when the caller is logged in but with a different email than the
    // invite — we still show the teaser, but the CTA must switch accounts.
    const [mismatchEmail, setMismatchEmail] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<ApiErrorBody | null>(null);
    const [accepting, setAccepting] = useState(false);

    function goToLogin() {
        const next = `/share/${encodeURIComponent(token)}`;
        router.push(`/login?next=${encodeURIComponent(next)}`);
    }

    // Logged in as the wrong account: drop the session, then send them to
    // /login (with this deep link as `next`) so they can sign in with the
    // invited email and land back here.
    async function switchAccount() {
        try {
            await signOut();
        } catch {
            /* ignore — we navigate to /login regardless */
        }
        goToLogin();
    }

    // Logged-in (matching email) recipients get the full, email-bound
    // snapshot. Logged-out visitors get the PUBLIC truncated teaser plus a
    // sign-in gate — no auto-redirect, so they can see what's shared first.
    useEffect(() => {
        if (authLoading || !token) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setView(null);
        setPreview(null);
        setMismatchEmail(null);

        void (async () => {
            try {
                if (isAuthenticated) {
                    try {
                        const data = await getSharedChat(token);
                        if (!cancelled) setView(data);
                    } catch (err) {
                        const parsed = parseApiError(err);
                        // Signed in with the wrong account: instead of a
                        // dead-end error, show the public teaser + a prompt
                        // to switch to the invited email. The share is known
                        // valid here (the backend checks revoked/expired
                        // before email_mismatch), so the preview will load.
                        if (parsed.code === "email_mismatch") {
                            const pv = await getSharedChatPreview(token);
                            if (!cancelled) {
                                setPreview(pv);
                                setMismatchEmail(parsed.expectedEmail ?? null);
                            }
                        } else {
                            throw err;
                        }
                    }
                } else {
                    const pv = await getSharedChatPreview(token);
                    if (!cancelled) setPreview(pv);
                }
            } catch (err) {
                if (!cancelled) setError(parseApiError(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [authLoading, isAuthenticated, token]);

    async function handleContinue() {
        if (!view || accepting) return;
        setAccepting(true);
        try {
            const res = await acceptSharedChat(token);
            router.replace(res.redirect_to);
        } catch (err) {
            setError(parseApiError(err));
            setAccepting(false);
        }
    }

    if (authLoading || loading) {
        return <CenteredSpinner />;
    }

    if (error) {
        return <ShareErrorScreen error={error} />;
    }

    // Teaser path: logged-out visitors, OR logged-in with the wrong email
    // (mismatchEmail set). Both render the public teaser + a sign-in gate.
    if (preview) {
        return (
            <SharePreviewScreen
                preview={preview}
                mismatchEmail={mismatchEmail}
                onPrimary={mismatchEmail ? switchAccount : goToLogin}
            />
        );
    }

    if (!view) {
        return <ShareErrorScreen error={{ code: "not_found" }} />;
    }

    const ownerLabel =
        view.owner.display_name?.trim() ||
        view.owner.email ||
        t("ownerFallback");
    const sharedDate = formatDate(view.shared_at);
    const expiryDate = formatDate(view.expires_at);
    const isLive = view.mode === "live";

    return (
        <div className="min-h-dvh bg-background flex flex-col">
            <header className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
                <SiteLogo size="sm" asLink />
                <button
                    onClick={handleContinue}
                    disabled={accepting}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 disabled:opacity-40 transition-colors"
                >
                    {accepting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <ArrowRight className="h-4 w-4" />
                    )}
                    {isLive ? t("openInChat") : t("continueConversation")}
                </button>
            </header>

            <div className="px-6 pt-6 pb-2 max-w-3xl mx-auto w-full">
                <div className="rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground">
                    <p className="font-medium text-foreground">
                        {t("snapshotBannerTitle", { name: ownerLabel })}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                        {isLive
                            ? t("snapshotBannerLive")
                            : t("snapshotBannerHint", { date: sharedDate })}
                        {" · "}
                        {t("expiresOn", { date: expiryDate })}
                    </p>
                </div>
            </div>

            <main className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
                    {view.chat.title && (
                        <h1 className="text-2xl font-serif text-foreground">
                            {view.chat.title}
                        </h1>
                    )}
                    {view.messages.length === 0 ? (
                        <p className="text-sm text-muted-foreground/70">{t("emptyChat")}</p>
                    ) : (
                        view.messages.map((m, i) =>
                            m.role === "user" ? (
                                <UserMessage
                                    key={i}
                                    content={m.content ?? ""}
                                    files={(m as { files?: { filename: string }[] }).files}
                                    workflow={
                                        (m as { workflow?: { id: string; title: string } })
                                            .workflow
                                    }
                                />
                            ) : (
                                <AssistantMessage
                                    key={i}
                                    content={m.content ?? ""}
                                    events={m.events}
                                    annotations={m.annotations}
                                />
                            ),
                        )
                    )}
                </div>
            </main>

            <footer className="border-t border-border px-6 py-4 shrink-0">
                <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                        {t("continueExplainer")}
                    </p>
                    <button
                        onClick={handleContinue}
                        disabled={accepting}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 disabled:opacity-40 transition-colors"
                    >
                        {accepting ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <ArrowRight className="h-4 w-4" />
                        )}
                        {isLive ? t("openInChat") : t("continueConversation")}
                    </button>
                </div>
            </footer>
        </div>
    );
}

function CenteredSpinner() {
    return (
        <div className="min-h-dvh flex items-center justify-center bg-background">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/70" />
        </div>
    );
}

function ShareErrorScreen({ error }: { error: ApiErrorBody }) {
    const t = useTranslations("shareChat");
    const code = (error.code ?? "unknown") as ErrorCode;

    let title: string;
    let body: string;
    let Icon = ShieldAlert;
    if (code === "email_mismatch") {
        title = t("errorEmailMismatchTitle");
        body = error.expectedEmail
            ? t("errorEmailMismatchBodyWithEmail", {
                  email: error.expectedEmail,
              })
            : t("errorEmailMismatchBody");
        Icon = MailWarning;
    } else if (code === "expired" || code === "revoked") {
        title = t("errorExpiredTitle");
        body = t("errorExpiredBody");
        Icon = Clock;
    } else {
        title = t("errorNotFoundTitle");
        body = t("errorNotFoundBody");
    }

    return (
        <div className="min-h-dvh flex flex-col bg-background">
            <header className="px-6 py-4 border-b border-border">
                <SiteLogo size="sm" asLink />
            </header>
            <div className="flex-1 flex items-center justify-center px-6">
                <div className="max-w-md w-full rounded-2xl border border-border bg-background p-8 text-center">
                    <Icon className="h-8 w-8 text-muted-foreground/70 mx-auto mb-4" />
                    <h1 className="text-xl font-serif text-foreground mb-2">
                        {title}
                    </h1>
                    <p className="text-sm text-muted-foreground">{body}</p>
                    {error.detail && code === "unknown" && (
                        <p className="mt-3 text-xs text-muted-foreground/70">
                            {error.detail}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}

function SharePreviewScreen({
    preview,
    mismatchEmail,
    onPrimary,
}: {
    preview: SharedChatPreview;
    mismatchEmail?: string | null;
    onPrimary: () => void;
}) {
    const t = useTranslations("shareChat");
    const ownerLabel = preview.owner_name?.trim() || t("ownerFallback");
    const expiryDate = formatDate(preview.expires_at);
    const isMismatch = !!mismatchEmail;
    const bannerText = isMismatch
        ? t("previewMismatchBanner", { email: mismatchEmail ?? "" })
        : t("previewBanner", { name: ownerLabel });
    const ctaLabel = isMismatch
        ? t("previewSwitchCta", { email: mismatchEmail ?? "" })
        : t("previewSignIn");

    return (
        <div className="min-h-dvh bg-background flex flex-col">
            <header className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
                <SiteLogo size="sm" asLink />
                <button
                    onClick={onPrimary}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-4 py-2 transition-colors"
                >
                    <LogIn className="h-4 w-4" />
                    {t("previewSignIn")}
                </button>
            </header>

            <div className="px-6 pt-6 pb-2 max-w-3xl mx-auto w-full">
                <div className="rounded-xl border border-border bg-muted px-4 py-3 text-sm text-foreground">
                    <p className="text-foreground">{bannerText}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                        {t("expiresOn", { date: expiryDate })}
                    </p>
                </div>
            </div>

            <main className="flex-1 overflow-y-auto">
                <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
                    {preview.title && (
                        <h1 className="text-2xl font-serif text-foreground">
                            {preview.title}
                        </h1>
                    )}

                    {preview.question && (
                        <div className="space-y-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                {t("previewQuestionLabel")}
                            </p>
                            <UserMessage content={preview.question} />
                        </div>
                    )}

                    {preview.answer_excerpt && (
                        <div className="space-y-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                {t("previewAnswerLabel")}
                            </p>
                            <div className="relative">
                                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                                    {preview.answer_excerpt}
                                </p>
                                {preview.answer_truncated && (
                                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background to-transparent" />
                                )}
                            </div>
                        </div>
                    )}

                    <div className="rounded-2xl border border-border bg-muted p-6 text-center">
                        <Lock className="h-7 w-7 text-muted-foreground/70 mx-auto mb-3" />
                        <h2 className="text-lg font-serif text-foreground mb-1">
                            {t("previewLockTitle")}
                        </h2>
                        <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
                            {t("previewLockBody")}
                        </p>
                        <button
                            onClick={onPrimary}
                            className="inline-flex items-center gap-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium px-5 py-2.5 transition-colors"
                        >
                            <ArrowRight className="h-4 w-4" />
                            {ctaLabel}
                        </button>
                    </div>
                </div>
            </main>
        </div>
    );
}

function formatDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    try {
        const d = new Date(iso);
        return new Intl.DateTimeFormat(undefined, {
            day: "numeric",
            month: "long",
            year: "numeric",
        }).format(d);
    } catch {
        return iso;
    }
}
