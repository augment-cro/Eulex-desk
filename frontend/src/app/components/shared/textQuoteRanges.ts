/**
 * Locate cited quotes inside a plain-text document (`TextDocView`).
 *
 * Matching is whitespace-tolerant (any run of spaces / line breaks in the
 * quote matches any run in the text) and case-insensitive. A quote with
 * ellipses or a `[[PAGE_BREAK]]` sentinel is matched segment by segment,
 * like the PDF highlighter. A long segment with no exact match falls back to
 * its first words, so a small difference late in the quote still lands on
 * the right passage.
 */

export type TextRange = [start: number, end: number];

const SEGMENT_SPLIT = /\.{3}|…|\[\[PAGE_BREAK\]\]/;
const PREFIX_WORDS = 8;
const MIN_SEGMENT_CHARS = 3;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWords(
    text: string,
    words: readonly string[],
    from: number,
): TextRange | null {
    const re = new RegExp(words.map(escapeRegExp).join("\\s+"), "giu");
    re.lastIndex = from;
    const match = re.exec(text);
    return match ? [match.index, match.index + match[0].length] : null;
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
    const merged: TextRange[] = [];
    for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

/** Sorted, non-overlapping character ranges of `text` to highlight. */
export function findQuoteRanges(
    text: string,
    quotes: readonly string[],
): TextRange[] {
    const ranges: TextRange[] = [];
    for (const quote of quotes) {
        let from = 0;
        for (const segment of quote.split(SEGMENT_SPLIT)) {
            const words = segment.split(/\s+/).filter(Boolean);
            if (words.join(" ").length < MIN_SEGMENT_CHARS) continue;
            const hit =
                findWords(text, words, from) ??
                (words.length > PREFIX_WORDS
                    ? findWords(text, words.slice(0, PREFIX_WORDS), from)
                    : null);
            if (!hit) continue;
            ranges.push(hit);
            from = hit[1];
        }
    }
    return mergeRanges(ranges);
}
