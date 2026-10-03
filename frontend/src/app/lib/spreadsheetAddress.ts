/**
 * A1 cell-address helpers shared by the spreadsheet viewer and every place
 * that shows a spreadsheet citation (`Ugovori!C2`, `'Q3 Budget'!A1:B2`).
 *
 * The parsing helpers are ported from open-legal-products/mike
 * 9014da5355de40b92eeedaa6e8c0b384d89243e0
 * frontend/src/app/components/shared/views/SpreadsheetView.tsx
 * (columnLettersToIndex / parseA1 / parseRange); absolute references
 * (`$B$7`) are accepted here as well.
 */

/** 0-based, inclusive row/column spans of an A1 address or range. */
export type CellRange = { row: [number, number]; column: [number, number] };

/** "A" -> 0, "B" -> 1, "AA" -> 26 (0-based column index). */
export function columnLettersToIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}

/** Parse an A1 address like "B7" (or "$B$7") into 0-based { r, c }. */
export function parseA1(cell: string): { r: number; c: number } | null {
    const m = cell.trim().match(/^\$?([A-Za-z]{1,3})\$?(\d+)$/);
    if (!m) return null;
    const c = columnLettersToIndex(m[1]);
    const r = Number.parseInt(m[2], 10) - 1;
    if (c < 0 || r < 0) return null;
    return { r, c };
}

/** Parse an A1 address or range ("B7" or "B7:C9") into 0-based spans. */
export function parseA1Range(range: string): CellRange | null {
    const [startRaw, endRaw, ...rest] = range.split(":");
    if (rest.length > 0) return null;
    const start = parseA1(startRaw ?? "");
    if (!start) return null;
    const end = endRaw !== undefined ? parseA1(endRaw) : start;
    if (!end) return null;
    return {
        row: [Math.min(start.r, end.r), Math.max(start.r, end.r)],
        column: [Math.min(start.c, end.c), Math.max(start.c, end.c)],
    };
}

/**
 * Excel-style reference for display: `Ugovori!C2`. Sheet names that are
 * not a plain identifier are quoted the way Excel writes them
 * (`'Q3 Budget'!B7`, an inner `'` doubled).
 */
export function formatSheetCell(
    sheet: string | null | undefined,
    cell: string | null | undefined,
): string {
    const s = sheet?.trim() ?? "";
    const c = cell?.trim().toUpperCase() ?? "";
    if (!s) return c;
    const name = /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(s)
        ? s
        : `'${s.replaceAll("'", "''")}'`;
    return c ? `${name}!${c}` : name;
}
