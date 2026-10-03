/**
 * "Download as Excel" for a markdown table in an assistant answer
 * (#46 phase 3 quick win). Frontend only, exceljs; loaded on first click so
 * exceljs stays out of the chat bundle.
 *
 * The rows come from the table's hast node (what react-markdown rendered,
 * PII already restored), so a document-citation pill (inline code `§N§`) is
 * left out and a legal-source link keeps its text.
 *
 * Values are typed only where it is obvious: a column becomes numbers,
 * EUR amounts, percentages or dates when EVERY non-empty cell in it reads
 * as one; anything else stays text. Strings are never written as formulas.
 */

import ExcelJS from "exceljs";

/** The slice of a hast node this module reads. */
export interface HastNode {
    type: string;
    tagName?: string;
    value?: string;
    children?: HastNode[];
}

const CITATION_PILL_RE = /^§\d+§$/;

function nodeText(node: HastNode): string {
    if (node.type === "text") return node.value ?? "";
    if (node.type !== "element" && node.type !== "root") return "";
    if (node.tagName === "br") return "\n";
    const text = (node.children ?? []).map(nodeText).join("");
    if (node.tagName === "code" && CITATION_PILL_RE.test(text.trim())) return "";
    return text;
}

function cellString(node: HastNode): string {
    return nodeText(node)
        .replace(/[ \t ]+/g, " ")
        .replace(/ ?\n ?/g, "\n")
        .trim();
}

/** The table's rows (header first) as plain cell strings. */
export function tableNodeToRows(table: HastNode): string[][] {
    const rows: string[][] = [];
    const walk = (node: HastNode) => {
        if (node.type === "element" && node.tagName === "tr") {
            rows.push(
                (node.children ?? [])
                    .filter(
                        (c) =>
                            c.type === "element" &&
                            (c.tagName === "th" || c.tagName === "td"),
                    )
                    .map(cellString),
            );
            return;
        }
        for (const child of node.children ?? []) walk(child);
    };
    walk(table);
    return rows;
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

export type ColumnKind = "text" | "number" | "currency" | "percent" | "date";

type Convention = "dot" | "comma";

interface NumberLike {
    value: number;
    kind: "number" | "currency" | "percent";
    /** Both "1.234" readings are valid (one separator, three digits). */
    ambiguous: { sep: "." | ","; grouping: number; decimal: number } | null;
    proves: Convention | null;
}

function readWith(body: string, dec: "." | ","): number | null {
    const d = dec === "." ? "\\." : ",";
    const g = dec === "." ? "," : "\\.";
    const m = new RegExp(
        `^(\\d+|[1-9]\\d{0,2}(?:${g}\\d{3})+)?(?:${d}(\\d+))?$`,
    ).exec(body);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    // "0123" is an identifier (OIB, account number), not 123.
    if (m[1] && /^0\d/.test(m[1])) return null;
    const int = (m[1] ?? "0").split(dec === "." ? "," : ".").join("");
    if ((int.replace(/^0+/, "") + (m[2] ?? "")).length > 15) return null;
    const value = Number(m[2] ? `${int}.${m[2]}` : int);
    return Number.isFinite(value) ? value : null;
}

/** A number, EUR amount or percentage in hr or en notation; null otherwise. */
export function parseNumberLike(raw: string): NumberLike | null {
    let s = raw.trim();
    let kind: NumberLike["kind"] = "number";
    if (/%$/.test(s)) {
        kind = "percent";
        s = s.slice(0, -1).trim();
    }
    const euro = /^(?:€|EUR)\s*|\s*(?:€|EUR)$/i;
    if (kind === "number" && euro.test(s)) {
        kind = "currency";
        s = s.replace(euro, "").trim();
    }
    let negative = false;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) {
        negative = true;
        s = paren[1].trim();
    }
    if (/^[-−]/.test(s)) {
        if (negative) return null;
        negative = true;
        s = s.slice(1).trim();
    } else if (s.startsWith("+")) {
        s = s.slice(1).trim();
    }
    const spaced = s.replace(/[\s  ']/g, " ");
    if (spaced.includes(" ")) {
        if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(spaced)) return null;
        s = spaced.replace(/ /g, "");
    }
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    // A long bare digit string is an identifier, not an amount.
    if (/^\d{12,}$/.test(s)) return null;

    const dot = readWith(s, ".");
    const comma = readWith(s, ",");
    if (dot === null && comma === null) return null;
    const sign = negative ? -1 : 1;
    const scale = kind === "percent" ? 1 / 100 : 1;
    const out = (v: number) => {
        const n = v * sign * scale;
        return n === 0 ? 0 : n;
    };
    if (dot !== null && comma !== null && dot !== comma) {
        // "1.234" / "1,234": settled by the column (see inferColumns).
        const grouping = s.includes(".") ? comma : dot;
        const decimal = s.includes(".") ? dot : comma;
        return {
            value: out(kind === "percent" ? decimal : grouping),
            kind,
            ambiguous: {
                sep: s.includes(".") ? "." : ",",
                grouping: out(grouping),
                decimal: out(decimal),
            },
            proves: null,
        };
    }
    const value = (dot ?? comma)!;
    const proves: Convention | null = /[.,]/.test(s)
        ? dot !== null && comma === null
            ? "dot"
            : comma !== null && dot === null
              ? "comma"
              : null
        : null;
    return { value: out(value), kind, ambiguous: null, proves };
}

/** ISO (2020-06-15) or Croatian (15. 6. 2020. / 15.06.2020) date, UTC midnight. */
export function parseDateLike(raw: string): Date | null {
    const s = raw.trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    let y: number, mo: number, d: number;
    if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
    else {
        m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?$/.exec(s);
        if (!m) return null;
        [y, mo, d] = [+m[3], +m[2], +m[1]];
    }
    if (y < 1900 || mo < 1 || mo > 12 || d < 1) return null;
    if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
    return new Date(Date.UTC(y, mo - 1, d));
}

export interface TypedColumn {
    kind: ColumnKind;
    /** One value per body row: number, Date, string or null (empty). */
    values: (number | Date | string | null)[];
}

/** Type each column of the body rows (header excluded). */
export function inferColumns(body: string[][], width: number): TypedColumn[] {
    const columns: TypedColumn[] = [];
    for (let c = 0; c < width; c++) {
        const raw = body.map((row) => row[c] ?? "");
        const filled = raw.filter((v) => v !== "");
        const asText: TypedColumn = {
            kind: "text",
            values: raw.map((v) => (v === "" ? null : v)),
        };
        if (filled.length === 0) {
            columns.push(asText);
            continue;
        }
        const dates = filled.map(parseDateLike);
        if (dates.every((d) => d !== null)) {
            columns.push({
                kind: "date",
                values: raw.map((v) => (v === "" ? null : parseDateLike(v))),
            });
            continue;
        }
        const nums = raw.map((v) => (v === "" ? null : parseNumberLike(v)));
        if (nums.some((n, i) => raw[i] !== "" && n === null)) {
            columns.push(asText);
            continue;
        }
        const kinds = new Set(nums.filter((n) => n).map((n) => n!.kind));
        if (kinds.has("percent") && kinds.size > 1) {
            columns.push(asText);
            continue;
        }
        const kind: ColumnKind = kinds.has("percent")
            ? "percent"
            : kinds.has("currency")
              ? "currency"
              : "number";
        const proven = new Set(nums.map((n) => n?.proves).filter(Boolean));
        const convention =
            proven.size === 1 ? ([...proven][0] as Convention) : null;
        columns.push({
            kind,
            values: nums.map((n) => {
                if (!n) return null;
                if (!n.ambiguous || !convention) return n.value;
                // "1.234": the column's convention says which separator
                // is the decimal one.
                const decimalSep = convention === "dot" ? "." : ",";
                return n.ambiguous.sep === decimalSep
                    ? n.ambiguous.decimal
                    : n.ambiguous.grouping;
            }),
        });
    }
    return columns;
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/** Same formats as the backend's generated workbooks (lib/xlsx/workbook). */
const FORMATS: Record<Exclude<ColumnKind, "text">, (values: TypedColumn["values"]) => string> = {
    number: (values) => {
        const nums = values.filter((v): v is number => typeof v === "number");
        if (!nums.every(Number.isInteger)) return "#,##0.00";
        // Years and counts read better as 2020 than 2,020.
        return nums.every((v) => Math.abs(v) < 10_000) ? "0" : "#,##0";
    },
    currency: () => '#,##0.00\\ "€"',
    percent: (values) =>
        values.every(
            (v) =>
                typeof v !== "number" ||
                Math.abs(v * 100 - Math.round(v * 100)) < 1e-9,
        )
            ? "0%"
            : "0.00%",
    date: () => "dd\\.mm\\.yyyy\\.",
};

/** An Excel-valid sheet name (no [ ] : * ? / \\, at most 31 characters). */
export function safeSheetName(name: string): string {
    const cleaned = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
    return Array.from(cleaned).slice(0, 31).join("").trim() || "Sheet1";
}

const XLSX_MIME =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A further sheet of the same workbook. */
export interface ExtraSheet {
    sheetName: string;
    rows: string[][];
}

/**
 * The table as an .xlsx: bold, frozen, filterable header row, typed
 * columns, wrapped text. `more` adds further sheets in the same style.
 */
export async function tableToXlsx(
    rows: string[][],
    sheetName: string,
    more: ExtraSheet[] = [],
): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Eulex Desk";
    addTableSheet(wb, rows, sheetName);
    for (const sheet of more) addTableSheet(wb, sheet.rows, sheet.sheetName);
    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

function addTableSheet(wb: ExcelJS.Workbook, rows: string[][], sheetName: string): void {
    const [header = [], ...body] = rows;
    const width = Math.max(header.length, ...body.map((r) => r.length), 1);
    const columns = inferColumns(body, width);

    let name = safeSheetName(sheetName);
    // Sheet names are unique per workbook (case-insensitive).
    for (let n = 2; wb.worksheets.some((w) => w.name.toLowerCase() === name.toLowerCase()); n++) {
        name = safeSheetName(`${Array.from(sheetName).slice(0, 27).join("")} (${n})`);
    }
    const ws = wb.addWorksheet(name, {
        views: [{ state: "frozen", ySplit: 1 }],
    });

    const headerRow = ws.addRow(
        Array.from({ length: width }, (_, c) => header[c] ?? ""),
    );
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", wrapText: true };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE7E6E6" }, // Excel file content, not app UI
    };

    body.forEach((_, r) => {
        const row = ws.addRow(columns.map((col) => col.values[r]));
        row.alignment = { vertical: "top", wrapText: true };
    });

    columns.forEach((col, c) => {
        const column = ws.getColumn(c + 1);
        if (col.kind !== "text") column.numFmt = FORMATS[col.kind](col.values);
        const longest = Math.max(
            ...[header[c] ?? "", ...body.map((row) => row[c] ?? "")].map((v) =>
                Math.max(0, ...v.split("\n").map((line) => line.length)),
            ),
        );
        column.width = Math.min(60, Math.max(10, longest + 2));
    });
    // The header keeps its own (General) format.
    headerRow.eachCell((cell) => {
        cell.numFmt = "General";
    });

    ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1 + body.length, column: width },
    };
}

/** Build the table's workbook and hand it to the browser as a download. */
export async function downloadTableAsXlsx(
    rows: string[][],
    names: { fileName: string; sheetName: string },
    more: ExtraSheet[] = [],
): Promise<void> {
    const buf = await tableToXlsx(rows, names.sheetName, more);
    const url = URL.createObjectURL(new Blob([buf], { type: XLSX_MIME }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${names.fileName}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
