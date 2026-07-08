/* global Word */

/**
 * Office.js helpers for inserting Word comments and applying tracked
 * edits with attached rationale comments. Mirrors the upstream Eulex Desk
 * implementation; the only changes are local imports and our coding
 * conventions.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/javascript/api/word/word.range#word-word-range-insertcomment-member(1)
 */

import { applyEditsWithTracking, type EditProposal } from "../hooks/useWordDoc";
import { tokenize, diffWords, isTrivialDiff } from "./wordDiff";
import { locateRange, type RangeHint } from "./textMatch";

export type EditMode = "track" | "comments";

export async function insertCommentAtCurrentSelection(
    text: string,
): Promise<void> {
    try {
        await Word.run(async (context) => {
            const sel = context.document.getSelection();
            sel.insertComment(text);
            await context.sync();
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordComments] insertCommentAtCurrentSelection failed", err);
        throw err;
    }
}

export async function insertCommentAtRange(
    searchString: string,
    commentText: string,
    hint?: RangeHint,
): Promise<void> {
    try {
        await Word.run(async (context) => {
            const range = await locateRange(context, searchString, hint);
            if (!range) {
                throw new Error(
                    `Could not find anchor text in document: "${
                        searchString.length > 60
                            ? searchString.slice(0, 60) + "…"
                            : searchString
                    }"`,
                );
            }
            range.insertComment(commentText);
            await context.sync();
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordComments] insertCommentAtRange failed", err);
        throw err;
    }
}

export async function applyTrackedEdit(
    originalText: string,
    newText: string,
): Promise<void> {
    try {
        const edits: EditProposal[] = [{ find: originalText, replace: newText }];
        const { applied, notFound } = await applyEditsWithTracking(edits);
        if (applied === 0 && notFound.length > 0) {
            throw new Error(
                `Could not find text to replace: "${
                    originalText.length > 60
                        ? originalText.slice(0, 60) + "…"
                        : originalText
                }"`,
            );
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordComments] applyTrackedEdit failed", err);
        throw err;
    }
}

/**
 * Replace `edit.find` with `edit.replace` while track changes is enabled,
 * AND attach a Word comment with `edit.reason` (when present) anchored
 * to the changed range. Reviewers see redline + rationale together.
 *
 * Uses word-level diff to preserve run-level formatting (bold, italic,
 * font, color) on unchanged words. Falls back to bulk insert+delete
 * when the diff is trivial or the API is unavailable.
 */
export async function applyTrackedChangeWithComment(edit: {
    find: string;
    replace: string;
    reason?: string;
    context_before?: string;
    context_after?: string;
}): Promise<{ applied: number; notFound: number }> {
    try {
        return await Word.run(async (context) => {
            context.document.changeTrackingMode =
                Word.ChangeTrackingMode.trackAll;

            const target = await locateRange(context, edit.find, {
                contextBefore: edit.context_before,
                contextAfter: edit.context_after,
            });
            if (!target) return { applied: 0, notFound: 1 };

            // Word-level diff for formatting preservation.
            target.load("text");
            await context.sync();
            const originalText = target.text ?? "";

            const oldTokens = tokenize(originalText);
            const newTokens = tokenize(edit.replace);
            const ops = diffWords(oldTokens, newTokens);

            if (isTrivialDiff(oldTokens, newTokens, ops)) {
                // Bulk fallback — same as original approach.
                const inserted = target.insertText(
                    edit.replace,
                    Word.InsertLocation.before,
                );
                target.delete();
                const reason = (edit.reason ?? "").trim();
                if (reason) {
                    inserted.insertComment(`Eulex Desk: ${reason}`);
                }
            } else {
                // Try word-level diff.
                let usedWordDiff = false;
                try {
                    const wordRanges = target.getTextRanges([" "], true);
                    wordRanges.load("items");
                    await context.sync();

                    if (wordRanges.items.length === oldTokens.length) {
                        usedWordDiff = true;

                        // Build action map from diff ops.
                        const insertsBefore = new Map<number, string[]>();
                        const insertsAtEnd: string[] = [];
                        const toDelete = new Set<number>();
                        let oi = 0;
                        for (const op of ops) {
                            if (op.type === "keep") {
                                oi++;
                            } else if (op.type === "delete") {
                                toDelete.add(op.oldIndex!);
                                oi++;
                            } else if (op.type === "insert") {
                                if (oi < oldTokens.length) {
                                    const list = insertsBefore.get(oi) ?? [];
                                    list.push(op.text);
                                    insertsBefore.set(oi, list);
                                } else {
                                    insertsAtEnd.push(op.text);
                                }
                            }
                        }

                        // Apply in reverse order.
                        if (insertsAtEnd.length > 0) {
                            const last = wordRanges.items[wordRanges.items.length - 1];
                            last.insertText(
                                " " + insertsAtEnd.join(" "),
                                Word.InsertLocation.after,
                            );
                        }
                        for (let i = oldTokens.length - 1; i >= 0; i--) {
                            const wr = wordRanges.items[i];
                            const pre = insertsBefore.get(i);
                            if (pre && pre.length > 0) {
                                wr.insertText(
                                    pre.join(" ") + " ",
                                    Word.InsertLocation.before,
                                );
                            }
                            if (toDelete.has(i)) {
                                wr.delete();
                            }
                        }

                        // Attach comment to the overall target range.
                        const reason = (edit.reason ?? "").trim();
                        if (reason) {
                            target.insertComment(`Eulex Desk: ${reason}`);
                        }
                    }
                } catch {
                    // getTextRanges not available — will fall through.
                }

                if (!usedWordDiff) {
                    // Fallback.
                    const inserted = target.insertText(
                        edit.replace,
                        Word.InsertLocation.before,
                    );
                    target.delete();
                    const reason = (edit.reason ?? "").trim();
                    if (reason) {
                        inserted.insertComment(`Eulex Desk: ${reason}`);
                    }
                }
            }

            await context.sync();
            return { applied: 1, notFound: 0 };
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordComments] applyTrackedChangeWithComment failed", err);
        throw err;
    }
}

export async function applyEditsAsComments(
    edits: Array<{
        find: string;
        replace: string;
        reason?: string;
        context_before?: string;
        context_after?: string;
    }>,
): Promise<{ applied: number; notFound: string[] }> {
    let applied = 0;
    const notFound: string[] = [];

    for (const edit of edits) {
        try {
            const body = edit.reason
                ? `Eulex Desk: ${edit.replace}\n\n(${edit.reason})`
                : `Eulex Desk: ${edit.replace}`;
            await insertCommentAtRange(edit.find, body, {
                contextBefore: edit.context_before,
                contextAfter: edit.context_after,
            });
            applied += 1;
        } catch {
            notFound.push(edit.find);
        }
    }

    return { applied, notFound };
}
