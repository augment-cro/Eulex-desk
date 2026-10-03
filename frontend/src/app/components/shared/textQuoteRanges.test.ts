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

    it("finds a cited passage in an e-mail's attachment page (#46)", () => {
        // /display serves an .eml/.msg as the text the model read: header
        // block, body, then `[Page N] Attachment k: …` pages.
        const email = [
            "[Page 1]",
            "From: Ivana Horvat <ivana@example.hr>",
            "Subject: Ugovor o zakupu",
            "",
            "Poštovani, u privitku je ugovor.",
            "",
            "[Page 2] Attachment 1: ugovor.pdf, page 1",
            "Članak 7. Zakupnina iznosi",
            "1.250,00 EUR mjesečno.",
        ].join("\n");
        expect(
            highlighted(email, ["Zakupnina iznosi 1.250,00 EUR mjesečno."]),
        ).toEqual(["Zakupnina iznosi\n1.250,00 EUR mjesečno."]);
    });

    it("finds a row/cell quote inside a spreadsheet attachment's markdown table", () => {
        const email = [
            "[Page 3] Attachment 2: rokovi.csv",
            "## Sheet: Sheet1",
            "| Row | A | B | C |",
            "| 2 | Idejni projekt | 30 dana | 10.000,00 |",
            "| 3 | Glavni projekt | 45 dana | 11.000,00 |",
        ].join("\n");
        expect(
            highlighted(email, ["Glavni projekt 45 dana 11.000,00"]),
        ).toEqual(["Glavni projekt | 45 dana | 11.000,00"]);
    });

    it("merges overlapping hits from several quotes", () => {
        expect(
            highlighted(text, ["Ugovor se sklapa", "sklapa na određeno"]),
        ).toEqual(["Ugovor se sklapa na\nodređeno"]);
    });
});
