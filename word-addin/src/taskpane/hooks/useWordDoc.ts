/* global Word */

/**
 * Office.js helpers for reading/writing the open Word document.
 *
 * The bulk of the file mirrors the upstream `useWordDoc.ts` from the
 * Eulex Desk reference repo: selection state, formatting, paragraph styles,
 * track-changes mode, accept/reject revisions, and the find-and-replace
 * helper that applies edits with track changes turned on.
 *
 * Trim notes:
 *   - Removed the rich formatting bundle (`applyFormatting`, alignment,
 *     line spacing) — we don't surface formatting toolbars in the
 *     add-in yet. They can be re-added trivially when needed.
 */

// ---------------------------------------------------------------------------
// Document content
// ---------------------------------------------------------------------------

export async function getDocumentText(): Promise<string> {
    return Word.run(async (context) => {
        const body = context.document.body;
        body.load("text");
        await context.sync();
        return body.text ?? "";
    });
}

export type WordSelectionState = {
    text: string;
    isEmpty: boolean;
    length: number;
    /** First 50 chars of the selection, with an ellipsis if truncated. */
    snippet: string;
};

const EMPTY_SELECTION: WordSelectionState = {
    text: "",
    isEmpty: true,
    length: 0,
    snippet: "",
};

function buildSnippet(text: string): string {
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) return "";
    if (collapsed.length <= 50) return collapsed;
    return collapsed.slice(0, 50) + "…";
}

export async function getSelectionState(): Promise<WordSelectionState> {
    try {
        if (typeof Word === "undefined") return EMPTY_SELECTION;
        return await Word.run(async (context) => {
            const sel = context.document.getSelection();
            sel.load("text,isEmpty");
            await context.sync();
            const text = sel.text ?? "";
            const isEmpty = sel.isEmpty || text.length === 0;
            if (isEmpty) return EMPTY_SELECTION;
            return {
                text,
                isEmpty: false,
                length: text.length,
                snippet: buildSnippet(text),
            };
        });
    } catch {
        return EMPTY_SELECTION;
    }
}

// ---------------------------------------------------------------------------
// Track changes
// ---------------------------------------------------------------------------

export type TrackChangesMode = "off" | "all" | "mine";

export async function setTrackChangesMode(mode: TrackChangesMode): Promise<void> {
    await Word.run(async (context) => {
        const modeMap: Record<TrackChangesMode, Word.ChangeTrackingMode> = {
            off: Word.ChangeTrackingMode.off,
            all: Word.ChangeTrackingMode.trackAll,
            mine: Word.ChangeTrackingMode.trackMineOnly,
        };
        context.document.changeTrackingMode = modeMap[mode];
        await context.sync();
    });
}

export async function getTrackChangesMode(): Promise<TrackChangesMode> {
    return Word.run(async (context) => {
        context.document.load("changeTrackingMode");
        await context.sync();
        const m = context.document.changeTrackingMode;
        if (m === Word.ChangeTrackingMode.trackAll) return "all";
        if (m === Word.ChangeTrackingMode.trackMineOnly) return "mine";
        return "off";
    });
}

// We use `body.getTrackedChanges()` (Word.TrackedChangeCollection, API set
// WordApi 1.6) rather than `document.revisions` (WordApiDesktop 1.4). The
// former is generally available on Word desktop AND Word on the web, has a
// wider host reach, and exposes `acceptAll()` / `rejectAll()` directly. See
// https://learn.microsoft.com/javascript/api/word/word.trackedchangecollection
export async function acceptAllChanges(): Promise<{
    ok: boolean;
    count: number;
    fallback?: boolean;
}> {
    try {
        return await Word.run(async (context) => {
            const tracked = context.document.body.getTrackedChanges();
            tracked.load("items");
            await context.sync();
            const count = tracked.items.length;
            tracked.acceptAll();
            await context.sync();
            return { ok: true, count };
        });
    } catch {
        return { ok: false, count: 0, fallback: true };
    }
}

export async function rejectAllChanges(): Promise<{
    ok: boolean;
    count: number;
    fallback?: boolean;
}> {
    try {
        return await Word.run(async (context) => {
            const tracked = context.document.body.getTrackedChanges();
            tracked.load("items");
            await context.sync();
            const count = tracked.items.length;
            tracked.rejectAll();
            await context.sync();
            return { ok: true, count };
        });
    } catch {
        return { ok: false, count: 0, fallback: true };
    }
}

export async function getRevisionCount(): Promise<number | null> {
    try {
        return await Word.run(async (context) => {
            const tracked = context.document.body.getTrackedChanges();
            tracked.load("items");
            await context.sync();
            return tracked.items.length;
        });
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Find & replace with track changes
// ---------------------------------------------------------------------------

import { tokenize, diffWords, isTrivialDiff } from "../lib/wordDiff";
import { locateRange } from "../lib/textMatch";

export interface EditProposal {
    find: string;
    replace: string;
    reason?: string;
    /** ~40 chars before `find` — used to disambiguate when the anchor
     *  text occurs in several places in the document. */
    context_before?: string;
    /** ~40 chars after `find` — same disambiguation role. */
    context_after?: string;
}

/**
 * Apply a word-level diff between `target` range's current text and
 * `replacement`, modifying only the changed words so formatting on
 * unchanged runs (bold, italic, font, color) is preserved.
 *
 * Falls back to bulk `insertText + delete` when:
 *   - `getTextRanges` is not available (older Word hosts)
 *   - the diff is trivial (full rewrite or very short text)
 */
async function applyWordLevelDiff(
    context: Word.RequestContext,
    target: Word.Range,
    replacement: string,
): Promise<void> {
    // Load the matched range text so we can diff it.
    target.load("text");
    await context.sync();
    const originalText = target.text ?? "";

    const oldTokens = tokenize(originalText);
    const newTokens = tokenize(replacement);
    const ops = diffWords(oldTokens, newTokens);

    // If the diff is trivial (full rewrite, very short), use bulk.
    if (isTrivialDiff(oldTokens, newTokens, ops)) {
        target.insertText(replacement, Word.InsertLocation.before);
        target.delete();
        await context.sync();
        return;
    }

    // Try splitting the target range into per-word sub-ranges.
    // `getTextRanges([" "], true)` splits on spaces and trims, giving
    // us one Range per word. Each sub-range retains its original
    // run-level formatting (bold, italic, font, etc.).
    let wordRanges: Word.RangeCollection;
    try {
        wordRanges = target.getTextRanges([" "], true);
        wordRanges.load("items");
        await context.sync();
    } catch {
        // getTextRanges unavailable (Word API < 1.3) — bulk fallback.
        target.insertText(replacement, Word.InsertLocation.before);
        target.delete();
        await context.sync();
        return;
    }

    // Safety: if Word returned a different word count than we tokenized,
    // the alignment would be wrong — fall back to bulk.
    if (wordRanges.items.length !== oldTokens.length) {
        target.insertText(replacement, Word.InsertLocation.before);
        target.delete();
        await context.sync();
        return;
    }

    // Apply ops in REVERSE document order to avoid range invalidation.
    // First, build an action list indexed by the old-token position.
    type Action =
        | { kind: "keep" }
        | { kind: "delete" }
        | { kind: "replace"; text: string }
        | { kind: "insertBefore"; text: string };

    const actions: Action[] = oldTokens.map(() => ({ kind: "keep" as const }));
    // Track insertions that happen "before" a given old position.
    const insertsBefore: Map<number, string[]> = new Map();
    // Insertions at the very end (after all old tokens).
    const insertsAtEnd: string[] = [];

    let oldIdx = 0;
    for (const op of ops) {
        if (op.type === "keep") {
            oldIdx++;
        } else if (op.type === "delete") {
            actions[op.oldIndex!] = { kind: "delete" };
            oldIdx++;
        } else if (op.type === "insert") {
            // Figure out where this insertion lands relative to old.
            if (oldIdx < oldTokens.length) {
                const list = insertsBefore.get(oldIdx) ?? [];
                list.push(op.text);
                insertsBefore.set(oldIdx, list);
            } else {
                insertsAtEnd.push(op.text);
            }
        }
    }

    // Apply in reverse order (right → left).
    // 1. Append insertions at the end.
    if (insertsAtEnd.length > 0) {
        const lastRange = wordRanges.items[wordRanges.items.length - 1];
        lastRange.insertText(
            " " + insertsAtEnd.join(" "),
            Word.InsertLocation.after,
        );
    }

    for (let i = oldTokens.length - 1; i >= 0; i--) {
        const wr = wordRanges.items[i];
        const action = actions[i];

        // Insert words that go *before* this position.
        const pre = insertsBefore.get(i);
        if (pre && pre.length > 0) {
            wr.insertText(
                pre.join(" ") + " ",
                Word.InsertLocation.before,
            );
        }

        if (action.kind === "delete") {
            wr.delete();
        }
        // "keep" — do nothing; the word and its formatting stay.
    }

    await context.sync();
}

export async function applyEditsWithTracking(
    edits: EditProposal[],
): Promise<{ applied: number; notFound: string[] }> {
    let applied = 0;
    const notFound: string[] = [];

    // Locating the range (literal -> wildcard tiers, head/tail anchors for
    // long finds, context disambiguation) lives in `lib/textMatch`, shared
    // with the comment path in `wordComments.ts`.
    for (const edit of edits) {
        try {
            const count = await Word.run(async (context) => {
                context.document.changeTrackingMode =
                    Word.ChangeTrackingMode.trackAll;

                const find = (edit.find ?? "").trim();
                if (!find) return 0;

                const target = await locateRange(context, find, {
                    contextBefore: edit.context_before,
                    contextAfter: edit.context_after,
                });
                if (!target) return 0;

                await applyWordLevelDiff(context, target, edit.replace);
                return 1;
            });

            if (count === 0) notFound.push(edit.find);
            else applied += count;
        } catch {
            notFound.push(edit.find);
        }
    }

    return { applied, notFound };
}

// ---------------------------------------------------------------------------
// Structured document extraction + chunking
// ---------------------------------------------------------------------------

export interface DocumentChunk {
    /** Rendered text with markdown-style heading / list prefixes. */
    text: string;
    /** 0-based start paragraph index in the document. */
    startParagraph: number;
    /** 0-based end paragraph index (inclusive). */
    endParagraph: number;
    /** Rough token count estimate (chars / 4). */
    estimatedTokens: number;
}

const HEADING_STYLES: Record<string, string> = {
    "Heading 1": "# ",
    "Heading1": "# ",
    "Heading 2": "## ",
    "Heading2": "## ",
    "Heading 3": "### ",
    "Heading3": "### ",
    "Heading 4": "#### ",
    "Heading4": "#### ",
};

/**
 * Read the full document paragraph-by-paragraph, preserving heading
 * styles and list structure, and split it into token-aware chunks.
 *
 * Each chunk is capped at `maxTokensPerChunk` (default 6000) estimated
 * tokens. Chunks split preferentially at H1/H2 boundaries and never
 * mid-paragraph.
 */
export async function getStructuredDocument(
    maxTokensPerChunk = 6000,
): Promise<DocumentChunk[]> {
    return Word.run(async (context) => {
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load("text, style, isListItem");
        await context.sync();

        if (paragraphs.items.length === 0) return [];

        // Render each paragraph with structure markers.
        const rendered: { text: string; isHeading12: boolean }[] = [];
        for (const para of paragraphs.items) {
            const raw = para.text ?? "";
            const style = para.style ?? "";
            const prefix = HEADING_STYLES[style] ?? "";

            let line: string;
            if (prefix) {
                line = prefix + raw;
            } else if (para.isListItem) {
                line = "- " + raw;
            } else {
                line = raw;
            }
            rendered.push({
                text: line,
                isHeading12:
                    style === "Heading 1" ||
                    style === "Heading1" ||
                    style === "Heading 2" ||
                    style === "Heading2",
            });
        }

        // Split into chunks.
        const chunks: DocumentChunk[] = [];
        let chunkLines: string[] = [];
        let chunkStart = 0;
        let chunkTokens = 0;

        const flushChunk = (endIdx: number) => {
            if (chunkLines.length === 0) return;
            const text = chunkLines.join("\n");
            chunks.push({
                text,
                startParagraph: chunkStart,
                endParagraph: endIdx,
                estimatedTokens: Math.ceil(text.length / 4),
            });
            chunkLines = [];
            chunkTokens = 0;
            chunkStart = endIdx + 1;
        };

        for (let i = 0; i < rendered.length; i++) {
            const { text, isHeading12 } = rendered[i];
            const lineTokens = Math.ceil(text.length / 4);

            // If adding this paragraph would exceed the limit, or this
            // is a major heading (H1/H2) and the chunk already has
            // content, flush the current chunk.
            if (
                chunkLines.length > 0 &&
                (chunkTokens + lineTokens > maxTokensPerChunk ||
                    (isHeading12 && chunkTokens > 200))
            ) {
                flushChunk(i - 1);
            }

            chunkLines.push(text);
            chunkTokens += lineTokens;
        }
        flushChunk(rendered.length - 1);

        return chunks;
    });
}

/**
 * Return a compact outline of the document: heading text with
 * hierarchy markers. Useful as lightweight context for the LLM.
 */
export async function getDocumentOutline(): Promise<string> {
    return Word.run(async (context) => {
        const paragraphs = context.document.body.paragraphs;
        paragraphs.load("text, style");
        await context.sync();

        const lines: string[] = [];
        for (const para of paragraphs.items) {
            const style = para.style ?? "";
            const prefix = HEADING_STYLES[style];
            if (prefix) {
                lines.push(prefix + (para.text ?? "").trim());
            }
        }
        return lines.join("\n");
    });
}

/**
 * Backward-compatible wrapper — returns the full document as plain text,
 * truncated to `maxChars`. Callers that need structure should migrate
 * to `getStructuredDocument()`.
 */
export async function getDocumentForContext(maxChars = 40000): Promise<string> {
    try {
        const chunks = await getStructuredDocument();
        const full = chunks.map((c) => c.text).join("\n\n");
        if (full.length <= maxChars) return full;
        return full.slice(0, maxChars) + "\n[…document truncated for context…]";
    } catch {
        // Fallback to the basic body.text approach.
        return Word.run(async (context) => {
            const body = context.document.body;
            body.load("text");
            await context.sync();
            const text = body.text ?? "";
            if (text.length <= maxChars) return text;
            return text.slice(0, maxChars) + "\n[…document truncated for context…]";
        });
    }
}
