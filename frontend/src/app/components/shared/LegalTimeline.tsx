"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatNnReference } from "./legalSourceUtils";
import type { LegalDocumentVersion } from "./types";

/**
 * Version timeline for a cited regulation — a discrete-stop slider whose only
 * positions are the regulation's versions (one per NN objava, oldest first).
 * Legal text only changes at amendment dates, so the track snaps between
 * stops; there are no meaningful intermediate dates. Dragging previews the
 * stop label live; the (expensive) document refetch fires on commit only.
 * Pure presentation — the panel owns fetching and selection state.
 */
export function LegalTimeline({
    versions,
    selectedIndex,
    onSelect,
    disabled,
}: {
    /** Chronological version stops, oldest first (length ≥ 2). */
    versions: LegalDocumentVersion[];
    selectedIndex: number;
    onSelect: (index: number) => void;
    disabled?: boolean;
}) {
    const t = useTranslations("legalSource.timeline");
    const locale = useLocale();

    // Live preview while dragging; falls back to the committed selection.
    const [preview, setPreview] = useState<number | null>(null);
    useEffect(() => setPreview(null), [selectedIndex, versions]);
    const shown = preview ?? selectedIndex;
    const version = versions[shown];

    // "1. 1. 2024." (hr) — numeric without zero-padding; toLocaleDateString's
    // default hr form pads to "01. 01. 2024.", which isn't standard usage.
    const fmtDate = (iso: string | null) => {
        if (!iso) return null;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        return new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "numeric",
            year: "numeric",
        }).format(d);
    };

    const yearOf = (iso: string | null) =>
        iso && /^\d{4}/.test(iso) ? iso.slice(0, 4) : null;
    const firstYear = yearOf(versions[0]?.enterIntoForce ?? null);
    const lastYear = yearOf(
        versions[versions.length - 1]?.enterIntoForce ?? null,
    );

    // "NN 64/2023 · na snazi od 1.1.2024." (+ "do 30.6.2025." when closed)
    const stopLabel = useMemo(() => {
        if (!version) return "";
        const parts: string[] = [];
        const nn = formatNnReference(version.nnReference);
        if (nn) parts.push(nn);
        const from = fmtDate(version.enterIntoForce);
        const to = fmtDate(version.endDate);
        if (version.status === "future") {
            if (from) parts.push(t("entersIntoForce", { date: from }));
        } else if (from) {
            parts.push(
                to
                    ? t("inForceFromTo", { from, to })
                    : t("inForceFrom", { date: from }),
            );
        }
        return parts.join(" · ");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version, locale, t]);

    if (versions.length < 2) return null;

    const max = versions.length - 1;

    return (
        <div className="mt-2">
            <div className="flex items-center gap-1.5">
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    disabled={disabled || shown <= 0}
                    aria-label={t("olderVersion")}
                    onClick={() => onSelect(Math.max(0, selectedIndex - 1))}
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <div className="relative flex-1 px-1">
                    {/* A timeline, not a value slider: the filled Range is
                        meaningless here (it would bury the version ticks under
                        ink), so the track is a bare hairline and the ink thumb
                        marks the selected stop. data-slot hooks per shadcn. */}
                    <Slider
                        min={0}
                        max={max}
                        step={1}
                        value={[shown]}
                        disabled={disabled}
                        aria-label={t("sliderLabel")}
                        onValueChange={(v) => setPreview(v[0] ?? 0)}
                        onValueCommit={(v) => {
                            setPreview(null);
                            onSelect(v[0] ?? 0);
                        }}
                        className={cn(
                            // Generous hit zone: the Root is the pointer
                            // surface and Radix snaps any press to the nearest
                            // stop by X — so a tall Root means "near the dot"
                            // counts, no pixel-hunting on the hairline.
                            "h-8 cursor-pointer",
                            "[&_[data-slot=slider-track]]:h-0.5 [&_[data-slot=slider-track]]:bg-border",
                            "[&_[data-slot=slider-range]]:bg-transparent",
                            "[&_[data-slot=slider-thumb]]:relative [&_[data-slot=slider-thumb]]:z-10 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-thumb]]:border-2 [&_[data-slot=slider-thumb]]:border-foreground [&_[data-slot=slider-thumb]]:bg-background [&_[data-slot=slider-thumb]]:shadow-none",
                        )}
                    />
                    {/* Discrete stops — one tick per version, in-force stop
                        emphasized. Equal spacing (index, not elapsed time):
                        amendment bursts stay individually clickable. The px
                        compensation tracks Radix thumb-center positioning
                        (thumb never overhangs the track edge). */}
                    <div
                        className="pointer-events-none absolute inset-x-1 top-1/2 -translate-y-1/2"
                        aria-hidden="true"
                    >
                        {versions.map((v, i) => (
                            <span
                                key={v.id}
                                className={cn(
                                    "absolute h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/30",
                                    v.status === "in_force" &&
                                        "h-1.5 w-1.5 bg-success",
                                    v.status === "future" &&
                                        "bg-warning",
                                )}
                                style={{
                                    left: `calc(${(i / max) * 100}% + ${7 - 14 * (i / max)}px)`,
                                }}
                            />
                        ))}
                    </div>
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    disabled={disabled || shown >= max}
                    aria-label={t("newerVersion")}
                    onClick={() => onSelect(Math.min(max, selectedIndex + 1))}
                >
                    <ChevronRight className="h-3.5 w-3.5" />
                </Button>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2 px-7">
                <span className="text-[10px] tabular-nums text-muted-foreground">
                    {firstYear}
                </span>
                <span
                    className="min-w-0 truncate text-center text-[11px] font-medium text-foreground"
                    aria-live="polite"
                >
                    {stopLabel}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                    {lastYear}
                </span>
            </div>
        </div>
    );
}
