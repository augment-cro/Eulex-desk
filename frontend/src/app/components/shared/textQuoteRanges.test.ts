import { describe, it, expect } from "vitest";
import { findQuoteRanges } from "./textQuoteRanges";

function highlighted(text: string, quotes: string[]): string[] {
    return findQuoteRanges(text, quotes).map(([s, e]) => text.slice(s, e));
}

describe("findQuoteRanges", () => {
    const text =
        "Članak 5.\n\nUgovor se sklapa na\nodređeno vrijeme   od dvije godine.\nStranke su suglasne.";

    it("matches across line breaks and repeated spaces", () => {
        expect(
            highlighted(text, [
                "Ugovor se sklapa na određeno vrijeme od dvije godine.",
            ]),
        ).toEqual([
            "Ugovor se sklapa na\nodređeno vrijeme   od dvije godine.",
        ]);
    });

    it("is case-insensitive", () => {
        expect(highlighted(text, ["STRANKE SU SUGLASNE"])).toEqual([
            "Stranke su suglasne",
        ]);
    });

    it("matches ellipsis segments separately, in order", () => {
        expect(
            highlighted(text, ["Ugovor se sklapa … dvije godine"]),
        ).toEqual(["Ugovor se sklapa", "dvije godine"]);
    });

    it("falls back to the first words of a long quote", () => {
        const quote =
            "Ugovor se sklapa na određeno vrijeme od dvije godine, uz produljenje.";
        expect(highlighted(text, [quote])).toEqual([
            "Ugovor se sklapa na\nodređeno vrijeme   od dvije",
        ]);
    });

    it("returns nothing when the quote is absent or trivially short", () => {
        expect(findQuoteRanges(text, ["Nema ovog citata ovdje"])).toEqual([]);
        expect(findQuoteRanges(text, ["a"])).toEqual([]);
        expect(findQuoteRanges(text, [])).toEqual([]);
    });

    it("merges overlapping hits from several quotes", () => {
        expect(
            highlighted(text, ["Ugovor se sklapa", "sklapa na određeno"]),
        ).toEqual(["Ugovor se sklapa na\nodređeno"]);
    });
});
