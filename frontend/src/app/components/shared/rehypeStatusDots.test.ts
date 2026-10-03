import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { rehypeStatusDots, statusDotOf } from "./rehypeStatusDots";
import { tableNodeToRows, type HastNode } from "../assistant/tableXlsx";

const el = (tagName: string, children: unknown[], properties: Record<string, unknown> = {}) => ({
    type: "element",
    tagName,
    properties,
    children,
});
const text = (value: string) => ({ type: "text", value });

describe("rehypeStatusDots", () => {
    it("turns tokens into status spans that keep the emoji as text; code and math stay as they are", () => {
        const table = el("table", [
            el("tr", [el("th", [text("🟢")]), el("th", [text("Kontrola")])]),
            el("tr", [el("td", [text("🟡️ AA-20")]), el("td", [el("code", [text("🔴")])])]),
        ]);
        const math = el("span", [text("🔵")], { className: ["katex"] });
        const tree = { type: "root", children: [table, el("p", [math])] } as unknown as Root;
        rehypeStatusDots()(tree);

        const th = (table.children[0] as ReturnType<typeof el>).children[0] as ReturnType<typeof el>;
        expect(statusDotOf(th.children[0])).toBe("clear");
        const td = (table.children[1] as ReturnType<typeof el>).children[0] as ReturnType<typeof el>;
        expect(td.children.map((c) => statusDotOf(c) ?? (c as { value?: string }).value)).toEqual([
            "gap",
            " AA-20",
        ]);
        expect(math.children).toEqual([text("🔵")]);
        // "Download as Excel" reads the tree: the canonical tokens survive.
        expect(tableNodeToRows(table as unknown as HastNode)).toEqual([
            ["🟢", "Kontrola"],
            ["🟡️ AA-20", "🔴"],
        ]);
        expect(statusDotOf(text("x"))).toBeNull();
    });
});
