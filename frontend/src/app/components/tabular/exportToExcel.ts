"use client";

import ExcelJS from "exceljs";
import type { ColumnConfig, MikeDocument, TabularCell } from "../shared/types";
import { preprocessCitations, unwrapNestedSummaryJson } from "./citation-utils";

function formatCellForExport(
    cell: TabularCell | undefined,
    errorLabel: string,
): string {
    if (!cell) return "";
    if (cell.status === "pending" || cell.status === "generating") return "";
    if (cell.status === "error") return errorLabel;
    const summary = unwrapNestedSummaryJson(cell.content?.summary ?? "");
    if (!summary) return "";
    const { processed } = preprocessCitations(summary);
    return processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Tabular Review"
    );
}

export async function exportTabularReviewToExcel(params: {
    reviewTitle: string;
    columns: ColumnConfig[];
    documents: MikeDocument[];
    cells: TabularCell[];
    /** Localized labels for the fixed export strings (issue #115). */
    labels?: {
        sheetName?: string;
        documentHeader?: string;
        errorCell?: string;
    };
}) {
    const { reviewTitle, columns, documents, cells, labels } = params;
    const sheetName = labels?.sheetName || "Review";
    const documentHeader = labels?.documentHeader || "Document";
    const errorCell = labels?.errorCell || "Error";

    const sortedCols = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map<string, TabularCell>();
    for (const c of cells) cellMap.set(`${c.document_id}:${c.column_index}`, c);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);

    ws.columns = [
        { header: documentHeader, width: 40 },
        ...sortedCols.map((c) => ({ header: c.name, width: 40 })),
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle" };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };

    for (const doc of documents) {
        const row: string[] = [doc.filename];
        for (const col of sortedCols) {
            row.push(
                formatCellForExport(
                    cellMap.get(`${doc.id}:${col.index}`),
                    errorCell,
                ),
            );
        }
        const excelRow = ws.addRow(row);
        excelRow.alignment = { vertical: "top", wrapText: true };
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(reviewTitle)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
