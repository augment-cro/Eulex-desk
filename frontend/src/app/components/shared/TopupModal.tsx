"use client";

/**
 * Token top-up modal — shown to Plus subscribers from `RateLimitBanner`.
 * Lists the catalog from `GET /billing/topup/packs`, then on click
 * creates a Stripe Checkout session and redirects the browser there.
 * Bank-transfer customers are routed to a static info page instead.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { getStoredTokens } from "@/lib/oauth";
import { track } from "@/app/lib/analytics";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

type Pack = {
    id: string;
    tokens: number;
    label: string;
    description: string;
    amountEurDisplay: number;
};

type CatalogResponse = {
    enabled: boolean;
    eligible: boolean;
    packs: Pack[];
};

export function TopupModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const t = useTranslations("rateLimit");
    const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [redirecting, setRedirecting] = useState<string | null>(null);

    useEffect(() => {
        if (!open || catalog) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const tokens = getStoredTokens();
                if (!tokens?.access_token) throw new Error("Not authenticated");
                const res = await fetch(`${API_BASE}/billing/topup/packs`, {
                    headers: {
                        Authorization: `Bearer ${tokens.access_token}`,
                    },
                });
                if (!res.ok) throw new Error(await res.text());
                const body = (await res.json()) as CatalogResponse;
                if (!cancelled) setCatalog(body);
            } catch (err) {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, catalog]);

    async function startCheckout(packId: string) {
        setRedirecting(packId);
        setError(null);
        track("topup_started");
        try {
            const tokens = getStoredTokens();
            if (!tokens?.access_token) throw new Error("Not authenticated");
            const res = await fetch(
                `${API_BASE}/billing/topup/create-session`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${tokens.access_token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ pack_id: packId }),
                },
            );
            if (!res.ok) {
                const detail = await res.text();
                throw new Error(detail || `HTTP ${res.status}`);
            }
            const body = (await res.json()) as { url: string };
            window.location.href = body.url;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setRedirecting(null);
        }
    }

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-primary/60 px-4"
            role="dialog"
            aria-modal="true"
            onClick={onClose}
        >
            <div
                className="w-full max-w-lg rounded-lg border border-border bg-background p-5"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <h2 className="font-serif text-lg font-semibold text-foreground">
                        {t("topupTitle")}
                    </h2>
                    <button
                        onClick={onClose}
                        className="rounded p-1 text-muted-foreground/70 hover:text-foreground"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{t("topupSubtitle")}</p>

                {error && (
                    <div className="mt-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {error}
                    </div>
                )}

                {loading && (
                    <div className="mt-4 text-sm text-muted-foreground">
                        {t("loading")}
                    </div>
                )}

                {catalog && !catalog.enabled && (
                    <div className="mt-4 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
                        {t("topupDisabled")}
                    </div>
                )}

                {catalog && catalog.enabled && !catalog.eligible && (
                    <div className="mt-4 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
                        {t("topupPlusOnly")}
                    </div>
                )}

                {catalog && catalog.enabled && catalog.eligible && (
                    <ul className="mt-4 space-y-3">
                        {catalog.packs.map((p) => (
                            <li
                                key={p.id}
                                className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">
                                        {p.label}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {p.description}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="font-mono text-sm text-foreground">
                                        {p.amountEurDisplay.toLocaleString(
                                            "hr-HR",
                                            {
                                                style: "currency",
                                                currency: "EUR",
                                            },
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        disabled={redirecting === p.id}
                                        onClick={() => startCheckout(p.id)}
                                        className="mt-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                    >
                                        {redirecting === p.id
                                            ? t("redirecting")
                                            : t("buyCta")}
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                <p className="mt-4 text-[11px] text-muted-foreground">
                    {t("topupBankTransferHint")}
                </p>
            </div>
        </div>
    );
}
