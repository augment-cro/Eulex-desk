import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import { splitStatusTokens, STATUS_KINDS, type StatusKind } from "./statusTokens";

/** Never inside code, preformatted text or rendered math. */
function skip(el: Element): boolean {
    if (el.tagName === "code" || el.tagName === "pre") return true;
    const cls = el.properties?.className;
    return Array.isArray(cls) && cls.includes("katex");
}

function splitText(node: Text): ElementContent[] {
    return splitStatusTokens(node.value).map((p) =>
        typeof p === "string"
            ? { type: "text", value: p }
            : {
                  type: "element",
                  tagName: "span",
                  properties: { dataStatusDot: p.status },
                  // The emoji stays as the node's text, so text read from
                  // the tree (table export) keeps the canonical token.
                  children: [{ type: "text", value: p.token }],
              },
    );
}

function walk(parent: Root | Element): void {
    const next: (RootContent | ElementContent)[] = [];
    let changed = false;
    for (const child of parent.children) {
        if (child.type === "text" && splitStatusTokens(child.value).some((p) => typeof p !== "string")) {
            next.push(...splitText(child));
            changed = true;
            continue;
        }
        if (child.type === "element" && !skip(child)) walk(child);
        next.push(child);
    }
    if (changed) parent.children = next as typeof parent.children;
}

/**
 * Rehype plugin: the model's status tokens (🔴 🟡 🔵 ⚪ 🟢) in an answer's
 * text become `<span data-status-dot="…">` elements, which the markdown
 * renderer draws as StatusDot. Headings, paragraphs, list items, table
 * cells and links are covered; code and math are not touched.
 */
export function rehypeStatusDots() {
    return (tree: Root) => walk(tree);
}

/** The status of a span the plugin made, else null. */
export function statusDotOf(node: unknown): StatusKind | null {
    const value = (node as Element | undefined)?.properties?.dataStatusDot;
    return STATUS_KINDS.includes(value as StatusKind) ? (value as StatusKind) : null;
}
