"use client";

import { Layers, AlertTriangle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { useOptionalContexts } from "@/app/contexts/ContextsContext";
import { SystemContextBadge } from "../contexts/SystemContextBadge";
import { contextModelLabel, unavailableNames } from "../contexts/contextLabels";
import type { AssistantEvent } from "../shared/types";

type Applied = Extract<AssistantEvent, { type: "contexts_applied" }>;

/**
 * Under an answer: the contexts that took part in it and, when a system
 * context chose them, the model and reasoning effort the answer ran on. A
 * context or context document that could not be loaded is named in a warning
 * line — the answer ran without it. When an EULEX system context took part,
 * its disclaimer follows — the answer is neither legal advice nor proof of
 * compliance.
 */
export function ContextsAppliedFooter({ event }: { event: Applied }) {
    const t = useTranslations("contextsApplied");
    const locale = useLocale();
    // Names a context that failed to load; absent on a shared chat.
    const known = useOptionalContexts()?.items ?? [];
    const unavailable = event.unavailable ?? [];
    if (event.contexts.length === 0 && unavailable.length === 0) return null;
    const anySystem = event.contexts.some((c) => c.level === "system");
    return (
        <div className="mt-3 flex flex-col gap-2 border-t border-dashed border-border pt-3">
            {event.contexts.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Layers className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t("label")}</span>
                    {event.contexts.map((c) => (
                        <Badge key={c.id} variant="outline" className="gap-1.5">
                            {c.level === "system" && (
                                <SystemContextBadge className="border-0 p-0" />
                            )}
                            <span className="max-w-48 truncate">{c.name}</span>
                            {c.version_label && (
                                <span className="text-muted-foreground">
                                    {c.version_label}
                                </span>
                            )}
                        </Badge>
                    ))}
                    {event.model && <span>· {contextModelLabel(event.model)}</span>}
                    {event.effort && (
                        <span>
                            ·{" "}
                            {t("effort", {
                                level: t(`effortLevels.${event.effort}`),
                            })}
                        </span>
                    )}
                </div>
            )}
            {unavailable.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                    <AlertTriangle
                        className="mt-px h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                    />
                    <span>
                        {t("unavailable", {
                            names: unavailableNames(
                                unavailable,
                                known.map((i) => i.context),
                                locale,
                                t("unavailableContext"),
                            ).join(", "),
                        })}
                    </span>
                </p>
            )}
            {anySystem && (
                <p className="text-xs text-muted-foreground">
                    {t("systemDisclaimer")}
                </p>
            )}
        </div>
    );
}
