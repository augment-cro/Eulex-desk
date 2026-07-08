"use client";

/**
 * Discrete inline banner sitting just above any compose surface
 * (Assistant, Project chat, Tabular chat panel, Workflows). Stays
 * hidden until the rolling 24h usage crosses 80% of the tier limit;
 * goes "soft" between 80–100% and "hard" once exhausted.
 *
 * Mirrors Claude.ai / ChatGPT ergonomics: small chip, no modal,
 * dismissible "soft" copy, blocking "hard" copy with relief time.
 *
 * Plus subscribers also get a "Nadoplati" CTA that opens
 * `TopupModal` (Stripe Checkout in `/account/billing`).
 */

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRateLimitStatus } from "../../hooks/useRateLimitStatus";
import { track } from "@/app/lib/analytics";
import { PlansModal } from "./PlansModal";
import { TopupModal } from "./TopupModal";

/**
 * Whether the current hard-block episode has already been tracked.
 * Module-level on purpose: the rate-limit snapshot lives in a module-level
 * store, and the banner remounts on every chat/route navigation — a ref
 * would re-fire paywall_shown once per navigation for one continuous block.
 * Reset when the state drops below "hard" so the next distinct block counts.
 */
let hardBlockTracked = false;

function formatNumber(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function formatRelief(iso: string | null): string {
    if (!iso) return "—";
    const target = new Date(iso);
    const now = Date.now();
    const diffMs = target.getTime() - now;
    if (diffMs <= 0) return "uskoro";
    const minutes = Math.round(diffMs / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

export function RateLimitBanner() {
    const t = useTranslations("rateLimit");
    const snap = useRateLimitStatus();
    const [topupOpen, setTopupOpen] = useState(false);
    const [plusOpen, setPlusOpen] = useState(false);

    // Fire paywall_shown once per hard-block episode. The soft 80–100%
    // warning is dismissible and doesn't block sending — it isn't a
    // paywall, so it isn't tracked.
    const isHardBlock = !!snap && snap.state === "hard";
    useEffect(() => {
        if (isHardBlock && !hardBlockTracked) {
            hardBlockTracked = true;
            track("paywall_shown", { trigger: "rate_limit" });
        } else if (!isHardBlock) {
            hardBlockTracked = false;
        }
    }, [isHardBlock]);

    if (!snap) return null;
    if (snap.state === "hidden") return null;

    const isHard = snap.state === "hard";
    const percent = snap.limitTokens
        ? Math.min(100, Math.round((snap.usedTokens / snap.limitTokens) * 100))
        : 0;

    return (
        <>
            <div
                role={isHard ? "alert" : "status"}
                className={`mb-2 w-full rounded-md border px-3 py-2 text-xs ${
                    isHard
                        ? "border-destructive/20 bg-destructive/10 text-destructive"
                        : "border-warning/20 bg-warning/10 text-warning"
                }`}
            >
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <div className="font-medium">
                            {isHard
                                ? t("hardTitle", { tier: snap.tierLabel })
                                : t("softTitle", { tier: snap.tierLabel })}
                        </div>
                        <div className="mt-0.5 text-[11px] opacity-80">
                            {isHard
                                ? t("hardBody", {
                                      relief: formatRelief(snap.nextReliefAt),
                                  })
                                : `${t("softBody", {
                                      used: formatNumber(snap.usedTokens),
                                      limit: formatNumber(snap.limitTokens),
                                      percent: String(percent),
                                  })} ${t(
                                      snap.topupAvailable
                                          ? "softHintTopup"
                                          : "softHintUpgrade",
                                  )}`}
                            {snap.bonusTokens > 0 && (
                                <span className="ml-2 inline-flex items-center gap-1 rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-medium">
                                    +{formatNumber(snap.bonusTokens)}{" "}
                                    {t("bonusBadge")}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {snap.topupAvailable && (
                            <button
                                type="button"
                                onClick={() => setTopupOpen(true)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                    isHard
                                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        : "bg-warning text-warning-foreground hover:bg-warning/90"
                                }`}
                            >
                                {t("topupCta")}
                            </button>
                        )}
                        {!snap.topupAvailable && (
                            <button
                                type="button"
                                onClick={() => setPlusOpen(true)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                                    isHard
                                        ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        : "bg-warning text-warning-foreground hover:bg-warning/90"
                                }`}
                            >
                                {t("upgradeCta")}
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <TopupModal open={topupOpen} onClose={() => setTopupOpen(false)} />
            <PlansModal open={plusOpen} onClose={() => setPlusOpen(false)} />
        </>
    );
}
