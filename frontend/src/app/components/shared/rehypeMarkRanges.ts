import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { TextRange } from "./textQuoteRanges";

/**
 * Rehype plugins for a Markdown document rendered in the document panel
 * (`TextDocView` with `markdown`):
 *
 * - `rehypeMarkRanges` highlights the cited passages. The quote ranges are
 *   found in the raw Markdown (`findQuoteRanges`), and every text node keeps
 *   its source offsets (`position`), so the part of a node inside a range
 *   becomes `<mark data-quote-mark>`. A node whose value is not a verbatim
 *   slice of the source (escapes, entities) is marked whole when it overlaps.
 * - `rehypePageMarkers` turns a paragraph that is only a page marker
 *   `[str. N]` (the context documents' page labels) into
 *   `<div data-page-marker="N">`, drawn as a quiet page divider.
 */

const PAGE_MARKER = /^\[str\. (\d+(?:[–-]\d+)?)\]$/;

function markText(node: Text, ranges: readonly TextRange[]): ElementContent[] | null {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    const hits = ranges.filter(([a, b]) => a < end && b > start);
    if (!hits.length) return null;
    const mark = (value: string): Element => ({
        type: "element",
        tagName: "mark",
        properties: { dataQuoteMark: true },
        children: [{ type: "text", value }],
    });
    if (end - start !== node.value.length) return [mark(node.value)];
    const out: ElementContent[] = [];
    let cursor = 0;
    for (const [a, b] of hits) {
        const from = Math.max(a, start) - start;
        const to = Math.min(b, end) - start;
        if (from > cursor) out.push({ type: "text", value: node.value.slice(cursor, from) });
        if (to > from) out.push(mark(node.value.slice(from, to)));
        cursor = Math.max(cursor, to);
    }
    if (cursor < node.value.length) out.push({ type: "text", value: node.value.slice(cursor) });
    return out;
}

function walkMarks(parent: Root | Element, ranges: readonly TextRange[]): void {
    const next: (RootContent | ElementContent)[] = [];
    let changed = false;
    for (const child of parent.children) {
        if (child.type === "text") {
            const parts = markText(child, ranges);
            if (parts) {
                next.push(...parts);
                changed = true;
                continue;
            }
        } else if (child.type === "element") {
            walkMarks(child, ranges);
        }
        next.push(child);
    }
    if (changed) parent.children = next as typeof parent.children;
}

export function rehypeMarkRanges(options: { ranges: readonly TextRange[] }) {
    return (tree: Root) => {
        if (options.ranges.length) walkMarks(tree, options.ranges);
    };
}

function walkPages(parent: Root | Element): void {
    parent.children = parent.children.map((child) => {
        if (child.type !== "element") return child;
        if (child.tagName === "p" && child.children.length === 1 && child.children[0].type === "text") {
            const m = child.children[0].value.trim().match(PAGE_MARKER);
            if (m) return { type: "element", tagName: "div", properties: { dataPageMarker: m[1] }, children: [] };
        }
        walkPages(child);
        return child;
    }) as typeof parent.children;
}

export function rehypePageMarkers() {
    return (tree: Root) => walkPages(tree);
}

/** The page of a div the plugin made, else null. */
export function pageMarkerOf(node: unknown): string | null {
    const value = (node as Element | undefined)?.properties?.dataPageMarker;
    return typeof value === "string" ? value : null;
}

/** A Markdown file by its name (.md, .markdown). */
export function isMarkdownFilename(filename: string | null | undefined): boolean {
    return /\.(md|markdown)$/i.test(filename?.trim() ?? "");
}
