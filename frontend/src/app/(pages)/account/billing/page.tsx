"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    refreshRateLimitStatus,
    useRateLimitStatus,
} from "@/app/hooks/useRateLimitStatus";
import { TopupModal } from "@/app/components/shared/TopupModal";

function fmt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

export default function AccountBillingPage() {
    const params = useSearchParams();
    const t = useTranslations("rateLimit");
    const tb = useTranslations("account.billing");
    const snap = useRateLimitStatus();
    const [topupOpen, setTopupOpen] = useState(false);
    const topupResult = params.get("topup");

    useEffect(() => {
        if (topupResult === "success") {
            // Stripe webhook lands the credit; the rate-limit cache
            // doesn't know yet. Force a refresh so the bonus shows up
            // within seconds. We retry a couple times in case the
            // webhook is still processing.
            const retry = async () => {
                for (let i = 0; i < 4; i++) {
                    await refreshRateLimitStatus();
                    if (i < 3) {
                        await new Promise((r) => setTimeout(r, 2000));
                    }
                }
            };
            retry();
        }
    }, [topupResult]);

    return (
        <div className="mx-auto max-w-2xl space-y-6 p-6">
            <div>
                <h1 className="font-serif text-2xl font-semibold text-foreground">
                    {tb("title")}
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    {tb("subtitle")}
                </p>
            </div>

            {topupResult === "success" && (
                <div className="rounded-md border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
                    {tb("topupSuccess")}
                </div>
            )}
            {topupResult === "cancelled" && (
                <div className="rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning">
                    {tb("topupCancelled")}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Card label={tb("subscription")} value={snap?.tierLabel ?? "—"} />
                <Card
                    label={tb("used24h")}
                    value={snap ? fmt(snap.usedTokens) : "—"}
                    subValue={
                        snap
                            ? tb("usedOf", {
                                  limit: fmt(snap.limitTokens),
                                  remaining: fmt(snap.remainingTokens),
                              })
                            : undefined
                    }
                />
                <Card
                    label={tb("bonusTokens")}
                    value={snap ? fmt(snap.bonusTokens) : "—"}
                    subValue={tb("bonusHint")}
                />
                <Card
                    label={tb("requests24h")}
                    value={snap ? fmt(snap.questionsInWindow) : "—"}
                />
            </div>

            {snap?.topupAvailable && (
                <button
                    type="button"
                    onClick={() => setTopupOpen(true)}
                    className="rounded-md bg-action px-4 py-2 text-sm font-medium text-action-foreground hover:bg-action/90"
                >
                    {t("topupCta")}
                </button>
            )}

            <TopupModal open={topupOpen} onClose={() => setTopupOpen(false)} />
        </div>
    );
}

function Card({
    label,
    value,
    subValue,
}: {
    label: string;
    value: string;
    subValue?: string;
}) {
    return (
        <div className="rounded-lg border border-border bg-background px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
            {subValue && (
                <div className="mt-0.5 text-xs text-muted-foreground">{subValue}</div>
            )}
        </div>
    );
}
