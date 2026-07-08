/**
 * Word-level diff engine for formatting-preserving tracked changes.
 *
 * Uses Longest Common Subsequence (LCS) to compute a minimal diff
 * between two word-token sequences. The output is an array of
 * operations the caller can map onto Word.Range sub-ranges to
 * change only the words that actually differ — preserving run-level
 * formatting (bold, italic, font, color) on unchanged tokens.
 *
 * This module is **pure logic** — no Office.js dependency — so it
 * can be unit-tested in any JS runtime.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffOpType = "keep" | "delete" | "insert";

export interface DiffOp {
    type: DiffOpType;
    /** The word text for the operation.
     *  - keep: the matched word
     *  - delete: the word to remove
     *  - insert: the word to add */
    text: string;
    /** Index in the *old* token array (set for keep / delete). */
    oldIndex?: number;
    /** Index in the *new* token array (set for keep / insert). */
    newIndex?: number;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split text into word tokens on whitespace boundaries.
 *
 * We intentionally keep punctuation attached to words (e.g. "clause,"
 * stays as one token) because Word's `getTextRanges([" "])` splits
 * only on spaces and the resulting sub-ranges include trailing
 * punctuation within the same run.
 *
 * Empty tokens are filtered out.
 */
export function tokenize(text: string): string[] {
    return text.split(/\s+/).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// LCS + diff
// ---------------------------------------------------------------------------

/**
 * Compute a word-level diff between `oldTokens` and `newTokens`.
 *
 * Returns an ordered array of {@link DiffOp} that, when applied
 * left-to-right, transforms `oldTokens` into `newTokens`.
 *
 * The algorithm:
 * 1. Build the LCS table (standard O(n·m) DP).
 * 2. Backtrack to produce keep / delete / insert ops.
 *
 * For typical edit proposals (a few words changed in a sentence)
 * both arrays are small (< 200 words), so performance is fine.
 */
export function diffWords(oldTokens: string[], newTokens: string[]): DiffOp[] {
    const n = oldTokens.length;
    const m = newTokens.length;

    // Edge cases
    if (n === 0 && m === 0) return [];
    if (n === 0) {
        return newTokens.map((t, i) => ({
            type: "insert" as const,
            text: t,
            newIndex: i,
        }));
    }
    if (m === 0) {
        return oldTokens.map((t, i) => ({
            type: "delete" as const,
            text: t,
            oldIndex: i,
        }));
    }

    // Build LCS table  — dp[i][j] = LCS length of old[0..i-1] vs new[0..j-1]
    const dp: number[][] = Array.from({ length: n + 1 }, () =>
        new Array<number>(m + 1).fill(0),
    );
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (oldTokens[i - 1] === newTokens[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to build the diff ops (in reverse, then flip).
    const ops: DiffOp[] = [];
    let i = n;
    let j = m;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
            ops.push({
                type: "keep",
                text: oldTokens[i - 1],
                oldIndex: i - 1,
                newIndex: j - 1,
            });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.push({
                type: "insert",
                text: newTokens[j - 1],
                newIndex: j - 1,
            });
            j--;
        } else {
            ops.push({
                type: "delete",
                text: oldTokens[i - 1],
                oldIndex: i - 1,
            });
            i--;
        }
    }

    ops.reverse();
    return ops;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` when the diff is "trivial" — meaning it's cheaper or
 * safer to do a bulk replace rather than word-level surgery. We define
 * trivial as:
 *   - The entire text was replaced (LCS ≤ 20 % of original length), OR
 *   - One of the texts is very short (≤ 3 words).
 *
 * When this returns `true` the caller should fall back to the old
 * `insertText + delete` bulk approach.
 */
export function isTrivialDiff(
    oldTokens: string[],
    newTokens: string[],
    ops: DiffOp[],
): boolean {
    const keepCount = ops.filter((o) => o.type === "keep").length;
    const maxLen = Math.max(oldTokens.length, newTokens.length);

    // Very short texts — word-level diff doesn't buy us much.
    if (maxLen <= 3) return true;

    // If we're keeping less than 20 % of the words, it's effectively
    // a full rewrite — bulk replace is cleaner.
    if (keepCount / maxLen < 0.2) return true;

    return false;
}
