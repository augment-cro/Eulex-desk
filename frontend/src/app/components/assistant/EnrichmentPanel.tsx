"use client";

import { useEffect, useRef } from "react";
import { Scale, Shield, Network, X, Loader2, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import type { QueryEnrichmentResult, EnrichedQuery } from "@/app/lib/mikeApi";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandItem,
    CommandList,
} from "@/components/ui/command";

interface Props {
    result: QueryEnrichmentResult;
    onSelect: (improvedQuery: string) => void;
    onClose: () => void;
    /** Per-card streaming text (typewriter). Index matches card position. */
    streamingTexts?: string[];
    /** True while the SSE stream is still active. */
    isStreaming?: boolean;
}

// Visual config per analytical lens (index 0-2)
const LENS_CONFIG = [
    {
        icon: Scale,
        labelKey: "normative",
        color: "text-foreground",
        bg: "bg-accent",
        border: "border-border",
        badgeBg: "bg-accent text-foreground border border-border",
        selectedBg: "bg-accent/80",
        cursorColor: "bg-foreground",
        skeletonBar: "bg-muted",
        shortcut: "1",
    },
    {
        icon: Shield,
        labelKey: "compliance",
        color: "text-foreground",
        bg: "bg-accent",
        border: "border-border",
        badgeBg: "bg-accent text-foreground border border-border",
        selectedBg: "bg-accent/80",
        cursorColor: "bg-foreground",
        skeletonBar: "bg-muted",
        shortcut: "2",
    },
    {
        icon: Network,
        labelKey: "systemic",
        color: "text-foreground",
        bg: "bg-accent",
        border: "border-border",
        badgeBg: "bg-accent text-foreground border border-border",
        selectedBg: "bg-accent/80",
        cursorColor: "bg-foreground",
        skeletonBar: "bg-muted",
        shortcut: "3",
    },
] as const;

const TOTAL_CARDS = 3;

export function EnrichmentPanel({
    result,
    onSelect,
    onClose,
    streamingTexts = [],
    isStreaming = false,
}: Props) {
    const t = useTranslations("assistant.enrichment");
    const panelRef = useRef<HTMLDivElement>(null);

    // Completed variants from result
    const completedVariants: (EnrichedQuery | undefined)[] = Array.from(
        { length: TOTAL_CARDS },
        (_, i) =>
            result.improved_queries_rich?.[i] ??
            (result.improved_queries[i]
                ? { query: result.improved_queries[i], why: "" }
                : undefined),
    );

    // Number shortcuts: press 1/2/3 to select
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
                return;
            }
            const idx = parseInt(e.key) - 1;
            if (idx >= 0 && idx < TOTAL_CARDS) {
                const variant = completedVariants[idx];
                if (variant) {
                    onSelect(variant.query);
                }
            }
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [completedVariants, onSelect, onClose]);

    return (
        <div
            ref={panelRef}
            className="animate-in slide-in-from-top-2 fade-in duration-200 relative"
        >
            <Command
                className="rounded-xl border border-border bg-surface-elevated overflow-visible"
                shouldFilter={false}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
                    <div className="flex items-center gap-2 text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5 text-foreground" />
                        <span className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground">
                            {t("selectVariant")}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {isStreaming && (
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/70" />
                                {t("generating")}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="rounded-full p-1 text-muted-foreground/70 hover:text-muted-foreground hover:bg-accent transition-colors"
                            aria-label="Close"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>

                {/* Keyboard hint */}
                <div className="px-3 py-1.5 border-b border-border flex items-center gap-3">
                    <span className="text-[10px] text-muted-foreground/70">
                        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">↑↓</kbd>
                        {" "}{t("hint.navigate")}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70">
                        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">Enter</kbd>
                        {" "}{t("hint.select")}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70">
                        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">1</kbd>
                        {" "}<kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">2</kbd>
                        {" "}<kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">3</kbd>
                        {" "}{t("hint.shortcuts")}
                    </span>
                    <span className="text-[10px] text-muted-foreground/70 ml-auto">
                        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px] font-mono border border-border">Esc</kbd>
                        {" "}{t("hint.close")}
                    </span>
                </div>

                <CommandList className="max-h-none overflow-visible p-1.5 space-y-1">
                    <CommandEmpty className="py-3 text-xs text-muted-foreground/70 text-center">
                        {t("generatingVariants")}
                    </CommandEmpty>

                    <CommandGroup>
                        {Array.from({ length: TOTAL_CARDS }, (_, index) => {
                            const cfg = LENS_CONFIG[index];
                            const Icon = cfg.icon;
                            const completed = completedVariants[index];
                            const streamingText = streamingTexts[index] ?? "";
                            const isThisCardStreaming =
                                isStreaming && !completed && streamingText.length > 0;
                            const isThisCardPending =
                                isStreaming && !completed && streamingText.length === 0;

                            // ── Pending skeleton ──────────────────────────────
                            if (isThisCardPending) {
                                return (
                                    <div
                                        key={index}
                                        className="flex items-start gap-3 px-3 py-3 rounded-lg"
                                    >
                                        <div
                                            className={`h-7 w-7 rounded-lg ${cfg.bg} shrink-0 animate-pulse`}
                                        />
                                        <div className="flex-1 space-y-2 py-1">
                                            <div
                                                className={`h-2 ${cfg.skeletonBar} rounded w-16 animate-pulse`}
                                            />
                                            <div className="h-3.5 bg-muted rounded w-5/6 animate-pulse" />
                                            <div className="h-3.5 bg-muted rounded w-2/3 animate-pulse" />
                                        </div>
                                    </div>
                                );
                            }

                            // ── Streaming card (typewriter) ───────────────────
                            if (isThisCardStreaming) {
                                return (
                                    <div
                                        key={index}
                                        className={`animate-in fade-in slide-in-from-bottom-1 duration-200 flex items-start gap-3 px-3 py-3 rounded-lg border ${cfg.border} ${cfg.bg}/30`}
                                    >
                                        <div
                                            className={`flex items-center justify-center h-7 w-7 rounded-lg ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0 mt-0.5`}
                                        >
                                            <Icon className="h-3.5 w-3.5" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span
                                                    className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${cfg.badgeBg}`}
                                                >
                                                    {t(`lens.${cfg.labelKey}`)}
                                                </span>
                                            </div>
                                            <p className="text-sm text-foreground leading-relaxed">
                                                {streamingText}
                                                <span
                                                    className={`inline-block w-0.5 h-[1em] ${cfg.cursorColor} ml-0.5 align-middle animate-[blink_0.9s_step-end_infinite]`}
                                                />
                                            </p>
                                        </div>
                                    </div>
                                );
                            }

                            // ── Completed CommandItem ─────────────────────────
                            if (completed) {
                                return (
                                    <CommandItem
                                        key={index}
                                        value={completed.query}
                                        onSelect={() => onSelect(completed.query)}
                                        className={`animate-in fade-in slide-in-from-bottom-1 duration-300 flex items-start gap-3 px-3 py-3 rounded-lg cursor-pointer transition-all group aria-selected:bg-accent aria-selected:border-border border border-transparent hover:border-border hover:bg-accent/80`}
                                    >
                                        {/* Lens icon */}
                                        <div
                                            className={`flex items-center justify-center h-7 w-7 rounded-lg ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0 mt-0.5 transition-all group-aria-selected:scale-105`}
                                        >
                                            <Icon className="h-3.5 w-3.5" />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <span
                                                    className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${cfg.badgeBg}`}
                                                >
                                                    {t(`lens.${cfg.labelKey}`)}
                                                </span>
                                                {/* Number shortcut badge */}
                                                <kbd className="ml-auto text-[9px] px-1 py-0.5 bg-muted text-muted-foreground/70 rounded border border-border font-mono opacity-0 group-aria-selected:opacity-100 transition-opacity">
                                                    {cfg.shortcut}
                                                </kbd>
                                            </div>

                                            <p className="text-sm text-foreground leading-relaxed group-aria-selected:text-foreground">
                                                {completed.query}
                                            </p>

                                            {completed.why && (
                                                <p className="mt-1 text-[11px] text-muted-foreground leading-snug italic">
                                                    {completed.why}
                                                </p>
                                            )}
                                        </div>
                                    </CommandItem>
                                );
                            }

                            return null;
                        })}
                    </CommandGroup>
                </CommandList>
            </Command>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Loading skeleton (shown before any card arrives)
// ---------------------------------------------------------------------------

export function EnrichmentLoading() {
    const t = useTranslations("assistant.enrichment");
    return (
        <div className="animate-in fade-in duration-200 border border-border rounded-xl bg-surface-elevated p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-muted-foreground px-2 py-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-[11px] font-semibold tracking-widest uppercase">
                    {t("loading")}
                </span>
            </div>
            <div className="space-y-1">
                {([0, 1, 2] as const).map((i) => {
                    const cfg = LENS_CONFIG[i];
                    return (
                        <div
                            key={i}
                            className="flex gap-3 px-2 py-2.5 rounded-lg animate-pulse"
                        >
                            <div className={`h-7 w-7 rounded-lg ${cfg.bg} shrink-0`} />
                            <div className="flex-1 space-y-2 py-1">
                                <div className={`h-2 ${cfg.skeletonBar} rounded w-16`} />
                                <div className="h-3.5 bg-muted rounded w-5/6" />
                                <div className="h-3.5 bg-muted rounded w-2/3" />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
