import { describe, expect, it } from "vitest";
import {
    CITATION_MARKER_RE,
    prepareTabularMarkdown,
    preprocessCitations,
} from "./citation-utils";

describe("tabular citation markers", () => {
    it("parses page and sheet/cell markers in document order", () => {
        const text =
            "Iznos je 1,250,000.00 [[sheet:Ugovori||cell:C2||quote:1,250,000.00]]" +
            " prema ugovoru [[page:3||quote:ukupna naknada]] i zbroju" +
            " [[sheet:Q3 Budget||cell:a214:b214||quote:Ukupno]].";
        const { processed, citations } = preprocessCitations(text);
        expect(processed).toBe(
            "Iznos je 1,250,000.00 §0§ prema ugovoru §1§ i zbroju §2§.",
        );
        expect(citations).toEqual([
            { sheet: "Ugovori", cell: "C2", quote: "1,250,000.00" },
            { page: 3, quote: "ukupna naknada" },
            { sheet: "Q3 Budget", cell: "A214:B214", quote: "Ukupno" },
        ]);
    });

    it("keeps the legacy page form (optional `quote:` prefix, brackets in quotes)", () => {
        const { citations } = preprocessCitations(
            "a [[page:12||Članak 5. [stavak 2]]] b [[PAGE:1||quote:x]]",
        );
        expect(citations).toEqual([
            { page: 12, quote: "Članak 5. [stavak 2]" },
            { page: 1, quote: "x" },
        ]);
    });

    it("leaves malformed sheet markers alone (and never turns them into pills)", () => {
        const text =
            "[[sheet:Ugovori||cell:not-a-cell||quote:x]] [[sheet:S||quote:x]]";
        const { citations } = preprocessCitations(text);
        expect(citations).toEqual([]);
        const { pills } = prepareTabularMarkdown(text);
        expect(pills).toEqual([]);
    });

    it("still extracts tag pills next to citations", () => {
        const { citations, pills } = prepareTabularMarkdown(
            "[[Visok rizik]] [[sheet:Ugovori||cell:B2||quote:Alfa]]",
        );
        expect(pills).toEqual(["Visok rizik"]);
        expect(citations).toEqual([
            { sheet: "Ugovori", cell: "B2", quote: "Alfa" },
        ]);
    });

    it("is one global pattern whose i-th match is the i-th badge", () => {
        expect(CITATION_MARKER_RE.global).toBe(true);
        const text =
            "[[page:1||quote:a]] [[sheet:S||cell:A1||quote:b]] [[page:2||quote:c]]";
        CITATION_MARKER_RE.lastIndex = 0;
        const matches = [...text.matchAll(CITATION_MARKER_RE)].map((m) => [
            m[1],
            m[2],
            m[3],
            m[4],
        ]);
        expect(matches).toEqual([
            ["1", undefined, undefined, "a"],
            [undefined, "S", "A1", "b"],
            ["2", undefined, undefined, "c"],
        ]);
    });
});
