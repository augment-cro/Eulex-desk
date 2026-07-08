/* global Word */

/**
 * Office.js helper to apply an assistant-proposed write into the open
 * Word document.
 *
 * Markdown handling is intentionally minimal — paragraphs split on blank
 * lines, `# ` / `## ` / `### ` set heading styles, `- ` / `* ` and `1. `
 * lines become list items. Inline `**bold**` / `*italic*` markers are
 * stripped (we render plain text rather than risk mis-styling). Tables,
 * fenced code, links, nested lists are out of scope.
 */

export type WriteProposal = {
    at: "selection" | "end" | "after_selection";
    content_md: string;
};

type ParsedBlock = {
    kind: "heading" | "list" | "para";
    level?: 1 | 2 | 3;
    listKind?: "bullet" | "number";
    text: string;
};

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;
const NUMBER_RE = /^\d+[.)]\s+(.*)$/;

function parseMarkdown(md: string): ParsedBlock[] {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const out: ParsedBlock[] = [];
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) continue;
        const h = HEADING_RE.exec(line);
        if (h) {
            const level = Math.min(3, h[1].length) as 1 | 2 | 3;
            out.push({ kind: "heading", level, text: h[2] });
            continue;
        }
        const b = BULLET_RE.exec(line);
        if (b) {
            out.push({ kind: "list", listKind: "bullet", text: b[1] });
            continue;
        }
        const n = NUMBER_RE.exec(line);
        if (n) {
            out.push({ kind: "list", listKind: "number", text: n[1] });
            continue;
        }
        out.push({ kind: "para", text: line });
    }
    return out;
}

function stripEmphasis(text: string): string {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(^|\W)\*(?!\s)(.+?)\*(?!\w)/g, "$1$2")
        .replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, "$1$2");
}

function styleFor(level: 1 | 2 | 3): string {
    return level === 1 ? "Heading 1" : level === 2 ? "Heading 2" : "Heading 3";
}

async function appendBlocksToBody(
    context: Word.RequestContext,
    blocks: ParsedBlock[],
): Promise<void> {
    const body = context.document.body;
    for (const block of blocks) {
        const text = stripEmphasis(block.text);
        const para = body.insertParagraph(text, Word.InsertLocation.end);
        if (block.kind === "heading" && block.level) {
            para.style = styleFor(block.level);
        } else if (block.kind === "list") {
            try {
                para.startNewList();
            } catch {
                /* ignore */
            }
        }
    }
}

async function insertAtSelection(
    context: Word.RequestContext,
    blocks: ParsedBlock[],
    mode: "selection" | "after_selection",
): Promise<void> {
    const sel = context.document.getSelection();

    if (mode === "selection") {
        sel.insertText("", Word.InsertLocation.replace);
    }

    await context.sync();

    let cursor: Word.Range = sel.getRange(Word.RangeLocation.end);
    for (const block of blocks) {
        const text = stripEmphasis(block.text);
        const para = cursor.insertParagraph(text, Word.InsertLocation.after);
        if (block.kind === "heading" && block.level) {
            para.style = styleFor(block.level);
        } else if (block.kind === "list") {
            try {
                para.startNewList();
            } catch {
                /* ignore */
            }
        }
        cursor = para.getRange(Word.RangeLocation.end);
    }
}

export async function applyWriteToWord(write: WriteProposal): Promise<void> {
    if (typeof Word === "undefined" || !Word?.run) {
        throw new Error(
            "Word is not available — open this add-in inside Microsoft Word to insert content.",
        );
    }
    const md = write.content_md ?? "";
    if (!md.trim()) throw new Error("Write proposal has no content.");
    const blocks = parseMarkdown(md);
    if (blocks.length === 0) {
        throw new Error("Write proposal content could not be parsed.");
    }

    try {
        await Word.run(async (context) => {
            if (write.at === "end") {
                await appendBlocksToBody(context, blocks);
            } else if (
                write.at === "selection" ||
                write.at === "after_selection"
            ) {
                await insertAtSelection(context, blocks, write.at);
            } else {
                throw new Error(`Unknown write location: ${String(write.at)}`);
            }
            await context.sync();
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[wordWrite] applyWriteToWord failed", err);
        if (err instanceof Error) throw err;
        throw new Error(`applyWriteToWord failed: ${String(err)}`);
    }
}
