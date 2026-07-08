/* global Word */

/**
 * Text-matching helpers for locating LLM-proposed edit ranges in the open
 * Word document.
 *
 * Two concerns live here:
 *   1. **Pure string logic** (normalization, Word wildcard-query building,
 *      context scoring, anchor splitting) — no Office.js dependency, so it
 *      can be unit-tested in any JS runtime.
 *   2. **`locateRange()`** — the Office.js range locator shared by
 *      `useWordDoc.ts` (tracked edits) and `wordComments.ts` (comments),
 *      replacing the near-identical copies that used to live in both.
 *
 * Why the wildcard tier exists: `body.search()` matches the document's
 * *stored* characters verbatim, and legal documents are full of curly
 * quotes, non-breaking spaces and en/em dashes inserted by autocorrect —
 * while an LLM almost always emits the ASCII equivalents (' " - space). A
 * literal search for the model's `find` text therefore misses. We can't
 * normalize the live document, so instead we:
 *   - try the literal text first (fast path, exact),
 *   - then retry with a Word *wildcard* query where each ambiguous
 *     character is replaced by `?` (matches any single character), which
 *     transparently bridges the straight <-> curly / hyphen <-> dash gap.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/javascript/api/word/word.searchoptions
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `body.search()` hard-caps near 255 chars and won't match across
 *  paragraph marks — stay comfortably under and split long finds into
 *  head/tail anchors. */
export const SEARCH_LIMIT = 200;
export const ANCHOR_CHARS = 80;
/** Min query length worth searching — shorter strings match far too much. */
const MIN_QUERY = 4;
/** Cap on candidates we score during disambiguation, to bound sync cost. */
const MAX_DISAMBIG_CANDIDATES = 12;

// ---------------------------------------------------------------------------
// Pure: normalization
// ---------------------------------------------------------------------------

// Code points that autocorrect commonly swaps, grouped by the canonical
// ASCII character we fold them to. Declared as numeric code points (not
// regex literals) on purpose: these are invisible / look-alike characters,
// so keeping the source pure-ASCII makes the sets reviewable and immune to
// the file's byte encoding.
//   U+2018/2019 curly single quotes, U+201A/201B low-9 + high-reversed-9,
//   U+2032 prime, U+0060 grave, U+00B4 acute, U+0027 ASCII apostrophe.
const SINGLE_QUOTE_CPS = [
    0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x0060, 0x00b4, 0x0027,
];
//   U+201C/201D curly double quotes, U+201E/201F low-9 + high-reversed-9,
//   U+2033 double prime, U+00AB/00BB guillemets, U+0022 ASCII double quote.
const DOUBLE_QUOTE_CPS = [
    0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb, 0x0022,
];
//   U+2010..U+2015 hyphen/dashes, U+2212 minus, U+002D ASCII hyphen-minus.
const DASH_CPS = [
    0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x002d,
];
//   U+00A0 nbsp, U+2002..U+200A en/em/figure/punctuation/thin/hair spaces,
//   U+202F narrow nbsp, U+205F medium math space, U+3000 ideographic space.
//   (U+0020 normal space is intentionally excluded — see toWordWildcardQuery.)
const FANCY_SPACE_CPS = [
    0x00a0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009,
    0x200a, 0x202f, 0x205f, 0x3000,
];

/** Map of code point -> canonical replacement char, for folding. */
const FOLD = new Map<number, string>();
for (const cp of SINGLE_QUOTE_CPS) FOLD.set(cp, "'");
for (const cp of DOUBLE_QUOTE_CPS) FOLD.set(cp, '"');
for (const cp of DASH_CPS) FOLD.set(cp, "-");
for (const cp of FANCY_SPACE_CPS) FOLD.set(cp, " ");

/** Set of all code points whose autocorrect variants differ. */
const AMBIGUOUS_CPS = new Set<number>([
    ...SINGLE_QUOTE_CPS,
    ...DOUBLE_QUOTE_CPS,
    ...DASH_CPS,
    ...FANCY_SPACE_CPS,
]);

/**
 * Canonical form used for fuzzy *comparison* (not for searching the live
 * doc): straightens quotes, normalizes every dash to `-`, turns exotic
 * spaces into a normal space, collapses whitespace runs, applies Unicode
 * NFC, and trims. Used by {@link scoreContextMatch}.
 */
export function normalizeForMatch(s: string): string {
    const src = (s ?? "").normalize("NFC");
    let out = "";
    for (const ch of src) {
        const cp = ch.codePointAt(0) as number;
        out += FOLD.get(cp) ?? ch;
    }
    return out.replace(/\s+/g, " ").trim();
}

/** True when `s` contains a character whose autocorrect variants differ
 *  (quote, apostrophe, dash or exotic space) — i.e. a literal search might
 *  miss and the wildcard tier is worth trying. */
export function hasAmbiguousChars(s: string): boolean {
    for (const ch of s ?? "") {
        if (AMBIGUOUS_CPS.has(ch.codePointAt(0) as number)) return true;
    }
    return false;
}

function isAmbiguousChar(ch: string): boolean {
    return AMBIGUOUS_CPS.has(ch.codePointAt(0) as number);
}

// Characters Word treats as operators in wildcard mode; must be backslash-
// escaped to match them literally. (We never escape the `?` we insert.)
const WILDCARD_META = new Set([
    "\\",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "<",
    ">",
    "@",
    "!",
    "*",
    "?",
]);

/**
 * Build a Word wildcard query that tolerates straight<->curly quotes and
 * hyphen<->dash differences: every ambiguous character becomes `?` (matches
 * any single char), every wildcard metacharacter in the remaining literal
 * text is escaped, and ordinary spaces are left literal.
 *
 * Returns `null` when:
 *   - there's nothing ambiguous to bridge (a literal search is just as
 *     good and more precise), or
 *   - the text contains `^`, which can't be safely escaped in Word's
 *     wildcard grammar — caller should stick to the literal search.
 *
 * Note: this intentionally does NOT wildcard ordinary spaces, so a model
 * space vs. a document non-breaking space at the *same* position can still
 * miss. That case is rare relative to curly quotes and is left to the
 * head/tail anchor fallback.
 */
export function toWordWildcardQuery(find: string): string | null {
    let out = "";
    let replaced = false;
    for (const ch of find) {
        if (ch === "^") return null;
        if (isAmbiguousChar(ch)) {
            out += "?";
            replaced = true;
            continue;
        }
        if (WILDCARD_META.has(ch)) {
            out += "\\" + ch;
            continue;
        }
        out += ch;
    }
    return replaced ? out : null;
}

// ---------------------------------------------------------------------------
// Pure: anchor splitting + context scoring
// ---------------------------------------------------------------------------

/** Split a multi-line find string into trimmed, non-trivial paragraph
 *  lines (>= 6 chars) usable as search anchors. */
export function splitParagraphs(find: string): string[] {
    return (find ?? "")
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 6);
}

export function clip(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) : s;
}

export interface RangeHint {
    /** ~40 chars immediately before the target text in the document. */
    contextBefore?: string;
    /** ~40 chars immediately after the target text in the document. */
    contextAfter?: string;
}

/**
 * Score how well a candidate paragraph's text matches the surrounding
 * context the model reported for an edit. Higher is better; 0 means no
 * signal. Comparison is normalization-insensitive (curly quotes etc.).
 *
 * Pure and exported so the disambiguation heuristic can be unit-tested
 * without Office.js.
 */
export function scoreContextMatch(
    paragraphText: string,
    hint: RangeHint | undefined,
): number {
    if (!hint) return 0;
    const para = normalizeForMatch(paragraphText);
    if (!para) return 0;
    let score = 0;
    const before = normalizeForMatch(hint.contextBefore ?? "");
    if (before) {
        const tail = before.slice(-30);
        if (tail.length >= 4 && para.includes(tail)) score += tail.length;
    }
    const after = normalizeForMatch(hint.contextAfter ?? "");
    if (after) {
        const head = after.slice(0, 30);
        if (head.length >= 4 && para.includes(head)) score += head.length;
    }
    return score;
}

// ---------------------------------------------------------------------------
// Office.js: range locator
// ---------------------------------------------------------------------------

/**
 * Run a single `body.search()` (literal or wildcard) and, when it returns
 * more than one hit and we have surrounding context, pick the candidate
 * whose paragraph best matches that context.
 */
async function runSearch(
    context: Word.RequestContext,
    body: Word.Body,
    query: string,
    useWildcards: boolean,
    hint: RangeHint | undefined,
): Promise<Word.Range | null> {
    const r = body.search(query, {
        matchCase: false,
        matchWholeWord: false,
        matchWildcards: useWildcards,
    });
    r.load("items");
    await context.sync();

    if (r.items.length === 0) return null;
    if (r.items.length === 1) return r.items[0];

    // Multiple hits. Without context we can't do better than the first.
    if (!hint || (!hint.contextBefore && !hint.contextAfter)) {
        return r.items[0];
    }

    const candidates = r.items.slice(0, MAX_DISAMBIG_CANDIDATES);
    const paras = candidates.map((c) => c.paragraphs.getFirst());
    for (const p of paras) p.load("text");
    await context.sync();

    let best = candidates[0];
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
        const score = scoreContextMatch(paras[i].text ?? "", hint);
        if (score > bestScore) {
            bestScore = score;
            best = candidates[i];
        }
    }
    return best;
}

/**
 * Locate `query` in the document: literal search first, then a wildcard
 * retry that bridges typographic (curly-quote / dash) differences.
 */
async function searchTiered(
    context: Word.RequestContext,
    body: Word.Body,
    query: string,
    hint: RangeHint | undefined,
): Promise<Word.Range | null> {
    if (!query || query.length < MIN_QUERY) return null;

    const literal = await runSearch(context, body, query, false, hint);
    if (literal) return literal;

    const wildcard = toWordWildcardQuery(query);
    if (wildcard && wildcard.length >= MIN_QUERY) {
        const hit = await runSearch(context, body, wildcard, true, hint);
        if (hit) return hit;
    }
    return null;
}

/**
 * Find the Word range that corresponds to an LLM-proposed `find` string.
 *
 * Strategy:
 *   - Single line within the search limit -> tiered search directly.
 *   - Multi-line / over-limit -> search a head anchor and a tail anchor
 *     (clipped to {@link ANCHOR_CHARS}) and `expandTo` between them.
 *
 * `hint.contextBefore` / `hint.contextAfter` disambiguate when a short
 * anchor matches in several places (common with boilerplate clauses).
 *
 * Returns `null` when nothing matches. Must be called inside `Word.run`.
 */
export async function locateRange(
    context: Word.RequestContext,
    fullFind: string,
    hint?: RangeHint,
): Promise<Word.Range | null> {
    const body = context.document.body;
    const trimmed = (fullFind ?? "").trim();
    if (!trimmed) return null;

    const hasLineBreak = /[\r\n]/.test(trimmed);
    if (!hasLineBreak && trimmed.length <= SEARCH_LIMIT) {
        const direct = await searchTiered(context, body, trimmed, hint);
        if (direct) return direct;
    }

    const paragraphs = splitParagraphs(trimmed);
    if (paragraphs.length === 0) return null;

    const head = clip(paragraphs[0], ANCHOR_CHARS);
    const tail = clip(paragraphs[paragraphs.length - 1], ANCHOR_CHARS);

    if (paragraphs.length === 1) {
        return searchTiered(context, body, head, hint);
    }

    const headRange = await searchTiered(context, body, head, {
        contextBefore: hint?.contextBefore,
    });
    if (!headRange) return null;
    const tailRange = await searchTiered(context, body, tail, {
        contextAfter: hint?.contextAfter,
    });
    if (!tailRange) return headRange;
    try {
        return headRange.expandTo(tailRange);
    } catch {
        return headRange;
    }
}
