"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useContexts } from "@/app/contexts/ContextsContext";
import type { MikeContextTask } from "@/app/lib/mikeApi";
import {
    contextTaskWorkflow,
    localizedTaskText,
    workflowPreselectHref,
} from "@/app/lib/workflowPreselect";

const OUTPUT_KINDS: readonly string[] = ["docx", "xlsx", "chat"];

/**
 * The "Zadaci" tab of a system context: its tasks (workflows such as "RT-10
 * Provjera usklađenosti dokumenta") with what each needs and produces. "Pokreni"
 * switches the context on for the user when it is off — the task is only
 * available while its context is active — and opens a new chat with the task
 * selected as the workflow.
 */
export function ContextTasksPanel({
    contextId,
    tasks,
}: {
    contextId: string;
    tasks: MikeContextTask[];
}) {
    const t = useTranslations("contextTasks");
    const locale = useLocale();
    const router = useRouter();
    const { enabled, toggle } = useContexts();
    const [starting, setStarting] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    async function start(task: MikeContextTask) {
        setStarting(task.id);
        setFailed(false);
        if (!enabled[contextId]) {
            const res = await toggle(contextId, true);
            if (!res.ok) {
                setFailed(true);
                setStarting(null);
                return;
            }
        }
        router.push(
            workflowPreselectHref(contextTaskWorkflow(contextId, task, locale)),
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {failed && (
                <p className="text-sm text-destructive">{t("startFailed")}</p>
            )}
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {tasks.map((task) => {
                    const when = localizedTaskText(
                        task.when_i18n,
                        task.when_i18n?.hr ?? task.when_i18n?.en ?? "",
                        locale,
                    );
                    const outputName = task.output
                        ? localizedTaskText(
                              task.output.name_i18n,
                              task.output.name ?? "",
                              locale,
                          )
                        : "";
                    return (
                        <li key={task.id} className="flex flex-col gap-2 px-4 py-3">
                            <div className="flex items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-xs text-muted-foreground">
                                            {task.id}
                                        </span>
                                        <span className="font-medium text-foreground">
                                            {localizedTaskText(task.name_i18n, task.name, locale)}
                                        </span>
                                        <Badge
                                            variant="outline"
                                            className={cn(
                                                task.status === "ready"
                                                    ? "border-success/30 bg-success/10 text-success"
                                                    : "text-muted-foreground",
                                            )}
                                        >
                                            {t(task.status === "ready" ? "statusReady" : "statusDraft")}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {localizedTaskText(task.summary_i18n, task.summary, locale)}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="shrink-0"
                                    disabled={starting !== null}
                                    onClick={() => void start(task)}
                                >
                                    {starting === task.id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Play className="h-3.5 w-3.5" />
                                    )}
                                    {t("start")}
                                </Button>
                            </div>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                                {when && (
                                    <>
                                        <dt className="text-muted-foreground">{t("when")}</dt>
                                        <dd className="text-foreground">{when}</dd>
                                    </>
                                )}
                                {task.inputs?.required?.length ? (
                                    <>
                                        <dt className="text-muted-foreground">{t("requiredInputs")}</dt>
                                        <dd className="text-foreground">
                                            {task.inputs.required.join(" · ")}
                                        </dd>
                                    </>
                                ) : null}
                                {task.inputs?.optional?.length ? (
                                    <>
                                        <dt className="text-muted-foreground">{t("optionalInputs")}</dt>
                                        <dd className="text-foreground">
                                            {task.inputs.optional.join(" · ")}
                                        </dd>
                                    </>
                                ) : null}
                                {task.output && (
                                    <>
                                        <dt className="text-muted-foreground">{t("output")}</dt>
                                        <dd className="text-foreground">
                                            {OUTPUT_KINDS.includes(task.output.kind)
                                                ? t(`outputKind.${task.output.kind}`)
                                                : task.output.kind}
                                            {outputName ? ` — ${outputName}` : ""}
                                        </dd>
                                    </>
                                )}
                            </dl>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
