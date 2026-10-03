"use client";

import {
    BookOpen,
    ExternalLink,
    FileText,
    Link2,
    Pin,
    Scale,
    X,
    type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
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
    /** System contexts: alerts are out of the MVP — no tracking controls. */
    hideAlerts?: boolean;
}

const KIND_ICON: Record<MikeContextSource["kind"], LucideIcon> = {
    legal_instrument: BookOpen,
    legal_article: FileText,
    caselaw: Scale,
    web: Link2,
    document: FileText,
};

const STATUS_CLASS: Record<string, string> = {
    draft: "text-warning",
    consultation: "text-warning",
    final: "text-success",
    living: "text-muted-foreground",
};

export function SourceRow({
    source,
    onPatch,
    onRemove,
    readOnly,
    hideAlerts,
}: Props) {
    const t = useTranslations("newContext");
    const meta = [source.issuer, source.published_on].filter(Boolean).join(" · ");
    const pinnable = source.kind === "legal_article";
    const isLegal =
        source.kind === "legal_instrument" || source.kind === "legal_article";
    const alertable = isLegal && CELEX_RE.test(source.ref);

    const badges = (source.authority_tier || source.doc_status || meta) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {source.authority_tier && (
                <Badge variant="secondary">
                    {source.authority_tier === "internal"
                        ? t("tierInternal")
                        : t("tierLabel", { tier: source.authority_tier })}
                </Badge>
            )}
            {source.doc_status && (
                <Badge
                    variant="outline"
                    className={STATUS_CLASS[source.doc_status]}
                >
                    {t(`docStatus_${source.doc_status}`)}
                </Badge>
            )}
            {meta && <span>{meta}</span>}
        </div>
    );

    // Reading layout (a context the viewer cannot edit, e.g. an EULEX system
    // context): nothing here is a control, so a key source is a badge, not a
    // switch, and the usage note is text, not a field.
    if (readOnly) {
        const Icon = KIND_ICON[source.kind] ?? FileText;
        const label = source.label ?? source.ref;
        return (
            <div className="flex gap-3.5 px-4 py-3.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        {source.kind === "web" ? (
                            <a
                                href={source.ref}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-w-0 items-baseline gap-1.5 text-sm leading-snug text-foreground underline-offset-2 hover:underline"
                            >
                                <span>{label}</span>
                                <ExternalLink
                                    className="h-3 w-3 shrink-0 self-center text-muted-foreground"
                                    aria-hidden="true"
                                />
                            </a>
                        ) : (
                            <span className="min-w-0 text-sm leading-snug text-foreground">
                                {label}
                            </span>
                        )}
                        {source.mode === "pinned" && (
                            <Badge className="shrink-0" title={t("keySourceHint")}>
                                <Pin aria-hidden="true" />
                                {t("keySource")}
                            </Badge>
                        )}
                    </div>
                    {badges}
                    {source.retrieval_note && (
                        <p className="border-l-2 border-border pl-2.5 text-sm leading-normal text-muted-foreground">
                            {source.retrieval_note}
                        </p>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="min-w-0 truncate text-sm text-foreground">
                        {source.label ?? source.ref}
                    </span>
                    {badges}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                    <label
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                        title={t("keySourceHint")}
                    >
                        <Switch
                            size="sm"
                            checked={source.mode === "pinned"}
                            disabled={!pinnable}
                            onCheckedChange={(v) =>
                                onPatch({ mode: v ? "pinned" : "retrieved" })
                            }
                        />
                        {t("pin")}
                    </label>
                    {hideAlerts ? null : alertable ? (
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Switch
                                size="sm"
                                checked={source.tracked_for_alerts}
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
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label={t("removeSource")}
                        title={t("removeSource")}
                        className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                    >
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <Textarea
                defaultValue={source.retrieval_note ?? ""}
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
