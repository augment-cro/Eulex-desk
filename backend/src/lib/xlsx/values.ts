/**
 * Cell value parsing for generated workbooks (generate_excel, #46 phase 3).
 *
 * The model writes every cell as text. A column's declared type decides
 * what Excel receives: numbers, amounts, percentages and dates become real
 * numbers (so sums, sorting and filters work), text stays text.
 *
 * Accepted input, Croatian and English conventions alike:
 *   numbers   1234.56 · 1,234.56 · 1.234,56 · 1 234,56 · -5 · (1.234,56)
 *   currency  the same, with an optional "€" / "EUR" — any other currency
 *             marker keeps the cell as text (it would be shown as €)
 *   percent   percentage points: "12.5", "12,5 %" and "12.5%" all mean 12.5 %
 *   dates     2020-06-15 · 15. 6. 2020. · 15.06.2020 · 15/06/2020 ·
 *             15. lipnja 2020. · 15 June 2020 · June 15, 2020 (+ hh:mm)
 *
 * "1.234" is ambiguous (1234 in Croatian, 1.234 in English). The other
 * values in the same column decide; with no evidence, an amount or a plain
 * number reads it as a thousands separator and a percentage as a decimal
 * separator — the likelier reading for each in legal data.
 *
 * A value that cannot be read as its column's type is written as text and
 * reported, never guessed.
 */
import { statusTokensAsGlyphs } from "../statusTokens";

export const COLUMN_TYPES = [
    "text",
    "number",
    "date",
    "currency",
    "percent",
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export function isColumnType(value: unknown): value is ColumnType {
    return (COLUMN_TYPES as readonly unknown[]).includes(value);
}

/** Excel's limit on the characters in one cell. */
export const MAX_CELL_CHARS = 32_767;

/** Integers above 15 significant digits lose precision as Excel numbers. */
const MAX_SIGNIFICANT_DIGITS = 15;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Characters XML 1.0 cannot carry: C0 controls other than tab/LF/CR, lone
 * surrogates and U+FFFE/U+FFFF. One of them makes the whole file corrupt.
 */
const XML_INVALID_RE =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface CellText {
    text: string;
    /** True when the value was cut to Excel's 32,767-character limit. */
    truncated: boolean;
}

/**
 * The text a value is written as: XML-safe, line breaks normalised, cut to
 * Excel's cell limit without splitting a surrogate pair. Null for an empty
 * value.
 */
export function cellText(value: unknown): CellText | null {
    if (value == null) return null;
    let text =
        typeof value === "string"
            ? value
            : typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : JSON.stringify(value);
    // The model's status emoji (🔴 🟡 🔵 ⚪ 🟢) as plain ● / ○ — calmer in a
    // workbook, and the label after them carries the meaning.
    text = statusTokensAsGlyphs(text.replace(/\r\n?/g, "\n").replace(XML_INVALID_RE, ""));
    if (text.length === 0) return null;
    if (text.length <= MAX_CELL_CHARS) return { text, truncated: false };
    let cut = MAX_CELL_CHARS;
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return { text: text.slice(0, cut), truncated: true };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Which character is the decimal separator. */
export type DecimalConvention = "dot" | "comma";

interface NumberReadings {
    /** Value with "." as the decimal separator ("," groups thousands). */
    dot: number | null;
    /** Value with "," as the decimal separator ("." groups thousands). */
    comma: number | null;
}

const MINUS_RE = /^[-−]/;

/**
 * Strip the sign and spaces/apostrophes used as thousands separators.
 * Null when what remains cannot be a number in either convention.
 */
function splitSign(raw: string): { negative: boolean; body: string } | null {
    let s = raw.trim();
    let negative = false;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) {
        negative = true;
        s = paren[1].trim();
    }
    if (MINUS_RE.test(s)) {
        if (negative) return null;
        negative = true;
        s = s.slice(1).trim();
    } else if (s.startsWith("+")) {
        s = s.slice(1).trim();
    }
    // "1 234 567,89" / "1'234.56": spaces or apostrophes group thousands.
    const unified = s.replace(/[\s    '’]/g, " ");
    if (unified.includes(" ")) {
        if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(unified)) return null;
        s = unified.replace(/ /g, "");
    }
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
    return { negative, body: s };
}

/** Value of `body` with `dec` as the decimal and `group` as the grouping separator. */
function readWith(body: string, dec: "." | ",", group: "." | ","): number | null {
    const d = dec === "." ? "\\." : ",";
    const g = group === "." ? "\\." : ",";
    // Integer part: plain digits, or groups of three (not starting with 0).
    const re = new RegExp(
        `^(\\d+|[1-9]\\d{0,2}(?:${g}\\d{3})+)?(?:${d}(\\d+))?$`,
    );
    const m = re.exec(body);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    // "0123" is an identifier (OIB, account number), not 123.
    if (m[1] && /^0\d/.test(m[1])) return null;
    const intDigits = (m[1] ?? "0").split(group).join("");
    const fracDigits = m[2] ?? "";
    const significant = (intDigits.replace(/^0+/, "") + fracDigits).length;
    if (significant > MAX_SIGNIFICANT_DIGITS) return null;
    const value = Number(fracDigits ? `${intDigits}.${fracDigits}` : intDigits);
    return Number.isFinite(value) ? value : null;
}

function readings(body: string): NumberReadings {
    return { dot: readWith(body, ".", ","), comma: readWith(body, ",", ".") };
}

/**
 * The convention one value proves on its own: "1,234.56", "12,5" or
 * "1.234.567" do; "1234", "1.234" and "1,234" do not.
 */
export function numberConvention(raw: string): DecimalConvention | null {
    const parts = splitSign(stripNumberDecorations(raw).text);
    if (!parts) return null;
    const r = readings(parts.body);
    if (r.dot !== null && r.comma === null && /[.,]/.test(parts.body)) return "dot";
    if (r.comma !== null && r.dot === null && /[.,]/.test(parts.body)) return "comma";
    return null;
}

/**
 * The convention a column's values agree on, or null when none of them
 * decides or they disagree.
 */
export function columnConvention(values: readonly unknown[]): DecimalConvention | null {
    let found: DecimalConvention | null = null;
    for (const v of values) {
        if (typeof v !== "string") continue;
        const c = numberConvention(v);
        if (!c) continue;
        if (found && found !== c) return null;
        found = c;
    }
    return found;
}

interface Decorations {
    text: string;
    percent: boolean;
    euro: boolean;
    /** Another currency or unit is attached — not a plain number. */
    foreign: boolean;
}

/** Peel "%" and "€"/"EUR" off a number; flag any other letters or symbols. */
function stripNumberDecorations(raw: string): Decorations {
    let text = raw.trim();
    let percent = false;
    let euro = false;
    if (/%$/.test(text)) {
        percent = true;
        text = text.slice(0, -1).trim();
    }
    const euroRe = /^(?:€|EUR)\s*|\s*(?:€|EUR)$/i;
    if (euroRe.test(text)) {
        euro = true;
        text = text.replace(euroRe, "").trim();
        // "-€ 5" / "€ -5" both end up as a signed number.
    }
    const foreign = /[^\d\s.,'’()+\-−    ]/.test(text);
    return { text, percent, euro, foreign };
}

export interface ParsedNumber {
    value: number;
}

/**
 * Read `raw` as a number of the given column type. `convention` is the
 * column's agreed convention (see columnConvention); it settles "1.234".
 * Null when the value is not a number of that type.
 */
export function parseNumber(
    raw: unknown,
    type: "number" | "currency" | "percent",
    convention: DecimalConvention | null = null,
): ParsedNumber | null {
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return null;
        return { value: type === "percent" ? raw / 100 : raw };
    }
    if (typeof raw !== "string") return null;
    const deco = stripNumberDecorations(raw);
    if (deco.foreign) return null;
    if (deco.percent && type !== "percent") return null;
    if (deco.euro && type !== "currency") return null;
    const parts = splitSign(deco.text);
    if (!parts) return null;
    const r = readings(parts.body);
    let value: number | null;
    if (r.dot === null || r.comma === null) {
        value = r.dot ?? r.comma;
    } else if (r.dot === r.comma) {
        value = r.dot;
    } else if (convention) {
        value = convention === "dot" ? r.dot : r.comma;
    } else {
        // Ambiguous "1.234" / "1,234" with no evidence in the column: one
        // separator followed by exactly three digits. An amount or a count
        // groups thousands; a percentage has decimals.
        const groupingReading = /\./.test(parts.body) ? r.comma : r.dot;
        const decimalReading = /\./.test(parts.body) ? r.dot : r.comma;
        value = type === "percent" ? decimalReading : groupingReading;
    }
    if (value === null) return null;
    if (parts.negative) value = -value;
    if (type === "percent") value = value / 100;
    // -0 → 0
    return { value: value === 0 ? 0 : value };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {};
(
    [
        ["january", "jan", "siječanj", "siječnja", "sijecanj", "sijecnja"],
        ["february", "feb", "veljača", "veljače", "veljaca", "veljace"],
        ["march", "mar", "ožujak", "ožujka", "ozujak", "ozujka"],
        ["april", "apr", "travanj", "travnja"],
        ["may", "svibanj", "svibnja"],
        ["june", "jun", "lipanj", "lipnja"],
        ["july", "jul", "srpanj", "srpnja"],
        ["august", "aug", "kolovoz", "kolovoza"],
        ["september", "sep", "sept", "rujan", "rujna"],
        ["october", "oct", "listopad", "listopada"],
        ["november", "nov", "studeni", "studenoga", "studenog"],
        ["december", "dec", "prosinac", "prosinca"],
    ] as const
).forEach((names, i) => {
    for (const n of names) MONTHS[n] = i + 1;
});

const TIME = String.raw`(?:,?\s+(?:u\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*h)?)?`;
const ISO_RE = new RegExp(
    String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$`,
);
const DOTTED_RE = new RegExp(
    String.raw`^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\.?${TIME}$`,
);
const SLASH_RE = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME}$`);
const DAY_MONTH_NAME_RE = new RegExp(
    String.raw`^(\d{1,2})\.?\s+([\p{L}]+)\.?,?\s+(\d{4})\.?${TIME}$`,
    "u",
);
const MONTH_NAME_DAY_RE = new RegExp(
    String.raw`^([\p{L}]+)\.?\s+(\d{1,2}),?\s+(\d{4})${TIME}$`,
    "u",
);

/** Excel serial of 1900-03-01; earlier serials hit the 1900 leap-year bug. */
const FIRST_SAFE_SERIAL = 61;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export interface ParsedDate {
    /** Excel serial date (1900 date system), with a fraction for the time. */
    serial: number;
    hasTime: boolean;
}

function toSerial(
    y: number,
    mo: number,
    d: number,
    h = 0,
    mi = 0,
    s = 0,
): number | null {
    if (y < 1900 || y > 9999 || mo < 1 || mo > 12 || d < 1) return null;
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > daysInMonth || h > 23 || mi > 59 || s > 59) return null;
    const serial =
        (Date.UTC(y, mo - 1, d) - EXCEL_EPOCH_MS) / DAY_MS +
        (h * 3600 + mi * 60 + s) / 86_400;
    return serial >= FIRST_SAFE_SERIAL ? serial : null;
}

function withTime(
    y: number,
    mo: number,
    d: number,
    hh: string | undefined,
    mm: string | undefined,
    ss: string | undefined,
): ParsedDate | null {
    const serial = toSerial(
        y,
        mo,
        d,
        hh ? Number(hh) : 0,
        mm ? Number(mm) : 0,
        ss ? Number(ss) : 0,
    );
    return serial === null ? null : { serial, hasTime: hh !== undefined };
}

/**
 * Day-first or month-first for a column's slash dates: a part above 12
 * decides. Null when nothing decides or the values disagree (then each
 * ambiguous date is read day-first, the European convention).
 */
export function columnDayFirst(values: readonly unknown[]): boolean | null {
    let found: boolean | null = null;
    for (const v of values) {
        if (typeof v !== "string") continue;
        const m = SLASH_RE.exec(v.trim());
        if (!m) continue;
        const a = Number(m[1]);
        const b = Number(m[2]);
        const dayFirst = a > 12 ? true : b > 12 ? false : null;
        if (dayFirst === null) continue;
        if (found !== null && found !== dayFirst) return null;
        found = dayFirst;
    }
    return found;
}

/** Read `raw` as a date (optionally with a time). Null when it is not one. */
export function parseDate(
    raw: unknown,
    dayFirst: boolean | null = null,
): ParsedDate | null {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    let m = ISO_RE.exec(s);
    if (m) return withTime(+m[1], +m[2], +m[3], m[4], m[5], m[6]);
    m = DOTTED_RE.exec(s);
    if (m) return withTime(+m[3], +m[2], +m[1], m[4], m[5], m[6]);
    m = SLASH_RE.exec(s);
    if (m) {
        const a = +m[1];
        const b = +m[2];
        const df = a > 12 ? true : b > 12 ? false : (dayFirst ?? true);
        return df
            ? withTime(+m[3], b, a, m[4], m[5], m[6])
            : withTime(+m[3], a, b, m[4], m[5], m[6]);
    }
    m = DAY_MONTH_NAME_RE.exec(s);
    if (m) {
        const month = MONTHS[m[2].toLowerCase()];
        return month ? withTime(+m[3], month, +m[1], m[4], m[5], m[6]) : null;
    }
    m = MONTH_NAME_DAY_RE.exec(s);
    if (m) {
        const month = MONTHS[m[1].toLowerCase()];
        return month ? withTime(+m[3], month, +m[2], m[4], m[5], m[6]) : null;
    }
    return null;
}
