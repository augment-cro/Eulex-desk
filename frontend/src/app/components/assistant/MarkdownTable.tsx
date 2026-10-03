"use client";

import { useState, type ComponentProps } from "react";
import { useTranslations } from "next-intl";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HastNode } from "./tableXlsx";

/**
 * A markdown table in an assistant answer, with "Download as Excel" under
 * it once the answer has finished streaming (#46 phase 3). The workbook is
 * built from the table's hast node by `tableXlsx`, which — with exceljs —
 * loads on the first click only.
 */
export function MarkdownTable({
    node,
    exportable,
    ...props
}: ComponentProps<"table"> & {
    /** react-markdown's hast node for this table. */
    node?: unknown;
    /** False while the answer streams (the table may be incomplete). */
    exportable: boolean;
}) {
    const t = useTranslations("assistant.tableExport");
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const download = async () => {
        if (busy || !node) return;
        setBusy(true);
        setFailed(false);
        try {
            const { downloadTableAsXlsx, tableNodeToRows } = await import(
                "./tableXlsx"
            );
            const rows = tableNodeToRows(node as HastNode);
            if (rows.length > 0) {
                await downloadTableAsXlsx(rows, {
                    fileName: t("fileName"),
                    sheetName: t("sheetName"),
                });
            }
        } catch (err) {
            console.error("[table-export] failed:", err);
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="my-4">
            <div className="overflow-x-auto">
                <table
                    className="min-w-full divide-y divide-border border border-border rounded-lg overflow-hidden"
                    {...props}
                />
            </div>
            {exportable && node ? (
                <div className="mt-1 flex items-center justify-end gap-2">
                    {failed && (
                        <span role="alert" className="text-xs text-destructive">
                            {t("failed")}
                        </span>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={download}
                        disabled={busy}
                        className="h-7 px-2 text-xs text-muted-foreground"
                    >
                        {busy ? (
                            <Loader2 className="animate-spin" aria-hidden="true" />
                        ) : (
                            <FileSpreadsheet aria-hidden="true" />
                        )}
                        {t("download")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
