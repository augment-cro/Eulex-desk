/**
 * Generated workbooks (generate_excel, #46 phase 3).
 *
 * Based on open-legal-products/mike a5fe6d6e `buildXlsxWorkbook` (hand-
 * written OOXML through JSZip, every cell an inline string; AGPL-3.0 on
 * both sides), extended with what the spec asks for:
 *   - typed columns (text, number, date, currency, percent) whose values
 *     become real Excel numbers (lib/xlsx/values.ts);
 *   - a fixed styles.xml: bold, filled, frozen header row with an
 *     autofilter, wrapped text, column widths, dd.mm.yyyy. dates,
 *     #,##0(.00) numbers, EUR amounts and percentages.
 *
 * Hand-written rather than SheetJS: SheetJS CE writes no cell styles, and
 * the styles are the point. Rather than exceljs: one small, deterministic
 * package we fully control, and the same JSZip + XML stack the Phase 4
 * patch engine uses.
 *
 * Never writes a formula. Every model string is an inline string, so text
 * starting with "=", "+", "-" or "@" stays text; such cells also carry
 * quotePrefix, which keeps them text when a user re-enters them in Excel.
 */

import JSZip from "jszip";
import {
    type ColumnType,
    type DecimalConvention,
    cellText,
    columnConvention,
    columnDayFirst,
    isColumnType,
    parseDate,
    parseNumber,
} from "./values";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const EXCEL_LIMITS = {
    maxSheets: 50,
    maxColumns: 200,
    maxRowsPerSheet: 10_000,
    /** Header cells included. */
    maxCells: 200_000,
} as const;

/** A request the tool refuses; the message is written for the model. */
export class WorkbookSpecError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkbookSpecError";
    }
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export interface ExcelColumnSpec {
    header: string;
    type: ColumnType;
    /** Width in characters; null = fitted to the content. */
    width: number | null;
}

export interface ExcelSheetSpec {
    name: string;
    /** The name as requested, when sanitising or de-duplicating changed it. */
    requestedName: string | null;
    columns: ExcelColumnSpec[];
    /** Raw cell values, one per column (short rows padded with null). */
    rows: unknown[][];
}

export interface ExcelWorkbookSpec {
    title: string;
    sheets: ExcelSheetSpec[];
    /** Problems fixed while normalising (unknown column types). */
    warnings: string[];
}

const SHEET_NAME_MAX = 31;

/** Cut to `max` UTF-16 units without splitting a code point. */
function cutUnits(s: string, max: number): string {
    let out = "";
    for (const ch of s) {
        if (out.length + ch.length > max) break;
        out += ch;
    }
    return out;
}

/**
 * An Excel-valid sheet name: no [ ] : * ? / \, no leading or trailing
 * apostrophe, at most 31 characters, not the reserved "History".
 */
export function sanitizeSheetName(raw: unknown, fallback: string): string {
    const text = cellText(typeof raw === "string" ? raw : "")?.text ?? "";
    let name = text
        .replace(/[[\]:*?/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^'+|'+$/g, "")
        .trim();
    name = cutUnits(name, SHEET_NAME_MAX).trim();
    if (!name) name = fallback;
    if (name.toLowerCase() === "history") name = `${name} (1)`;
    return name;
}

/** Make `name` unique (case-insensitively, as Excel compares) within `taken`. */
function uniqueSheetName(name: string, taken: Set<string>): string {
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
        const suffix = ` (${n})`;
        candidate = cutUnits(name, SHEET_NAME_MAX - suffix.length).trimEnd() + suffix;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
}

function asRecord(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Validate and normalise the tool arguments. Throws WorkbookSpecError with
 * a message the model can act on.
 */
export function normalizeWorkbookSpec(input: {
    title?: unknown;
    sheets?: unknown;
}): ExcelWorkbookSpec {
    const title =
        typeof input.title === "string" && input.title.trim()
            ? input.title.trim()
            : "workbook";
    const rawSheets = input.sheets;
    if (!Array.isArray(rawSheets) || rawSheets.length === 0) {
        throw new WorkbookSpecError(
            "The sheets array is empty or missing. Call generate_excel again with at least one sheet that has a name, columns ({header, type}) and rows.",
        );
    }
    if (rawSheets.length > EXCEL_LIMITS.maxSheets) {
        throw new WorkbookSpecError(
            `The workbook has ${rawSheets.length} sheets; the limit is ${EXCEL_LIMITS.maxSheets}. Combine sheets or split the data into several workbooks.`,
        );
    }

    const warnings: string[] = [];
    const taken = new Set<string>();
    let totalCells = 0;
    const sheets: ExcelSheetSpec[] = rawSheets.map((rawSheet, i) => {
        const sheet = asRecord(rawSheet);
        const label =
            typeof sheet?.name === "string" && sheet.name.trim()
                ? `"${sheet.name.trim()}"`
                : `${i + 1}`;
        if (!sheet) {
            throw new WorkbookSpecError(
                `Sheet ${label} is not an object with name, columns and rows.`,
            );
        }
        const rawColumns = sheet.columns;
        if (!Array.isArray(rawColumns) || rawColumns.length === 0) {
            throw new WorkbookSpecError(
                `Sheet ${label} has no columns. Every sheet needs at least one column {header, type}.`,
            );
        }
        if (rawColumns.length > EXCEL_LIMITS.maxColumns) {
            throw new WorkbookSpecError(
                `Sheet ${label} has ${rawColumns.length} columns; the limit is ${EXCEL_LIMITS.maxColumns}.`,
            );
        }
        const columns: ExcelColumnSpec[] = rawColumns.map((rawCol, c) => {
            const col = asRecord(rawCol);
            // A bare string is accepted as a text column header.
            const header =
                cellText(col ? col.header : rawCol)?.text.replace(/\n/g, " ") ?? "";
            let type: ColumnType = "text";
            if (col && col.type !== undefined) {
                if (isColumnType(col.type)) type = col.type;
                else
                    warnings.push(
                        `Sheet ${label}, column ${c + 1}: unknown type ${JSON.stringify(col.type)}, written as text.`,
                    );
            }
            const w = col?.width;
            const width =
                typeof w === "number" && Number.isFinite(w) && w > 0
                    ? Math.min(100, Math.max(4, w))
                    : null;
            return { header, type, width };
        });

        const rawRows = sheet.rows ?? [];
        if (!Array.isArray(rawRows)) {
            throw new WorkbookSpecError(
                `Sheet ${label}: rows must be an array of rows, each an array of cell values.`,
            );
        }
        if (rawRows.length > EXCEL_LIMITS.maxRowsPerSheet) {
            throw new WorkbookSpecError(
                `Sheet ${label} has ${fmt(rawRows.length)} rows; the limit is ${fmt(EXCEL_LIMITS.maxRowsPerSheet)} per sheet. Split the data across sheets or workbooks.`,
            );
        }
        const rows = rawRows.map((rawRow, r) => {
            if (!Array.isArray(rawRow)) {
                throw new WorkbookSpecError(
                    `Sheet ${label}, data row ${r + 1} is not an array of cell values.`,
                );
            }
            if (rawRow.length > columns.length) {
                throw new WorkbookSpecError(
                    `Sheet ${label}, data row ${r + 1} has ${rawRow.length} values but the sheet has ${columns.length} columns. Give each row exactly one value per column, in column order ("" for an empty cell).`,
                );
            }
            const row: unknown[] = rawRow.slice();
            while (row.length < columns.length) row.push(null);
            return row;
        });
        totalCells += (rows.length + 1) * columns.length;
        if (totalCells > EXCEL_LIMITS.maxCells) {
            throw new WorkbookSpecError(
                `The workbook is too large: more than ${fmt(EXCEL_LIMITS.maxCells)} cells. Reduce the data or split it into several workbooks.`,
            );
        }

        const requested = typeof sheet.name === "string" ? sheet.name : "";
        const name = uniqueSheetName(
            sanitizeSheetName(requested, `Sheet${i + 1}`),
            taken,
        );
        return {
            name,
            requestedName: name !== requested.trim() && requested.trim() ? requested.trim() : null,
            columns,
            rows,
        };
    });

    return { title, sheets, warnings };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/** cellXfs indices in STYLES_XML. */
export const STYLE = {
    header: 1,
    text: 2,
    textQuoted: 3,
    integer: 4,
    decimal: 5,
    date: 6,
    dateTime: 7,
    currency: 8,
    percentInteger: 9,
    percentDecimal: 10,
    integerPlain: 11,
} as const;

/** Number format codes (built-in ids 1, 3, 4, 9, 10; custom 164–166). */
export const NUMBER_FORMATS = {
    /** Small integers — years, counts — without a thousands separator. */
    integerPlain: "0",
    integer: "#,##0",
    decimal: "#,##0.00",
    date: "dd\\.mm\\.yyyy\\.",
    dateTime: "dd\\.mm\\.yyyy\\.\\ hh:mm",
    currency: '#,##0.00\\ "€"',
    percentInteger: "0%",
    percentDecimal: "0.00%",
} as const;

/**
 * Escape for XML text and double-quoted attributes. Apostrophes stay
 * literal, as Excel writes them (the viewer's regex parser does not decode
 * `&apos;` in sheet names).
 */
function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const TOP = '<alignment vertical="top"/>';
const TOP_WRAP = '<alignment vertical="top" wrapText="1"/>';

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="${xmlEscape(NUMBER_FORMATS.date)}"/><numFmt numFmtId="165" formatCode="${xmlEscape(NUMBER_FORMATS.dateTime)}"/><numFmt numFmtId="166" formatCode="${xmlEscape(NUMBER_FORMATS.currency)}"/></numFmts>
<fonts count="2"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF7F7F7F"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">${TOP_WRAP}</xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1" quotePrefix="1">${TOP_WRAP}</xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">${TOP}</xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

type Cell =
    | { kind: "text"; text: string; style: number }
    | { kind: "number"; value: number; style: number }
    | null;

/** Excel column letters for a 0-based index ("A", …, "Z", "AA", …). */
export function columnLetters(index: number): string {
    let s = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

/** Text that a spreadsheet would treat as a formula if typed in. */
const FORMULA_TRIGGER_RE = /^[=+\-@\t]/;

function textCell(text: string): Cell {
    return {
        kind: "text",
        text,
        style: FORMULA_TRIGGER_RE.test(text) ? STYLE.textQuoted : STYLE.text,
    };
}

interface TypedColumn {
    cells: Cell[];
    /** Data-row indices whose value was kept as text. */
    fallbacks: number[];
    /** Data-row indices cut to Excel's cell limit. */
    truncated: number[];
    /** Longest displayed text, for the automatic width. */
    contentWidth: number;
}

function longestLine(text: string): number {
    let max = 0;
    for (const line of text.split("\n")) max = Math.max(max, line.length);
    return max;
}

function typeColumn(type: ColumnType, values: unknown[]): TypedColumn {
    const fallbacks: number[] = [];
    const truncated: number[] = [];
    let contentWidth = 0;

    const asText = (raw: unknown, r: number): Cell => {
        const t = cellText(raw);
        if (!t) return null;
        if (t.truncated) truncated.push(r);
        contentWidth = Math.max(contentWidth, longestLine(t.text));
        return textCell(t.text);
    };
    const isBlank = (raw: unknown) => cellText(raw) === null || (typeof raw === "string" && raw.trim() === "");

    if (type === "text") {
        return { cells: values.map(asText), fallbacks, truncated, contentWidth };
    }

    if (type === "date") {
        const dayFirst = columnDayFirst(values);
        const cells = values.map((raw, r): Cell => {
            if (isBlank(raw)) return null;
            const d = parseDate(raw, dayFirst);
            if (!d) {
                fallbacks.push(r);
                return asText(raw, r);
            }
            contentWidth = Math.max(contentWidth, d.hasTime ? 17 : 11);
            return {
                kind: "number",
                value: d.serial,
                style: d.hasTime ? STYLE.dateTime : STYLE.date,
            };
        });
        return { cells, fallbacks, truncated, contentWidth };
    }

    const convention: DecimalConvention | null = columnConvention(values);
    const parsed = values.map((raw) =>
        isBlank(raw) ? undefined : parseNumber(raw, type, convention),
    );
    const numbers = parsed.filter(
        (p): p is { value: number } => p !== undefined && p !== null,
    );
    let numberStyle: number;
    if (type === "currency") numberStyle = STYLE.currency;
    else if (type === "percent")
        numberStyle = numbers.every(
            (p) => Math.abs(p.value * 100 - Math.round(p.value * 100)) < 1e-9,
        )
            ? STYLE.percentInteger
            : STYLE.percentDecimal;
    else if (!numbers.every((p) => Number.isInteger(p.value)))
        numberStyle = STYLE.decimal;
    else
        // Years and counts read better as 2020 than 2,020.
        numberStyle = numbers.every((p) => Math.abs(p.value) < 10_000)
            ? STYLE.integerPlain
            : STYLE.integer;

    const cells = values.map((raw, r): Cell => {
        const p = parsed[r];
        if (p === undefined) return null;
        if (p === null) {
            fallbacks.push(r);
            return asText(raw, r);
        }
        // Rough display width: digits + grouping + decimals + symbol.
        const digits = String(Math.trunc(Math.abs(type === "percent" ? p.value * 100 : p.value))).length;
        contentWidth = Math.max(contentWidth, digits + Math.floor((digits - 1) / 3) + 5);
        return { kind: "number", value: p.value, style: numberStyle };
    });
    return { cells, fallbacks, truncated, contentWidth };
}

function columnWidth(col: ExcelColumnSpec, typed: TypedColumn): number {
    if (col.width !== null) return col.width;
    const header = Math.min(30, longestLine(col.header));
    const minimum = col.type === "text" ? 8 : 10;
    return Math.min(60, Math.max(minimum, header + 2, typed.contentWidth + 2));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Excel's shortest round-trip representation of a number. */
function numberXml(value: number): string {
    return String(value);
}

function cellXml(ref: string, cell: Cell): string {
    if (!cell) return "";
    if (cell.kind === "number")
        return `<c r="${ref}" s="${cell.style}"><v>${numberXml(cell.value)}</v></c>`;
    return `<c r="${ref}" s="${cell.style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.text)}</t></is></c>`;
}

/** A sheet name quoted for a reference ('Q3 Budget'!$A$1). */
function quotedSheetRef(name: string): string {
    return `'${name.replace(/'/g, "''")}'`;
}

export interface WorkbookReport {
    sheets: {
        name: string;
        requested_name?: string;
        columns: number;
        rows: number;
    }[];
    /** Problems the model should know about (values kept as text, …). */
    warnings: string[];
}

const MAX_LISTED_REFS = 10;

function listRefs(refs: string[]): string {
    const shown = refs.slice(0, MAX_LISTED_REFS).join(", ");
    return refs.length > MAX_LISTED_REFS
        ? `${shown} and ${refs.length - MAX_LISTED_REFS} more`
        : shown;
}

const TYPE_NOUN: Record<ColumnType, string> = {
    text: "text",
    number: "numbers",
    date: "dates",
    currency: "amounts",
    percent: "percentages",
};

function sheetXml(
    sheet: ExcelSheetSpec,
    index: number,
    warnings: string[],
): { xml: string; lastRef: string } {
    const typed = sheet.columns.map((col, c) =>
        typeColumn(
            col.type,
            sheet.rows.map((row) => row[c]),
        ),
    );
    const letters = sheet.columns.map((_, c) => columnLetters(c));

    typed.forEach((col, c) => {
        const spec = sheet.columns[c];
        const at = (r: number) => `${letters[c]}${r + 2}`;
        if (col.fallbacks.length > 0) {
            warnings.push(
                `Sheet "${sheet.name}", column "${spec.header}" (${spec.type}): ${col.fallbacks.length} value(s) could not be read as ${TYPE_NOUN[spec.type]} and were kept as text: ${listRefs(col.fallbacks.map(at))}.`,
            );
        }
        if (col.truncated.length > 0) {
            warnings.push(
                `Sheet "${sheet.name}", column "${spec.header}": ${col.truncated.length} value(s) were cut to Excel's 32,767-character cell limit: ${listRefs(col.truncated.map(at))}.`,
            );
        }
    });

    const lastCol = letters[letters.length - 1];
    const lastRow = sheet.rows.length + 1;
    const lastRef = `${lastCol}${lastRow}`;

    const header = `<row r="1">${sheet.columns
        .map((col, c) =>
            cellXml(`${letters[c]}1`, {
                kind: "text",
                text: col.header,
                style: STYLE.header,
            }),
        )
        .join("")}</row>`;
    const body = sheet.rows
        .map((_, r) => {
            const cells = typed
                .map((col, c) => cellXml(`${letters[c]}${r + 2}`, col.cells[r]))
                .join("");
            return `<row r="${r + 2}">${cells}</row>`;
        })
        .join("");
    const cols = sheet.columns
        .map(
            (col, c) =>
                `<col min="${c + 1}" max="${c + 1}" width="${columnWidth(col, typed[c]).toFixed(2)}" customWidth="1"/>`,
        )
        .join("");

    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastRef}"/>
<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${header}${body}</sheetData>
<autoFilter ref="A1:${lastRef}"/>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
    return { xml, lastRef };
}

/**
 * Write the workbook. The report lists each sheet and every value that
 * could not be typed as its column asks (kept as text).
 */
export async function buildXlsxWorkbook(
    spec: ExcelWorkbookSpec,
    options: { now?: Date } = {},
): Promise<{ bytes: Buffer; report: WorkbookReport }> {
    const zip = new JSZip();
    const add = (path: string, content: string) =>
        zip.file(path, content, { createFolders: false });
    const warnings = [...spec.warnings];
    const n = spec.sheets.length;
    const now = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");

    add(
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${spec.sheets
    .map(
        (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("\n")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
    );
    add(
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    );
    add(
        "docProps/core.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(cellText(spec.title)?.text ?? "")}</dc:title>
<dc:creator>Eulex Desk</dc:creator>
<cp:lastModifiedBy>Eulex Desk</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`,
    );
    add(
        "docProps/app.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Eulex Desk</Application>
</Properties>`,
    );

    const filterNames: string[] = [];
    spec.sheets.forEach((sheet, i) => {
        const { xml, lastRef } = sheetXml(sheet, i, warnings);
        add(`xl/worksheets/sheet${i + 1}.xml`, xml);
        const [, col, row] = /^([A-Z]+)(\d+)$/.exec(lastRef)!;
        filterNames.push(
            `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(
                `${quotedSheetRef(sheet.name)}!$A$1:$${col}$${row}`,
            )}</definedName>`,
        );
    });

    add(
        "xl/workbook.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>${spec.sheets
            .map(
                (sheet, i) =>
                    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
            )
            .join("")}</sheets>
<definedNames>${filterNames.join("")}</definedNames>
</workbook>`,
    );
    add(
        "xl/_rels/workbook.xml.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${spec.sheets
    .map(
        (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("\n")}
<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    );
    add("xl/styles.xml", STYLES_XML);

    const bytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });

    return {
        bytes,
        report: {
            sheets: spec.sheets.map((s) => ({
                name: s.name,
                ...(s.requestedName ? { requested_name: s.requestedName } : {}),
                columns: s.columns.length,
                rows: s.rows.length,
            })),
            warnings,
        },
    };
}
