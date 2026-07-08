"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Loader2, AlertTriangle, Minus, X } from "lucide-react";
import type {
    ColumnConfig,
    MikeDocument,
    TabularCell,
} from "../shared/types";

interface Props {
    open: boolean;
    generating: boolean;
    documents: MikeDocument[];
    columns: ColumnConfig[];
    cells: TabularCell[];
    onClose: () => void;
}

// A central progress modal that surfaces what the "Pokreni" run is doing
// in real time:
//   • overall progress bar (done / total)
//   • currently-generating cells (doc name + column label)
//   • done / failed counters
//   • auto-hides ~1.5s after the run finishes
//   • can be minimised to a floating chip so the user keeps using the table
export function TRRunProgressModal({
    open,
    generating,
    documents,
    columns,
    cells,
    onClose,
}: Props) {
    const t = useTranslations("tabularReview");
    const [minimised, setMinimised] = useState(false);

    // Only count cells that belong to a currently-loaded (doc × column). The
    // `cells` prop can carry stale rows (deleted docs/columns, or a fallback
    // to all project docs) that would otherwise push the counters past `total`
    // and make the percentage jump around — so we filter to the current grid
    // to keep numerator and denominator consistent.
    const total = documents.length * columns.length;
    const counts = useMemo(() => {
        const validDocs = new Set(documents.map((d) => d.id));
        const validCols = new Set(columns.map((c) => c.index));
        let done = 0;
        let inProgress = 0;
        let failed = 0;
        for (const c of cells) {
            if (!validDocs.has(c.document_id) || !validCols.has(c.column_index))
                continue;
            if (c.status === "done") done += 1;
            else if (c.status === "generating") inProgress += 1;
            else if (c.status === "error") failed += 1;
        }
        return { done, inProgress, failed };
    }, [cells, documents, columns]);

    const percent =
        total === 0 ? 0 : Math.min(100, Math.round((counts.done / total) * 100));

    // Currently-generating cells, prettified. Cap to 3 entries so the
    // modal doesn't stretch; the counter conveys the rest.
    const activeCells = useMemo(() => {
        const docById = new Map(documents.map((d) => [d.id, d.filename]));
        const colByIdx = new Map(columns.map((c) => [c.index, c.name]));
        return cells
            .filter((c) => c.status === "generating")
            .slice(0, 3)
            .map((c) => ({
                docName: docById.get(c.document_id) ?? c.document_id,
                colLabel:
                    colByIdx.get(c.column_index) ?? `#${c.column_index + 1}`,
                key: `${c.document_id}-${c.column_index}`,
            }));
    }, [cells, documents, columns]);

    // Auto-close when the run is finished AND user hasn't already minimised.
    // We add a small dwell so the "Done" state is actually visible.
    useEffect(() => {
        if (!open || generating) return;
        if (total === 0) return;
        const id = setTimeout(() => onClose(), 1600);
        return () => clearTimeout(id);
    }, [open, generating, total, onClose]);

    // Reset minimised state every time the modal is freshly opened.
    useEffect(() => {
        if (open) setMinimised(false);
    }, [open]);

    if (!open) return null;

    const completed = !generating && total > 0;

    // Minimised: floating chip in bottom-right. Tapping it restores the modal.
    if (minimised) {
        return (
            <button
                onClick={() => setMinimised(false)}
                aria-label={t("runProgressRestore")}
                className="fixed bottom-6 right-6 z-[9999] flex items-center gap-2 rounded-full bg-surface-elevated px-4 py-2 ring-1 ring-ring transition"
            >
                {completed ? (
                    <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-warning" />
                )}
                <span className="text-xs font-medium text-foreground">
                    {counts.done}/{total}
                </span>
                <span className="text-xs text-muted-foreground">
                    {completed
                        ? t("runProgressCompleted")
                        : t("runProgressProcessing")}
                </span>
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-primary/30 px-4">
            <div
                className="w-full max-w-lg rounded-2xl bg-surface-elevated ring-1 ring-ring"
                role="dialog"
                aria-modal="true"
                aria-label={t("runProgressTitle")}
            >
                <div className="flex items-start justify-between gap-4 px-6 pt-6">
                    <div className="flex items-center gap-3">
                        {completed ? (
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-success/10">
                                <CheckCircle2 className="h-5 w-5 text-success" />
                            </span>
                        ) : (
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-warning/10">
                                <Loader2 className="h-5 w-5 animate-spin text-warning" />
                            </span>
                        )}
                        <div>
                            <h2 className="text-base font-semibold text-foreground">
                                {completed
                                    ? t("runProgressCompleted")
                                    : t("runProgressTitle")}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                {completed
                                    ? t("runProgressKeepOpen")
                                    : t("runProgressSubtitle")}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {!completed && (
                            <button
                                onClick={() => setMinimised(true)}
                                className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                                aria-label={t("runProgressMinimize")}
                                title={t("runProgressMinimize")}
                            >
                                <Minus className="h-4 w-4" />
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="rounded-md p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                            aria-label={t("runProgressClose")}
                            title={t("runProgressClose")}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="px-6 pt-5">
                    <div className="mb-2 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                            {t("runProgressOverall", {
                                done: counts.done,
                                total,
                            })}
                        </span>
                        <span className="font-medium text-foreground">
                            {percent}%
                        </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                                completed
                                    ? "bg-success"
                                    : "bg-warning"
                            }`}
                            style={{ width: `${percent}%` }}
                        />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-success">
                            <CheckCircle2 className="h-3 w-3" />
                            {t("runProgressDone", { count: counts.done })}
                        </span>
                        {counts.inProgress > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-warning">
                                <Loader2 className="h-3 w-3 animate-spin" />
                                {t("runProgressInProgress", {
                                    count: counts.inProgress,
                                })}
                            </span>
                        )}
                        {counts.failed > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
                                <AlertTriangle className="h-3 w-3" />
                                {t("runProgressFailed", {
                                    count: counts.failed,
                                })}
                            </span>
                        )}
                    </div>
                </div>

                {activeCells.length > 0 && !completed && (
                    <div className="mt-5 border-t border-border px-6 py-4">
                        <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {t("runProgressCurrent")}
                        </div>
                        <ul className="space-y-2">
                            {activeCells.map((cell) => (
                                <li
                                    key={cell.key}
                                    className="flex items-start gap-2 text-xs text-foreground"
                                >
                                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
                                    <div className="min-w-0">
                                        <div className="truncate font-medium text-foreground">
                                            {cell.docName}
                                        </div>
                                        <div className="truncate text-muted-foreground">
                                            {t("runProgressColumn")}:{" "}
                                            {cell.colLabel}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="flex justify-end gap-2 rounded-b-2xl bg-muted px-6 py-3">
                    <button
                        onClick={onClose}
                        className="rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-accent"
                    >
                        {t("runProgressClose")}
                    </button>
                </div>
            </div>
        </div>
    );
}
