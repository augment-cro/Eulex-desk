"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { MikeContextSource } from "@/app/lib/mikeApi";

// EU (CELEX-shaped) legal sources are alertable in v1; HR/AT, caselaw and
// web sources show the "not yet available" hint instead (spec §Alerting v1).
const CELEX_RE = /^\d{5}[a-z]{1,2}\d{4}/i;

interface Props {
    source: MikeContextSource;
    /** Persisted through PATCH /contexts/:id/sources/:sourceId. */
    onPatch: (patch: {
        mode?: "pinned" | "retrieved";
        retrieval_note?: string;
        tracked_for_alerts?: boolean;
    }) => void;
    onRemove: () => void;
    readOnly?: boolean;
}

export function SourceRow({ source, onPatch, onRemove, readOnly }: Props) {
    const t = useTranslations("newContext");
    const pinnable = source.kind === "legal_article";
    const isLegal =
        source.kind === "legal_instrument" || source.kind === "legal_article";
    const alertable = isLegal && CELEX_RE.test(source.ref);

    return (
        <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm text-foreground">
                    {source.label ?? source.ref}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                            size="sm"
                            checked={source.mode === "pinned"}
                            disabled={!pinnable || readOnly}
                            onCheckedChange={(v) =>
                                onPatch({ mode: v ? "pinned" : "retrieved" })
                            }
                        />
                        {t("pin")}
                    </label>
                    {alertable ? (
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Switch
                                size="sm"
                                checked={source.tracked_for_alerts}
                                disabled={readOnly}
                                onCheckedChange={(v) =>
                                    onPatch({ tracked_for_alerts: v })
                                }
                            />
                            {t("trackAlerts")}
                        </label>
                    ) : (
                        <span className="text-xs text-muted-foreground/70">
                            {t("alertsUnavailable")}
                        </span>
                    )}
                    {!readOnly && (
                        <button
                            type="button"
                            onClick={onRemove}
                            aria-label={t("removeSource")}
                            title={t("removeSource")}
                            className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
            <Textarea
                defaultValue={source.retrieval_note ?? ""}
                disabled={readOnly}
                onBlur={(e) => {
                    const v = e.target.value;
                    if (v !== (source.retrieval_note ?? "")) {
                        onPatch({ retrieval_note: v });
                    }
                }}
                placeholder={t("retrievalNote")}
                className="mt-2 min-h-16 text-sm"
            />
        </div>
    );
}
