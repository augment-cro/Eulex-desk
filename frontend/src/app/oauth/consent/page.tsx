"use client";

/**
 * /oauth/consent — Supabase OAuth-server consent screen.
 *
 * Supabase Auth acts as an OAuth 2.1 authorization server (used by the
 * admin MCP's connector flow, and any future third-party OAuth client).
 * After validating an authorization request it redirects the browser here
 * with `?authorization_id=…`; this page loads the request's details via
 * `supabase.auth.oauth.*`, shows what the client is asking for, and submits
 * approve/deny — then follows the returned redirect back to the client.
 *
 * Lives OUTSIDE the (pages) group on purpose: no sidebar, no app providers
 * (same rationale as share/[token]). Unauthenticated visitors are sent to
 * /login with `next` pointing back here.
 */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { SiteLogo } from "@/components/site-logo";
import { getSupabase, supabaseAuthEnabled } from "@/lib/supabaseClient";

type AuthorizationDetails = {
    client?: { name?: string | null } | null;
    redirect_uri?: string | null;
    scope?: string | null;
};

const SCOPE_LABEL_KEYS: Record<string, string> = {
    openid: "scopeOpenid",
    email: "scopeEmail",
    profile: "scopeProfile",
};

function ConsentInner() {
    const t = useTranslations("oauthConsent");
    const router = useRouter();
    const params = useSearchParams();
    const authorizationId = params.get("authorization_id");

    const [details, setDetails] = useState<AuthorizationDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Raw upstream error, shown as fine print so a failed flow is diagnosable
    // from a screenshot (ids/enums only — GoTrue messages carry no PII).
    const [errorDetail, setErrorDetail] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!authorizationId) {
                setError(t("missingId"));
                setLoading(false);
                return;
            }
            if (!supabaseAuthEnabled) {
                setError(t("loadFailed"));
                setLoading(false);
                return;
            }
            const supabase = getSupabase();
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (cancelled) return;
            if (!user) {
                const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
                router.replace(`/login?next=${encodeURIComponent(next)}`);
                return;
            }
            const { data, error: loadError } =
                await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
            if (cancelled) return;
            if (loadError || !data) {
                // A dead client-side session reads as "auth session missing" —
                // bounce through login instead of dead-ending.
                if (/session/i.test(loadError?.message ?? "")) {
                    router.replace(
                        `/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`,
                    );
                    return;
                }
                setError(t("loadFailed"));
                setErrorDetail(loadError?.message ?? null);
            } else {
                const d = data as AuthorizationDetails & { redirect_url?: string };
                // Consent already given: the API returns only redirect_url —
                // follow it straight back to the client.
                if (d.redirect_url && !d.client) {
                    window.location.href = d.redirect_url;
                    return;
                }
                setDetails(d);
            }
            setLoading(false);
        }
        void load();
        return () => {
            cancelled = true;
        };
    }, [authorizationId, router, t]);

    const decide = useCallback(
        async (action: "approve" | "deny") => {
            if (!authorizationId || working) return;
            setWorking(true);
            setError(null);
            const supabase = getSupabase();
            const { data, error: actionError } =
                action === "approve"
                    ? await supabase.auth.oauth.approveAuthorization(authorizationId)
                    : await supabase.auth.oauth.denyAuthorization(authorizationId);
            if (actionError || !data?.redirect_url) {
                setError(t("actionFailed"));
                setWorking(false);
                return;
            }
            window.location.href = data.redirect_url;
        },
        [authorizationId, working, t],
    );

    const clientName = details?.client?.name?.trim() || t("unknownClient");
    const scopes = (details?.scope ?? "")
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean);
    let redirectHost: string | null = null;
    if (details?.redirect_uri) {
        try {
            redirectHost = new URL(details.redirect_uri).host;
        } catch {
            redirectHost = details.redirect_uri;
        }
    }

    return (
        <div className="min-h-dvh bg-paper flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-card border border-divider rounded-m p-8">
                    <h2 className="text-left h-display-l text-ink mb-2">{t("title")}</h2>

                    {loading ? (
                        <p className="text-ink-60">{t("loading")}</p>
                    ) : error ? (
                        <>
                            <p className="text-ink-60">{error}</p>
                            {errorDetail && (
                                <p className="text-ink-40 text-xs mt-3 break-words">
                                    {errorDetail}
                                </p>
                            )}
                        </>
                    ) : (
                        <>
                            <p className="text-ink-60 mb-6">
                                {t("wantsAccess", { client: clientName })}
                            </p>

                            {scopes.length > 0 && (
                                <div className="mb-6">
                                    <p className="text-ink text-sm font-medium mb-2">
                                        {t("permissionsTitle")}
                                    </p>
                                    <ul className="space-y-1">
                                        {scopes.map((scope) => (
                                            <li key={scope} className="text-ink-60 text-sm">
                                                {SCOPE_LABEL_KEYS[scope]
                                                    ? t(SCOPE_LABEL_KEYS[scope])
                                                    : scope}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {redirectHost && (
                                <p className="text-ink-40 text-xs mb-6">
                                    {t("redirectLabel")} {redirectHost}
                                </p>
                            )}

                            <div className="flex gap-3">
                                <button
                                    type="button"
                                    className="eu-btn eu-btn-brand flex-1"
                                    disabled={working}
                                    onClick={() => void decide("approve")}
                                >
                                    {working ? t("working") : t("approve")}
                                </button>
                                <button
                                    type="button"
                                    className="eu-btn flex-1"
                                    disabled={working}
                                    onClick={() => void decide("deny")}
                                >
                                    {t("deny")}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function OAuthConsentPage() {
    // useSearchParams requires a Suspense boundary at build time.
    return (
        <Suspense fallback={null}>
            <ConsentInner />
        </Suspense>
    );
}
