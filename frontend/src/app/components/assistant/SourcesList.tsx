"use client";

import { BookmarkPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { LegalSource } from "../shared/types";

/**
 * Compact "Izvori" / "Sources" list rendered under an assistant answer.
 * One chip per legal source consulted this turn (deduped by id); clicking a
 * chip opens the same right-side document panel as the inline citation pills.
 * When `onSaveAsContext` is provided, a "save as context" affordance sits
 * next to the heading — it seeds a new context with these sources.
 */
export function SourcesList({
    sources,
    onSourceClick,
    onSaveAsContext,
}: {
    sources: LegalSource[];
    onSourceClick: (source: LegalSource) => void;
    onSaveAsContext?: () => void;
}) {
    const t = useTranslations("legalSource");
    const tSave = useTranslations("saveAsContext");
    if (sources.length === 0) return null;

    return (
        <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("sourcesHeading")}
                </p>
                {onSaveAsContext && (
                    <button
                        type="button"
                        onClick={onSaveAsContext}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <BookmarkPlus className="h-3 w-3" />
                        {tSave("affordance")}
                    </button>
                )}
            </div>
            <div className="flex flex-wrap gap-2">
                {sources.map((s) => (
                    <button
                        key={s.id}
                        type="button"
                        onClick={() => onSourceClick(s)}
                        title={s.citation || s.title}
                        className={cn(
                            "group inline-flex max-w-[280px] items-center gap-2 rounded-lg border border-border bg-card py-1.5 pl-1.5 pr-3 text-left text-xs text-foreground transition-all hover:-translate-y-px hover:border-border hover:bg-accent",
                        )}
                    >
                        <Badge
                            variant="secondary"
                            className={cn(
                                "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                                s.scope === "@eu"
                                    ? "bg-accent text-foreground"
                                    : "bg-muted text-muted-foreground",
                            )}
                        >
                            {s.scope === "@eu"
                                ? t("badge.eu")
                                : s.scope === "@hr"
                                  ? t("badge.hr")
                                  : t("badge.fr")}
                        </Badge>
                        <span className="truncate font-medium text-foreground/90 group-hover:text-foreground">
                            {s.title}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
