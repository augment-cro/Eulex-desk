"use client";

/**
 * DailyUsageRing — Claude-style daily-quota indicator for the composer.
 *
 * A small SVG ring that fills with the share of the user's rolling-24h
 * token budget already spent (effective limit = tier daily quota +
 * active credit packs — the same numbers the `RateLimit-*` headers
 * carry). Fills `success` green below the 80% soft threshold and
 * switches to brand magenta above it — a deliberate product exception
 * (2026-07-07) to the "highlight is decoration-only" rule, approved for
 * this indicator. Two notches mark the ring like Claude's: one at the
 * 80% threshold, one at the top where the ring starts/ends.
 *
 * Data comes from `useRateLimitStatus` (rateLimitStore) — populated by
 * `RateLimit-*` response headers on every API call, the one-shot
 * `/user/rate-limit-status` fetch on mount, and 429 bodies.
 */

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRateLimitStatus } from "../../hooks/useRateLimitStatus";

const SIZE = 20;
const CENTER = SIZE / 2;
const RADIUS = 7.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Mirrors SOFT_WARNING_THRESHOLD on the backend (rateLimit.ts). */
const SOFT_THRESHOLD = 0.8;
/** Notch positions as ring fractions: soft threshold + ring start/end. */
const TICKS = [SOFT_THRESHOLD, 1];

function tickCoords(frac: number) {
    const angle = (frac * 360 - 90) * (Math.PI / 180);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
        x1: round(CENTER + (RADIUS - 2) * cos),
        y1: round(CENTER + (RADIUS - 2) * sin),
        x2: round(CENTER + (RADIUS + 2) * cos),
        y2: round(CENTER + (RADIUS + 2) * sin),
    };
}

/** "2 h 15 min" / "34 min"; null → caller shows the "soon" copy. */
function formatRelief(iso: string | null): string | null {
    if (!iso) return null;
    const diffMs = new Date(iso).getTime() - Date.now();
    if (diffMs <= 0) return null;
    const minutes = Math.round(diffMs / 60_000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours} h ${remMin} min` : `${hours} h`;
}

export function DailyUsageRing() {
    const t = useTranslations("rateLimit");
    const snap = useRateLimitStatus();

    if (!snap || snap.limitTokens <= 0) return null;

    const frac = Math.min(1, snap.usedTokens / snap.limitTokens);
    const percent = Math.round(frac * 100);
    const overSoft = frac >= SOFT_THRESHOLD;
    const relief = formatRelief(snap.nextReliefAt);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label={t("usageRingAria", { percent })}
                    className="flex h-8 w-8 cursor-default items-center justify-center rounded-lg transition-colors hover:bg-accent"
                >
                    <svg
                        width={SIZE}
                        height={SIZE}
                        viewBox={`0 0 ${SIZE} ${SIZE}`}
                        aria-hidden="true"
                        className="shrink-0"
                    >
                        <circle
                            cx={CENTER}
                            cy={CENTER}
                            r={RADIUS}
                            fill="none"
                            strokeWidth={2}
                            className="stroke-border"
                        />
                        <circle
                            cx={CENTER}
                            cy={CENTER}
                            r={RADIUS}
                            fill="none"
                            strokeWidth={2}
                            strokeDasharray={CIRCUMFERENCE}
                            strokeDashoffset={CIRCUMFERENCE * (1 - frac)}
                            transform={`rotate(-90 ${CENTER} ${CENTER})`}
                            className={cn(
                                "transition-[stroke-dashoffset] duration-500",
                                overSoft ? "stroke-magenta" : "stroke-success",
                            )}
                        />
                        {/* Notches "cut" both track and fill in the composer
                            surface color, reading as gaps in the ring. */}
                        {TICKS.map((f) => {
                            const p = tickCoords(f);
                            return (
                                <line
                                    key={f}
                                    {...p}
                                    strokeWidth={1.5}
                                    className="stroke-surface-elevated"
                                />
                            );
                        })}
                    </svg>
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-60">
                <div className="space-y-0.5">
                    <div className="font-medium">{t("usageRingTitle")}</div>
                    <div>{t("usageRingUsed", { percent })}</div>
                    <div>{t("usageRingRemaining", { remaining: 100 - percent })}</div>
                    {snap.bonusTokens > 0 && <div>{t("usageRingBonus")}</div>}
                    <div className="opacity-80">
                        {relief
                            ? t("usageRingReset", { relief })
                            : t("usageRingResetSoon")}
                    </div>
                </div>
            </TooltipContent>
        </Tooltip>
    );
}
