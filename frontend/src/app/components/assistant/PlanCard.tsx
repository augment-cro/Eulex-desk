"use client";

import { AlertTriangle, Circle, Contrast, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { renderStatusTokens } from "../shared/StatusDot";
import type { PlanStep } from "../shared/types";

// The status mark of a step: done ●, in progress ◐, pending ○, blocked ⚠.
const MARKS: Record<PlanStep["status"], { Icon: LucideIcon; className: string }> = {
    done: { Icon: Circle, className: "fill-current text-foreground" },
    in_progress: { Icon: Contrast, className: "text-foreground" },
    pending: { Icon: Circle, className: "text-muted-foreground" },
    blocked: { Icon: AlertTriangle, className: "text-warning" },
};

function StepMark({ status, label }: { status: PlanStep["status"]; label: string }) {
    const { Icon, className } = MARKS[status];
    return <Icon role="img" aria-label={label} className={cn("size-3 shrink-0", className)} />;
}

/**
 * The plan the model keeps while it applies a task or workflow (update_plan):
 * one line per step — status mark, title, an optional note in muted text —
 * and a thin done/total progress bar. Shown above the answer; follows the
 * latest plan_updated live while the answer streams.
 */
export function PlanCard({ steps, className }: { steps: PlanStep[]; className?: string }) {
    const t = useTranslations("planCard");
    if (steps.length === 0) return null;
    const done = steps.filter((s) => s.status === "done").length;
    return (
        <section
            data-slot="plan-card"
            aria-label={t("label")}
            className={cn("rounded-lg border border-border bg-card px-3 py-2.5", className)}
        >
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium uppercase tracking-wider">{t("label")}</span>
                <span className="tabular-nums">
                    {done}/{steps.length}
                </span>
            </div>
            <div
                role="progressbar"
                aria-label={t("progress", { done, total: steps.length })}
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={done}
                className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-muted"
            >
                <div
                    className="h-full rounded-full bg-foreground transition-[width] duration-300"
                    style={{ width: `${(done / steps.length) * 100}%` }}
                />
            </div>
            <ol className="mt-2 flex flex-col gap-1">
                {steps.map((s, i) => (
                    <li
                        key={i}
                        className="flex min-w-0 items-center gap-2 text-sm"
                        title={s.note ? `${s.title} — ${s.note}` : s.title}
                    >
                        <StepMark status={s.status} label={t(`status.${s.status}`)} />
                        <span
                            className={cn(
                                "min-w-0 truncate",
                                s.status === "done" ? "text-muted-foreground" : "text-foreground",
                            )}
                        >
                            {renderStatusTokens(s.title)}
                        </span>
                        {s.note && (
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {renderStatusTokens(s.note)}
                            </span>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}
