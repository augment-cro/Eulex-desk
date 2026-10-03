/**
 * Spreadsheet reading — xlsx / xlsm / xls / csv → cell-addressed text.
 *
 * Ported from open-legal-products/mike a5fe6d6e backend/src/lib/spreadsheet.ts
 * (rendering refined upstream in 82dcaefc). AGPL-3.0 on both sides.
 *
 * Upstream's format, one markdown table per sheet with a `Row` column and
 * column letters, so the model can name any cell as `Sheet!C2` and cite it:
 *
 *   ## Sheet: Ugovori
 *   Hidden rows: 17, 18 · Comments: C15 "Provjeriti s klijentom"
 *
 *   | Row | A | B | C |
 *   | --- | --- | --- | --- |
 *   | 1 | Ugovorna strana | Datum | Iznos (EUR) |
 *   | 214 | Ukupno ⟨merged A214:B214⟩ |  | 18,402,113.50 |
 *
 * - Values are what Excel shows (`cell.w`), never raw serials. Formulas are
 *   never evaluated: only the cached result the file carries is shown.
 * - A merged range's anchor carries the `⟨merged …⟩` tag; covered cells are
 *   blank. Empty rows and columns are trimmed; the header keeps the letters.
 * - Our additions: hidden sheets, rows and columns are MARKED, not dropped
 *   (a hidden row in a cap table is a finding), and cell comments are
 *   listed per sheet.
 *
 * The same text serves the plain and markdown flavours (no `[Page N]`
 * markers). Long workbooks are split between rows, repeating the sheet
 * heading and the column-letter header in every part.
 *
 * Limits: a zip whose content inflates beyond ~200 MB is rejected before
 * SheetJS sees it (SheetJS inflates every entry eagerly and ignores the
 * declared sizes), and a workbook above ~2M cells is refused.
 *
 * SheetJS CE is vendored (backend/vendor/xlsx-0.20.3.tgz) — never install
 * the stale npm-registry `xlsx`.
 */

import zlib from "zlib";
import type { CellObject, Range, WorkBook, WorkSheet } from "xlsx";

type SheetJs = typeof import("xlsx");

let sheetjs: SheetJs | null = null;

/** SheetJS, loaded on first use — most requests never touch a spreadsheet. */
function xlsx(): SheetJs {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (!sheetjs) sheetjs = require("xlsx") as SheetJs;
    return sheetjs;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Total inflated size a spreadsheet zip may reach (zip-bomb guard). */
export const SPREADSHEET_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
/** Cells a workbook may hold (Cloud Run parses it in the API process). */
export const SPREADSHEET_MAX_CELLS = 2_000_000;

export interface SpreadsheetLimits {
    maxUncompressedBytes: number;
    maxCells: number;
}

const DEFAULT_LIMITS: SpreadsheetLimits = {
    maxUncompressedBytes: SPREADSHEET_MAX_UNCOMPRESSED_BYTES,
    maxCells: SPREADSHEET_MAX_CELLS,
};

/** A spreadsheet that is too big to parse safely. */
export class SpreadsheetLimitError extends Error {
    readonly code = "spreadsheet_too_large";

    constructor(message: string) {
        super(message);
        this.name = "SpreadsheetLimitError";
    }
}

// ---------------------------------------------------------------------------
// Containers: zip directory walk, zip-bomb guard, OLE streams
// ---------------------------------------------------------------------------

interface ZipEntry {
    name: string;
    method: number;
    /** Offset of the entry's data, right after its local header. */
    dataStart: number;
    /** Stored bytes of an uncompressed (method 0) entry. */
    storedSize: number;
    /** Uncompressed size as declared by the headers — may lie. */
    declaredSize: number;
}

function isZip(buf: Buffer): boolean {
    return (
        buf.length >= 4 &&
        buf[0] === 0x50 &&
        buf[1] === 0x4b &&
        buf[2] === 0x03 &&
        buf[3] === 0x04
    );
}

/** Zip64 sizes from an extra field (header id 0x0001). */
function zip64Sizes(
    buf: Buffer,
    start: number,
    length: number,
): { usz?: number; csz?: number } {
    let p = start;
    const end = Math.min(start + length, buf.length);
    while (p + 4 <= end) {
        const id = buf.readUInt16LE(p);
        const size = buf.readUInt16LE(p + 2);
        if (id === 0x0001) {
            const out: { usz?: number; csz?: number } = {};
            if (size >= 8 && p + 12 <= end)
                out.usz = Number(buf.readBigUInt64LE(p + 4));
            if (size >= 16 && p + 20 <= end)
                out.csz = Number(buf.readBigUInt64LE(p + 12));
            return out;
        }
        p += 4 + size;
    }
    return {};
}

/**
 * Walk a zip's central directory the way SheetJS's reader does (last
 * end-of-central-directory record, then each entry's LOCAL header for the
 * method and data offset), so the guard checks exactly what SheetJS will
 * inflate. Throws on a directory that does not parse.
 */
function zipEntries(buf: Buffer): ZipEntry[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (
            buf[i] === 0x50 &&
            buf[i + 1] === 0x4b &&
            buf[i + 2] === 0x05 &&
            buf[i + 3] === 0x06
        ) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("Corrupt zip: no central directory");
    const count = buf.readUInt16LE(eocd + 8);
    let p = buf.readUInt32LE(eocd + 16);
    const entries: ZipEntry[] = [];
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50)
            throw new Error("Corrupt zip: bad central directory entry");
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf
            .toString("latin1", p + 46, p + 46 + nameLen)
            .replace(/\\/g, "/");
        const cd64 = zip64Sizes(buf, p + 46 + nameLen, extraLen);

        if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50)
            throw new Error("Corrupt zip: bad local header");
        const method = buf.readUInt16LE(offset + 8);
        const localNameLen = buf.readUInt16LE(offset + 26);
        const localExtraLen = buf.readUInt16LE(offset + 28);
        const local64 = zip64Sizes(
            buf,
            offset + 30 + localNameLen,
            localExtraLen,
        );
        const csz =
            cd64.csz ?? local64.csz ?? buf.readUInt32LE(offset + 18);
        const usz =
            cd64.usz ?? local64.usz ?? buf.readUInt32LE(offset + 22);
        entries.push({
            name,
            method,
            dataStart: offset + 30 + localNameLen + localExtraLen,
            storedSize: csz,
            declaredSize: usz,
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * Inflate a raw-deflate stream only to count its output, stopping as soon
 * as it passes `cap`. Streaming, so memory stays flat whatever the size.
 */
function inflatedSize(data: Buffer, cap: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const inflate = zlib.createInflateRaw();
        let total = 0;
        let settled = false;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            inflate.destroy();
            reject(err);
        };
        inflate.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > cap)
                fail(
                    new SpreadsheetLimitError(
                        "Spreadsheet too large: its content inflates beyond the size limit",
                    ),
                );
        });
        inflate.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(total);
        });
        inflate.on("error", (err) =>
            fail(new Error(`Corrupt zip entry: ${err.message}`)),
        );
        // SheetJS inflates from the entry's data to the end of the deflate
        // stream, ignoring the declared sizes — do the same.
        inflate.end(data);
    });
}

/**
 * Zip-bomb guard: reject a zip whose entries inflate beyond the limit.
 * The declared sizes give a fast reject; the real check inflates every
 * entry (natively, streaming, counting only), because headers can lie and
 * SheetJS never bounds its own inflation.
 */
export async function assertZipWithinLimits(
    buf: Buffer,
    maxUncompressedBytes: number = SPREADSHEET_MAX_UNCOMPRESSED_BYTES,
): Promise<void> {
    const entries = zipEntries(buf);
    const tooLarge = () =>
        new SpreadsheetLimitError(
            `Spreadsheet too large: more than ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB uncompressed`,
        );
    let declared = 0;
    for (const e of entries) {
        declared += e.declaredSize;
        if (declared > maxUncompressedBytes) throw tooLarge();
    }
    let total = 0;
    for (const e of entries) {
        if (e.dataStart > buf.length) throw new Error("Corrupt zip: entry out of range");
        if (e.method === 0) {
            total += Math.min(e.storedSize, buf.length - e.dataStart);
        } else if (e.method === 8) {
            try {
                total += await inflatedSize(
                    buf.subarray(e.dataStart),
                    maxUncompressedBytes - total,
                );
            } catch (err) {
                if (err instanceof SpreadsheetLimitError) throw tooLarge();
                throw err;
            }
        }
        if (total > maxUncompressedBytes) throw tooLarge();
    }
}

/**
 * What a zip holds, from its entry names: an Excel workbook (`xl/workbook.*`),
 * a Word document (`word/…`) or something else. Never inflates anything.
 */
export function zipPackageKind(buf: Buffer): "xlsx" | "docx" | "zip" {
    let names: string[];
    try {
        names = zipEntries(buf).map((e) => e.name);
    } catch {
        return "zip";
    }
    if (names.some((n) => /^xl\/workbook\.[a-z]+$/i.test(n))) return "xlsx";
    if (names.some((n) => /^word\//i.test(n))) return "docx";
    return "zip";
}

/**
 * What an OLE (CFB) file holds, from its TOP-LEVEL streams only — an
 * embedded workbook inside a Word document lives in a sub-storage and must
 * not turn the .doc into a spreadsheet. An Outlook .msg keeps its message
 * properties in a top-level `__properties_version1.0` stream and
 * `__substg1.0_<tag>` streams ([MS-OXMSG] 2.1).
 */
export function oleKind(buf: Buffer): "doc" | "xls" | "msg" | "ole" {
    let paths: string[];
    try {
        const cfb = xlsx().CFB.read(buf, { type: "buffer" }) as {
            FullPaths: string[];
        };
        paths = cfb.FullPaths.map((p) => p.toUpperCase());
    } catch {
        return "ole";
    }
    const root = paths[0] ?? "";
    const top = new Set(
        paths
            .filter((p) => p.startsWith(root) && p !== root)
            .map((p) => p.slice(root.length))
            .filter((p) => !p.includes("/")),
    );
    if (top.has("WORDDOCUMENT")) return "doc";
    if (top.has("WORKBOOK") || top.has("BOOK")) return "xls";
    if (
        top.has("__PROPERTIES_VERSION1.0") ||
        [...top].some((p) => p.startsWith("__SUBSTG1.0_"))
    )
        return "msg";
    return "ole";
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_DELIMITERS = ["\t", ";", ","] as const;
type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** Delimiter occurrences per line, outside double-quoted fields. */
function countOutsideQuotes(line: string, delim: string): number {
    let n = 0;
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === delim && !inQuotes) n++;
    }
    return n;
}

/**
 * Pick the delimiter (`,` `;` or tab) that splits the first lines most
 * consistently. Ties go to tab, then `;` — in Croatian CSVs the comma is
 * the decimal separator, so a `;` file also counts commas in its amounts.
 */
export function sniffCsvDelimiter(text: string): CsvDelimiter {
    const sep = /^sep=(.)\r?\n/.exec(text);
    if (sep && (CSV_DELIMITERS as readonly string[]).includes(sep[1]))
        return sep[1] as CsvDelimiter;
    const lines = text
        .slice(0, 64 * 1024)
        .split(/\r\n|\n|\r/)
        .filter((l) => l.trim())
        .slice(0, 20);
    let best: CsvDelimiter = ",";
    let bestScore = 0;
    for (const delim of CSV_DELIMITERS) {
        const counts = lines.map((l) => countOutsideQuotes(l, delim));
        if (!counts.length || counts[0] === 0) continue;
        const score = counts.filter((c) => c === counts[0]).length;
        if (score > bestScore) {
            best = delim;
            bestScore = score;
        }
    }
    return best;
}

/**
 * Parse delimited text (RFC 4180 quoting) into rows of strings. Every value
 * stays text — nothing is coerced to a number, date or formula, so the text,
 * the viewer and quote verification all show the file's own characters.
 */
export function parseCsv(
    text: string,
    maxCells: number = SPREADSHEET_MAX_CELLS,
): string[][] {
    let body = text;
    let delim: CsvDelimiter;
    const sep = /^sep=(.)\r?\n/.exec(body);
    if (sep && (CSV_DELIMITERS as readonly string[]).includes(sep[1])) {
        delim = sep[1] as CsvDelimiter;
        body = body.slice(sep[0].length);
    } else {
        delim = sniffCsvDelimiter(body);
    }

    const rows: string[][] = [];
    let row: string[] = [];
    let cells = 0;
    let i = 0;
    const n = body.length;
    const pushField = (value: string) => {
        row.push(value);
        if (++cells > maxCells)
            throw new SpreadsheetLimitError(
                `Spreadsheet too large: more than ${maxCells} cells`,
            );
    };
    while (i < n) {
        let value: string;
        if (body[i] === '"') {
            // Quoted field: "" is an escaped quote; the field ends at the
            // closing quote (anything up to the delimiter is kept verbatim).
            let out = "";
            let j = i + 1;
            for (;;) {
                const q = body.indexOf('"', j);
                if (q === -1) {
                    out += body.slice(j);
                    j = n;
                    break;
                }
                out += body.slice(j, q);
                if (body[q + 1] === '"') {
                    out += '"';
                    j = q + 2;
                } else {
                    j = q + 1;
                    break;
                }
            }
            let k = j;
            while (k < n && body[k] !== delim && body[k] !== "\n" && body[k] !== "\r")
                k++;
            value = out + body.slice(j, k);
            i = k;
        } else {
            let k = i;
            while (k < n && body[k] !== delim && body[k] !== "\n" && body[k] !== "\r")
                k++;
            value = body.slice(i, k);
            i = k;
        }
        pushField(value);
        if (i >= n) break;
        if (body[i] === delim) {
            i++;
            if (i >= n) pushField("");
            continue;
        }
        // Line break (\r\n, \n or \r) ends the row.
        if (body[i] === "\r" && body[i + 1] === "\n") i += 2;
        else i++;
        rows.push(row);
        row = [];
    }
    if (row.length) rows.push(row);
    // Drop trailing blank lines.
    while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
    return rows;
}

// ---------------------------------------------------------------------------
// Reading a workbook
// ---------------------------------------------------------------------------

/**
 * What to read: workbook bytes (xlsx/xlsm/xls — SheetJS detects the
 * container) or decoded CSV text.
 */
export type SpreadsheetInput =
    | { kind: "workbook"; bytes: Buffer }
    | { kind: "csv"; text: string };

/** The name a CSV's single sheet gets — in the text AND the viewer copy. */
export const CSV_SHEET_NAME = "Sheet1";

function forEachCell(
    ws: WorkSheet,
    fn: (r: number, c: number, cell: CellObject) => void,
): void {
    const dense = (ws as { "!data"?: (CellObject | null)[][] })["!data"];
    if (dense) {
        // forEach skips the holes of SheetJS's sparse row arrays, so the
        // work is bounded by the cells that exist, never by `!ref`.
        dense.forEach((row, r) => {
            row?.forEach((cell, c) => {
                if (cell) fn(r, c, cell);
            });
        });
        return;
    }
    const XLSX = xlsx();
    for (const key of Object.keys(ws)) {
        if (key.startsWith("!")) continue;
        const { r, c } = XLSX.utils.decode_cell(key);
        fn(r, c, ws[key] as CellObject);
    }
}

function countCells(wb: WorkBook): number {
    let n = 0;
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (ws) forEachCell(ws, () => n++);
    }
    return n;
}

async function readWorkbook(
    input: SpreadsheetInput,
    limits: SpreadsheetLimits,
    opts: { sheetNamesOnly?: boolean } = {},
): Promise<WorkBook> {
    const XLSX = xlsx();
    let wb: WorkBook;
    if (input.kind === "csv") {
        const rows = parseCsv(input.text, limits.maxCells).map((row) =>
            row.map((v) => (v === "" ? null : v)),
        );
        wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet(rows, { dense: true }),
            CSV_SHEET_NAME,
        );
        return wb;
    }
    if (isZip(input.bytes))
        await assertZipWithinLimits(input.bytes, limits.maxUncompressedBytes);
    wb = XLSX.read(input.bytes, {
        type: "buffer",
        dense: true,
        // Row/column visibility and number formats live with the styles.
        cellStyles: true,
        cellNF: true,
        // Cached values only — formulas are never read, let alone evaluated.
        cellFormula: false,
        cellHTML: false,
        bookVBA: false,
        bookSheets: opts.sheetNamesOnly ?? false,
    });
    if (!opts.sheetNamesOnly) {
        const cells = countCells(wb);
        if (cells > limits.maxCells)
            throw new SpreadsheetLimitError(
                `Spreadsheet too large: ${cells} cells, the limit is ${limits.maxCells}`,
            );
    }
    return wb;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Escape a cell value so it can't break the markdown table layout. */
function sanitizeCellText(value: string): string {
    return value
        .replace(/\r\n|\r|\n/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
}

/**
 * Formatted display text for a cell (`w`). SheetJS leaves `w` unset when
 * its formatter rejects a number format — typically a Croatian date format
 * with unescaped dots (`dd.mm.yyyy.`), which Excel accepts — so retry a
 * date format with the dots escaped before falling back to the raw value.
 */
function cellDisplayText(cell: CellObject, date1904: boolean): string {
    if (typeof cell.w === "string" && cell.w.length > 0) return cell.w;
    if (cell.v == null) return "";
    if (cell.t === "n" && typeof cell.z === "string") {
        try {
            const SSF = xlsx().SSF;
            if (SSF.is_date(cell.z)) {
                const escaped = cell.z.replace(/\\.|\./g, (m: string) =>
                    m === "." ? "\\." : m,
                );
                return String(SSF.format(escaped, cell.v, { date1904 }));
            }
        } catch {
            /* fall through to the raw value */
        }
    }
    if (cell.t === "b") return cell.v ? "TRUE" : "FALSE";
    return String(cell.v);
}

/** Comment text of a cell, threaded replies preferred over the legacy note. */
function cellCommentText(cell: CellObject): string {
    const comments = (cell.c ?? []) as { t?: string; T?: boolean }[];
    if (!comments.length) return "";
    const threaded = comments.filter((c) => c.T);
    return (threaded.length ? threaded : comments)
        .map((c) => (c.t ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" / ");
}

/** "17, 18, 20-25" — runs of three or more collapse into a range. */
function formatRowList(rows: number[]): string {
    const out: string[] = [];
    for (let i = 0; i < rows.length; ) {
        let j = i;
        while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
        if (j - i >= 2) out.push(`${rows[i]}-${rows[j]}`);
        else for (let k = i; k <= j; k++) out.push(String(rows[k]));
        i = j + 1;
    }
    return out.join(", ");
}

/** Upper bound on covered-cell bookkeeping for merged ranges. */
const MAX_MERGE_ROW_SPAN = 2_000_000;

function renderSheet(
    sheetName: string,
    ws: WorkSheet,
    hidden: boolean,
    date1904: boolean,
): string {
    const XLSX = xlsx();
    const heading = `## Sheet: ${sheetName}${hidden ? " (hidden)" : ""}`;

    // Merged ranges: the anchor gets the tag, covered cells stay blank.
    const anchors = new Map<string, string>();
    const coveredByRow = new Map<number, [number, number, number][]>();
    let span = 0;
    let lastRow = -1;
    forEachCell(ws, (r) => {
        if (r > lastRow) lastRow = r;
    });
    for (const m of (ws["!merges"] ?? []) as Range[]) {
        anchors.set(XLSX.utils.encode_cell(m.s), XLSX.utils.encode_range(m));
        if (m.s.r > lastRow) continue;
        const end = Math.min(m.e.r, lastRow);
        span += end - m.s.r + 1;
        if (span > MAX_MERGE_ROW_SPAN) continue;
        for (let r = m.s.r; r <= end; r++) {
            let list = coveredByRow.get(r);
            if (!list) coveredByRow.set(r, (list = []));
            list.push([m.s.c, m.e.c, m.s.r === r ? m.s.c : -1]);
        }
    }
    const isCovered = (r: number, c: number): boolean =>
        (coveredByRow.get(r) ?? []).some(
            ([from, to, anchorCol]) => c >= from && c <= to && c !== anchorCol,
        );

    // One pass for the grid: text per cell, the rows and columns that carry
    // content, and the comments.
    const rows = new Map<number, Map<number, string>>();
    const usedCols = new Set<number>();
    const comments: { r: number; c: number; text: string }[] = [];
    const put = (r: number, c: number, text: string) => {
        let row = rows.get(r);
        if (!row) rows.set(r, (row = new Map()));
        row.set(c, text);
        usedCols.add(c);
    };
    forEachCell(ws, (r, c, cell) => {
        const note = cellCommentText(cell);
        if (note) comments.push({ r, c, text: note });
        if (isCovered(r, c)) return;
        const text = sanitizeCellText(cellDisplayText(cell, date1904));
        if (text) put(r, c, text);
    });
    for (const [addr, range] of anchors) {
        const { r, c } = XLSX.utils.decode_cell(addr);
        const text = rows.get(r)?.get(c);
        put(r, c, text ? `${text} ⟨merged ${range}⟩` : `⟨merged ${range}⟩`);
    }

    const rowNumbers = [...rows.keys()].sort((a, b) => a - b);
    const cols = [...usedCols].sort((a, b) => a - b);

    const meta: string[] = [];
    const rowProps = (ws["!rows"] ?? []) as ({ hidden?: boolean } | undefined)[];
    const colProps = (ws["!cols"] ?? []) as ({ hidden?: boolean } | undefined)[];
    const hiddenRows = rowNumbers.filter((r) => rowProps[r]?.hidden);
    if (hiddenRows.length)
        meta.push(`Hidden rows: ${formatRowList(hiddenRows.map((r) => r + 1))}`);
    const hiddenCols = cols.filter((c) => colProps[c]?.hidden);
    if (hiddenCols.length)
        meta.push(
            `Hidden columns: ${hiddenCols.map((c) => XLSX.utils.encode_col(c)).join(", ")}`,
        );
    if (comments.length) {
        comments.sort((a, b) => a.r - b.r || a.c - b.c);
        meta.push(
            `Comments: ${comments
                .map((n) => `${XLSX.utils.encode_cell({ r: n.r, c: n.c })} "${n.text}"`)
                .join("; ")}`,
        );
    }

    const lines = [heading];
    if (meta.length) lines.push(meta.join(" · "));
    lines.push("");
    if (rowNumbers.length === 0) {
        lines.push("(no cell data)");
        return lines.join("\n");
    }
    const letters = cols.map((c) => XLSX.utils.encode_col(c));
    lines.push(`| Row | ${letters.join(" | ")} |`);
    lines.push(`| --- | ${letters.map(() => "---").join(" | ")} |`);
    for (const r of rowNumbers) {
        const row = rows.get(r)!;
        lines.push(`| ${r + 1} | ${cols.map((c) => row.get(c) ?? "").join(" | ")} |`);
    }
    return lines.join("\n");
}

/** Whether a sheet is hidden (or very hidden) in the workbook. */
function sheetHidden(wb: WorkBook, name: string): boolean {
    const props = wb.Workbook?.Sheets?.find((s) => s.name === name);
    return !!props?.Hidden;
}

/**
 * A workbook as cell-addressed text, one `## Sheet:` block per sheet in
 * workbook order. Throws `SpreadsheetLimitError` above the limits, and on
 * bytes SheetJS cannot read.
 */
export async function spreadsheetToText(
    input: SpreadsheetInput,
    limits: SpreadsheetLimits = DEFAULT_LIMITS,
): Promise<string> {
    const wb = await readWorkbook(input, limits);
    const date1904 = !!wb.Workbook?.WBProps?.date1904;
    const blocks: string[] = [];
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (!ws) continue;
        blocks.push(renderSheet(name, ws, sheetHidden(wb, name), date1904));
    }
    return blocks.join("\n\n").trim();
}

/** Sheet names in workbook order (the document's structure tree). */
export async function spreadsheetSheetNames(
    input: SpreadsheetInput,
    limits: SpreadsheetLimits = DEFAULT_LIMITS,
): Promise<string[]> {
    if (input.kind === "csv") return [CSV_SHEET_NAME];
    const wb = await readWorkbook(input, limits, { sheetNamesOnly: true });
    return [...wb.SheetNames];
}

/** Grid area (rows × columns) the xlsx writer may walk for one sheet. */
const MAX_WRITE_AREA_FACTOR = 25;

/**
 * SheetJS's xlsx writer walks every row and column of `!ref` and trips on
 * the missing rows of a dense sheet. Shrink `!ref` to the cells that exist,
 * fill the row holes, and refuse a grid so sparse that walking it would
 * stall the process.
 */
function fitSheetForWrite(ws: WorkSheet, maxCells: number): void {
    const XLSX = xlsx();
    let maxR = -1;
    let maxC = -1;
    forEachCell(ws, (r, c) => {
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
    });
    for (const m of (ws["!merges"] ?? []) as Range[]) {
        if (m.e.r > maxR) maxR = m.e.r;
        if (m.e.c > maxC) maxC = m.e.c;
    }
    // An empty sheet still needs a one-cell grid.
    maxR = Math.max(maxR, 0);
    maxC = Math.max(maxC, 0);
    if ((maxR + 1) * (maxC + 1) > maxCells * MAX_WRITE_AREA_FACTOR)
        throw new SpreadsheetLimitError(
            "Spreadsheet too large: the grid is too sparse and wide to convert",
        );
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    const dense = (ws as { "!data"?: (CellObject | null)[][] })["!data"];
    if (dense) for (let r = 0; r <= maxR; r++) if (!dense[r]) dense[r] = [];
}

/**
 * An .xlsx copy of a workbook for the browser viewer, which reads xlsx
 * only (legacy .xls and .csv). Cached values only, no formulas, so the grid
 * shows exactly what the text shows. Interim: SheetJS CE writes no cell
 * styles — the LibreOffice Calc conversion (owner decision 2) would keep them.
 */
export async function spreadsheetToXlsx(
    input: SpreadsheetInput,
    limits: SpreadsheetLimits = DEFAULT_LIMITS,
): Promise<Buffer> {
    const wb = await readWorkbook(input, limits);
    for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        if (ws) fitSheetForWrite(ws, limits.maxCells);
    }
    return xlsx().write(wb, {
        bookType: "xlsx",
        type: "buffer",
        compression: true,
    }) as Buffer;
}

// ---------------------------------------------------------------------------
// The text format: detection, row-aware parts, cell lookup
// ---------------------------------------------------------------------------

const SHEET_HEADING = "## Sheet: ";
const TABLE_HEADER_RE = /^\| Row \|/;
const MERGE_TAG_RE = /\s*⟨merged ([A-Z]+\d+):([A-Z]+\d+)⟩/g;

/** Whether extracted text is spreadsheet text (it always opens with a sheet). */
export function isSpreadsheetText(text: string): boolean {
    return typeof text === "string" && text.startsWith(SHEET_HEADING);
}

/**
 * Split spreadsheet text into parts of at most `budget` characters,
 * breaking only between rows. Every part that continues a sheet repeats
 * its `## Sheet:` heading and the column-letter header, so the model can
 * map a column in part 2 to its letter. A single row (or header) larger
 * than the budget is sliced as a last resort. Deterministic.
 */
export function splitSpreadsheetTextIntoParts(
    text: string,
    budget: number,
): string[] {
    if (text.length <= budget) return [text];
    const parts: string[] = [];
    let current = "";
    const flush = () => {
        if (current.trim()) parts.push(current);
        current = "";
    };
    const hardSplit = (seg: string) => {
        for (let i = 0; i < seg.length; i += budget)
            parts.push(seg.slice(i, i + budget));
    };
    const append = (piece: string, sep: string) => {
        current = current ? `${current}${sep}${piece}` : piece;
    };

    for (const raw of text.split(/\n(?=## Sheet: )/)) {
        const block = raw.replace(/\n+$/, "");
        const lines = block.split("\n");
        const tableAt = lines.findIndex((l) => TABLE_HEADER_RE.test(l));
        const head =
            tableAt >= 0 ? lines.slice(0, tableAt + 2).join("\n") : block;
        const contHead =
            tableAt >= 0
                ? `${lines[0]}\n\n${lines[tableAt]}\n${lines[tableAt + 1] ?? ""}`
                : "";
        const rows = tableAt >= 0 ? lines.slice(tableAt + 2) : [];

        // A sheet without a table, or a header the budget cannot hold
        // together with a row: plain segment, sliced if it must be.
        if (tableAt < 0 || head.length >= budget || contHead.length >= budget / 2) {
            if (current && current.length + 2 + block.length > budget) flush();
            if (block.length > budget) {
                flush();
                hardSplit(block);
            } else append(block, "\n\n");
            continue;
        }

        const firstRow = rows[0] ?? "";
        if (current && current.length + 2 + head.length + 1 + firstRow.length > budget)
            flush();
        append(head, "\n\n");
        let rowsInPart = 0;
        for (const row of rows) {
            if (current.length + 1 + row.length > budget && rowsInPart > 0) {
                flush();
                current = contHead;
                rowsInPart = 0;
            }
            if (current.length + 1 + row.length > budget) {
                // One row larger than a part: slice it, each slice under
                // the repeated header.
                const room = budget - contHead.length - 1;
                for (let i = 0; i < row.length; i += room) {
                    if (i > 0 || rowsInPart > 0 || current !== contHead) {
                        flush();
                        current = contHead;
                    }
                    current += `\n${row.slice(i, i + room)}`;
                }
                rowsInPart++;
                continue;
            }
            current += `\n${row}`;
            rowsInPart++;
        }
    }
    flush();
    return parts;
}

/** Column letters → 0-based index ("A" → 0, "AA" → 26). */
function colIndex(letters: string): number {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

function colLetters(index: number): string {
    let s = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
}

const CELL_RE = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

function decodeCell(ref: string): { r: number; c: number } | null {
    const m = CELL_RE.exec(ref);
    return m ? { r: Number(m[2]), c: colIndex(m[1]) } : null;
}

/**
 * Normalise a model-written cell reference: `c2`, `$C$2`, ` C2 ` → `C2`;
 * ranges `a214:b214` → `A214:B214`; a one-cell range collapses. Null when
 * it is not an A1 address or range.
 */
export function normalizeCellRef(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const s = raw
        .trim()
        .replace(/\s*:\s*/g, ":")
        .replace(/\$/g, "")
        .toUpperCase();
    const [a, b, ...rest] = s.split(":");
    if (rest.length || !a || !CELL_RE.test(a)) return null;
    if (b === undefined || b === a) return a;
    return CELL_RE.test(b) ? `${a}:${b}` : null;
}

/**
 * A spreadsheet locator as the model may write it: `sheet` + `cell`, or a
 * combined `Sheet!C2` / `'My sheet'!C2` in `cell`. Null unless both parts
 * are usable.
 */
export function parseCellLocator(
    sheet: unknown,
    cell: unknown,
): { sheet: string; cell: string } | null {
    let sheetName = typeof sheet === "string" ? sheet.trim() : "";
    let ref = typeof cell === "string" ? cell.trim() : "";
    const bang = ref.lastIndexOf("!");
    if (bang > 0) {
        if (!sheetName)
            sheetName = ref.slice(0, bang).trim().replace(/^'(.*)'$/, "$1");
        ref = ref.slice(bang + 1);
    }
    const normalized = normalizeCellRef(ref);
    if (!sheetName || !normalized) return null;
    return { sheet: sheetName, cell: normalized };
}

interface SheetTable {
    /** Column letter → index into each row's cells. */
    columns: Map<string, number>;
    /** Row number → cell texts, table order. */
    rows: Map<number, string[]>;
    /** Merged ranges from the anchors' tags, with the anchor's text. */
    merges: { s: { r: number; c: number }; e: { r: number; c: number }; text: string }[];
}

/** Split a table line on its unescaped pipes; cells trimmed and unescaped. */
function tableCells(line: string): string[] {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1);
    return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Index spreadsheet text by sheet: column letters, rows and merges. Sheets
 * repeated across parts merge into one entry. A hidden sheet is indexed
 * under its name without the "(hidden)" marker too.
 */
export function indexSpreadsheetText(text: string): Map<string, SheetTable> {
    const sheets = new Map<string, SheetTable>();
    let table: SheetTable | null = null;
    let letters: string[] | null = null;
    for (const line of text.split("\n")) {
        if (line.startsWith(SHEET_HEADING)) {
            const name = line.slice(SHEET_HEADING.length);
            table = sheets.get(name) ?? {
                columns: new Map(),
                rows: new Map(),
                merges: [],
            };
            sheets.set(name, table);
            const bare = name.replace(/ \(hidden\)$/, "");
            if (bare !== name && !sheets.has(bare)) sheets.set(bare, table);
            letters = null;
            continue;
        }
        if (!table || !line.startsWith("| ")) continue;
        const cells = tableCells(line);
        if (cells[0] === "Row") {
            letters = cells.slice(1);
            continue;
        }
        const rowNumber = Number(cells[0]);
        if (!letters || !Number.isInteger(rowNumber) || rowNumber < 1) continue;
        const values: string[] = [];
        letters.forEach((letter, i) => {
            const value = cells[i + 1] ?? "";
            let idx = table!.columns.get(letter);
            if (idx === undefined) {
                idx = table!.columns.size;
                table!.columns.set(letter, idx);
            }
            values[idx] = value;
            for (const m of value.matchAll(MERGE_TAG_RE)) {
                const s = decodeCell(m[1]);
                const e = decodeCell(m[2]);
                if (s && e)
                    table!.merges.push({
                        s,
                        e,
                        text: value.replace(MERGE_TAG_RE, "").trim(),
                    });
            }
        });
        table.rows.set(rowNumber, values);
    }
    return sheets;
}

/** Most cells one cited range may gather (a whole-column range is not a quote). */
const MAX_RANGE_CELLS = 10_000;

/**
 * The text of a cited cell or range, from an index of the extracted text:
 * non-empty cells joined with a space, merge tags removed. A cell covered
 * by a merge yields the anchor's text. Null when the sheet or cells are
 * not there.
 */
export function spreadsheetCellText(
    index: Map<string, SheetTable>,
    sheet: string,
    cell: string,
): string | null {
    let table = index.get(sheet) ?? index.get(sheet.trim());
    if (!table) {
        const wanted = sheet.trim().toLowerCase();
        for (const [name, t] of index) {
            if (name.toLowerCase() === wanted) {
                table = t;
                break;
            }
        }
    }
    const ref = normalizeCellRef(cell);
    if (!table || !ref) return null;
    const [a, b = a] = ref.split(":");
    const start = decodeCell(a)!;
    const end = decodeCell(b)!;
    const r0 = Math.min(start.r, end.r);
    const r1 = Math.max(start.r, end.r);
    const c0 = Math.min(start.c, end.c);
    const c1 = Math.max(start.c, end.c);
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_RANGE_CELLS) return null;

    const texts: string[] = [];
    const seen = new Set<string>();
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const idx = table.columns.get(colLetters(c));
            let value =
                idx === undefined
                    ? ""
                    : (table.rows.get(r)?.[idx] ?? "").replace(MERGE_TAG_RE, "").trim();
            if (!value) {
                const merge = table.merges.find(
                    (m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c,
                );
                if (merge && !seen.has(`${merge.s.r}:${merge.s.c}`)) {
                    seen.add(`${merge.s.r}:${merge.s.c}`);
                    value = merge.text;
                }
            } else {
                seen.add(`${r}:${c}`);
            }
            if (value) texts.push(value);
        }
    }
    return texts.length ? texts.join(" ") : null;
}
