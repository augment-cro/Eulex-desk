"use client";

/**
 * In-conversation rate-limit notice. Rendered inside the assistant
 * message stream (not above the composer like `RateLimitBanner`) when a
 * turn is blocked by the daily limit — so the user gets a clear answer
 * in the chat window instead of an empty/dropped bubble. Tells them the
 * limit is reached and offers the CTA to pick a larger plan / top up.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { useRateLimitStatus } from "../../hooks/useRateLimitStatus";
import { PlansModal } from "./PlansModal";
import { TopupModal } from "./TopupModal";

function formatRelief(iso: string | null | undefined): string {
    if (!iso) return "—";
    const target = new Date(iso);
    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) return "uskoro";
    const minutes = Math.round(diffMs / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

export function RateLimitChatNotice() {
    const t = useTranslations("rateLimit");
    const snap = useRateLimitStatus();
    const [topupOpen, setTopupOpen] = useState(false);
    const [plusOpen, setPlusOpen] = useState(false);

    const tierLabel = snap?.tierLabel ?? "Eulex FREE";
    const topupAvailable = !!snap?.topupAvailable;

    return (
        <div
            role="alert"
            className="mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
            <div className="flex items-start gap-2.5">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                    <div className="font-medium">{t("chatNoticeTitle")}</div>
                    <p className="mt-0.5 text-[13px] leading-snug opacity-90">
                        {t("chatNoticeBody", { tier: tierLabel })}
                    </p>
                    {snap?.nextReliefAt && (
                        <p className="mt-0.5 text-[11px] opacity-70">
                            {t("chatNoticeRelief", {
                                relief: formatRelief(snap.nextReliefAt),
                            })}
                        </p>
                    )}
                    <div className="mt-2.5">
                        {topupAvailable ? (
                            <button
                                type="button"
                                onClick={() => setTopupOpen(true)}
                                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                            >
                                {t("topupCta")}
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setPlusOpen(true)}
                                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                            >
                                {t("upgradeCta")}
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <TopupModal open={topupOpen} onClose={() => setTopupOpen(false)} />
            <PlansModal open={plusOpen} onClose={() => setPlusOpen(false)} />
        </div>
    );
}
