/**
 * Deterministic quote-location engine (tracker #22).
 *
 * Verifies that a citation quote actually appears in the extracted text of
 * the cited document version. No LLM calls — pure string matching:
 *
 *   - exact substring match                      → "verified"
 *   - whitespace / case / diacritic-tolerant hit → "repaired"
 *     (the caller replaces the quote with the exact source text we return)
 *   - no match                                   → "unverified"
 *
 * Shared by both citation paths:
 *   - chat `<CITATIONS>` → `citation_data` annotations
 *     (chatTools.mapCitationsToAnnotations)
 *   - tabular `[[page:N||quote:…]]` / `[[sheet:S||cell:A1||quote:…]]`
 *     markers at generation time (routes/tabular.ts, full run +
 *     single-cell regenerate)
 *
 * A spreadsheet citation names its cell, so its quote is checked against
 * that cell's text first and only then against the whole text.
 *
 * Fail-soft by contract: an unlocatable quote is only ever *flagged*; the
 * answer is never blocked or dropped, and callers omit verification entirely
 * when no source text is available (unknown ≠ unverified).
 */

import { indexSpreadsheetText, spreadsheetCellText } from "./spreadsheet";

export type QuoteVerificationStatus = "verified" | "repaired" | "unverified";

export type QuoteLocation =
    | { status: "verified" }
    | { status: "repaired"; exact: string }
    | { status: "unverified" };

/**
 * Typographic punctuation folded to ASCII before comparison. PDF extraction
 * and LLM output frequently disagree on curly vs straight quotes and dash
 * width even when the quote is otherwise verbatim; treating these as equal
 * avoids false "unverified" flags. The repaired quote always comes from the
 * ORIGINAL source text, so folding never leaks into what users see.
 */
const PUNCT_FOLD: Record<string, string> = {
    "‘": "'", // ‘
    "’": "'", // ’
    "‚": "'", // ‚
    "‛": "'",
    "“": '"', // “
    "”": '"', // ”
    "„": '"', // „
    "–": "-", // –
    "—": "-", // —
    "−": "-", // −
    "…": "...", // …
    // Croatian đ/Đ carry a stroke, not a combining mark — NFD leaves them
    // intact, so fold explicitly (đ→d is the standard diacritic fold).
    "đ": "d",
    "Đ": "d",
    // Markdown structure characters — tabular extraction produces markdown
    // (emphasis, headings, table pipes) that the model's verbatim quote
    // usually omits. Treated as invisible for matching; the repaired quote
    // still comes from the original source slice.
    "*": "",
    "_": "",
    "`": "",
    "#": "",
    ">": "",
    "|": "",
};

/** Combining diacritical marks (produced by NFD) — stripped for matching. */
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

function foldChar(ch: string): string {
    const mapped = PUNCT_FOLD[ch] ?? ch;
    return mapped
        .normalize("NFD")
        .replace(COMBINING_MARKS_RE, "")
        .toLowerCase();
}

function isWhitespace(ch: string): boolean {
    // \s covers Unicode whitespace incl. NBSP in JS regex.
    return /\s/.test(ch);
}

interface NormalizedText {
    /** Normalized text: folded chars, single spaces between tokens. */
    norm: string;
    /** For norm[i]: start index of the originating char in the source. */
    starts: number[];
    /** For norm[i]: end index (exclusive) of the originating char. */
    ends: number[];
}

/**
 * Build the normalized view of `source` with an index map back to original
 * offsets, so a tolerant hit can be translated into the exact source slice.
 */
function buildNormalized(source: string): NormalizedText {
    const chars: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    let pendingSpace = false;
    let pendingSpaceStart = -1;
    let idx = 0;
    for (const ch of source) {
        const len = ch.length; // surrogate pairs occupy 2 UTF-16 units
        if (isWhitespace(ch)) {
            if (chars.length > 0 && !pendingSpace) {
                pendingSpace = true;
                pendingSpaceStart = idx;
            }
            idx += len;
            continue;
        }
        const folded = foldChar(ch);
        if (folded.length === 0) {
            idx += len;
            continue;
        }
        if (pendingSpace) {
            chars.push(" ");
            starts.push(pendingSpaceStart);
            ends.push(idx);
            pendingSpace = false;
        }
        for (const f of folded) {
            chars.push(f);
            starts.push(idx);
            ends.push(idx + len);
        }
        idx += len;
    }
    return { norm: chars.join(""), starts, ends };
}

/** Normalize a quote the same way (no index map needed). */
function normalizeQuote(quote: string): string {
    return buildNormalized(quote).norm;
}

/**
 * Quotes may elide with an ellipsis ("…"/"..."); each fragment is then
 * located independently (in order where possible). Fragments of a located
 * elided quote are rejoined with " … " in the repaired text.
 */
const ELLIPSIS_SPLIT_RE = /\s*(?:\.{3}|…)\s*/;

/**
 * A quote that runs across a page boundary carries the `[[PAGE_BREAK]]`
 * sentinel the prompt pack asks for (`page: "41-42"`). The source text has
 * the page marker (and often a running footer/header) at that point, so
 * each side is located on its own — in order, and the next side must start
 * within PAGE_BREAK_MAX_GAP normalized chars of the previous one.
 */
const PAGE_BREAK_SPLIT_RE = /\s*\[\[\s*PAGE_BREAK\s*\]\]\s*/i;
const PAGE_BREAK_JOIN = " [[PAGE_BREAK]] ";
const PAGE_BREAK_MAX_GAP = 5_000;

export interface QuoteMatcher {
    locate(quote: string): QuoteLocation;
    /**
     * Spreadsheet citation: the quote against the cited cell (or range)
     * first, then against the whole text. The repaired text comes from
     * whichever matched.
     */
    locateInCell(sheet: string, cell: string, quote: string): QuoteLocation;
}

/**
 * Precompute the normalized source once; `locate` is then cheap per quote.
 * Use this when verifying several quotes against the same document text.
 */
export function createQuoteMatcher(sourceText: string): QuoteMatcher {
    const source = typeof sourceText === "string" ? sourceText : "";
    let normalized: NormalizedText | null = null;
    const getNormalized = () => {
        if (!normalized) normalized = buildNormalized(source);
        return normalized;
    };

    /**
     * Tolerant search of one fragment at or after `fromNorm` (and starting
     * no later than `maxStartNorm`); returns the exact source slice or null.
     * Strictly in order: a fragment that only occurs BEFORE the previous
     * one means the quote is not verbatim, so it must stay unverified
     * rather than be "repaired".
     */
    const locateFragment = (
        fragment: string,
        fromNorm: number,
        maxStartNorm = Infinity,
    ): { exact: string; normEnd: number } | null => {
        const nq = normalizeQuote(fragment);
        if (!nq) return null;
        const { norm, starts, ends } = getNormalized();
        const at = norm.indexOf(nq, fromNorm);
        if (at === -1 || at > maxStartNorm) return null;
        const last = at + nq.length - 1;
        return {
            exact: source.slice(starts[at], ends[last]).trim(),
            normEnd: at + nq.length,
        };
    };

    let sheets: ReturnType<typeof indexSpreadsheetText> | null = null;

    const matcher: QuoteMatcher = {
        locateInCell(sheet: string, cell: string, quote: string): QuoteLocation {
            if (!sheets) sheets = indexSpreadsheetText(source);
            const cellText = spreadsheetCellText(sheets, sheet, cell);
            if (cellText) {
                const inCell = createQuoteMatcher(cellText).locate(quote);
                if (inCell.status !== "unverified") return inCell;
            }
            return matcher.locate(quote);
        },
        locate(quote: string): QuoteLocation {
            const q = typeof quote === "string" ? quote.trim() : "";
            if (!q) return { status: "unverified" };

            // 1. Exact substring — the happy path, no normalization needed.
            if (source.includes(q)) return { status: "verified" };

            // 2. Tolerant match (whitespace / case / diacritics / typographic
            //    punctuation), fragment-wise across [[PAGE_BREAK]] sides and
            //    ellipsis elisions, in order.
            const segments = q
                .split(PAGE_BREAK_SPLIT_RE)
                .map((side) =>
                    side
                        .split(ELLIPSIS_SPLIT_RE)
                        .map((f) => f.trim())
                        .filter(Boolean),
                )
                .filter((fragments) => fragments.length > 0);
            if (segments.length === 0) return { status: "unverified" };

            const exactSegments: string[] = [];
            let cursor = 0;
            let verbatim = true;
            for (let s = 0; s < segments.length; s++) {
                const exacts: string[] = [];
                for (let f = 0; f < segments[s].length; f++) {
                    const maxStart =
                        s > 0 && f === 0 ? cursor + PAGE_BREAK_MAX_GAP : Infinity;
                    const hit = locateFragment(segments[s][f], cursor, maxStart);
                    if (!hit) return { status: "unverified" };
                    if (hit.exact !== segments[s][f]) verbatim = false;
                    exacts.push(hit.exact);
                    cursor = hit.normEnd;
                }
                exactSegments.push(
                    exacts.length === 1 ? exacts[0] : exacts.join(" … "),
                );
            }
            // A page-break quote can never be a plain substring (the source
            // has the page marker where the quote has the sentinel), so
            // verbatim sides are the page-break equivalent of step 1.
            if (
                segments.length > 1 &&
                verbatim &&
                segments.every((fragments) => fragments.length === 1)
            ) {
                return { status: "verified" };
            }
            const exact = exactSegments.join(PAGE_BREAK_JOIN);
            if (!exact) return { status: "unverified" };
            return { status: "repaired", exact };
        },
    };
    return matcher;
}

/** One-shot convenience over `createQuoteMatcher`. */
export function verifyQuote(quote: string, sourceText: string): QuoteLocation {
    return createQuoteMatcher(sourceText).locate(quote);
}

// ---------------------------------------------------------------------------
// Tabular citation marker verification
// ---------------------------------------------------------------------------

/**
 * Both tabular citation forms in ONE pattern:
 *   [[page:<N>||quote:<text>]]                               paged documents
 *   [[sheet:<SheetName>||cell:<A1 or A1:B2>||quote:<text>]]  spreadsheets
 * Groups: 1 page · 2 sheet · 3 cell · 4 quote (`quote:` optional).
 *
 * Must stay byte-identical to the frontend parser
 * (frontend/src/app/components/tabular/citation-utils.ts CITATION_MARKER_RE):
 * the i-th match here is the i-th citation badge the cell renders, which is
 * how `unverified_citations` indexes line up client-side.
 */
export const CITATION_MARKER_RE =
    /\[\[(?:page:(\d+)|sheet:([^|\[\]]+)\|\|cell:([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?))\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

/** A tabular marker with its quote replaced (the locator kept as matched). */
export function citationMarker(
    locator: { page: string } | { sheet: string; cell: string },
    quote: string,
): string {
    return "page" in locator
        ? `[[page:${locator.page}||quote:${quote}]]`
        : `[[sheet:${locator.sheet}||cell:${locator.cell}||quote:${quote}]]`;
}

export interface MarkerVerificationResult {
    /** Input text with tolerant-matched quotes replaced by exact source text. */
    text: string;
    /** Status per marker, in document order (frontend badge order). */
    statuses: QuoteVerificationStatus[];
}

/**
 * Verify every tabular citation marker in `text` against `matcher` — a
 * sheet marker against its cell first. Repaired quotes are rewritten in
 * place with the exact source text — unless that text itself contains
 * square brackets (it would corrupt the marker syntax), in which case the
 * original quote is kept and the marker counts as located ("verified").
 * Unverified markers are left untouched; the caller flags them
 * out-of-band.
 */
export function verifyCitationMarkers(
    text: string,
    matcher: QuoteMatcher,
): MarkerVerificationResult {
    const statuses: QuoteVerificationStatus[] = [];
    if (typeof text !== "string" || !text) {
        return { text: text ?? "", statuses };
    }
    CITATION_MARKER_RE.lastIndex = 0;
    const out = text.replace(
        CITATION_MARKER_RE,
        (
            marker: string,
            page: string | undefined,
            sheet: string | undefined,
            cell: string | undefined,
            quote: string,
        ) => {
            const loc =
                page !== undefined
                    ? matcher.locate(quote.trim())
                    : matcher.locateInCell(sheet!.trim(), cell!, quote.trim());
            if (loc.status === "repaired") {
                if (/[\[\]]/.test(loc.exact)) {
                    // Located, but the exact text would break the marker
                    // syntax (and the frontend regex). Keep the model's
                    // quote.
                    statuses.push("verified");
                    return marker;
                }
                statuses.push("repaired");
                return citationMarker(
                    page !== undefined ? { page } : { sheet: sheet!, cell: cell! },
                    loc.exact,
                );
            }
            statuses.push(loc.status);
            return marker;
        },
    );
    return { text: out, statuses };
}
