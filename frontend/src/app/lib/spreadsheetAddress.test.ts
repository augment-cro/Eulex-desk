import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import hr from "../../../messages/hr.json";
import en from "../../../messages/en.json";
import {
    columnLettersToIndex,
    formatSheetCell,
    parseA1,
    parseA1Range,
} from "./spreadsheetAddress";
import {
    expandCitationToEntries,
    formatCitationLocation,
    type MikeCitationAnnotation,
} from "@/app/components/shared/types";

describe("A1 parsing", () => {
    it("maps column letters to 0-based indexes", () => {
        expect(columnLettersToIndex("A")).toBe(0);
        expect(columnLettersToIndex("z")).toBe(25);
        expect(columnLettersToIndex("AA")).toBe(26);
    });

    it("parses cells, absolute references and ranges", () => {
        expect(parseA1("B7")).toEqual({ r: 6, c: 1 });
        expect(parseA1("$B$7")).toEqual({ r: 6, c: 1 });
        expect(parseA1("B0")).toBeNull();
        expect(parseA1("7B")).toBeNull();
        expect(parseA1Range("C9:B7")).toEqual({ row: [6, 8], column: [1, 2] });
        expect(parseA1Range("A214")).toEqual({
            row: [213, 213],
            column: [0, 0],
        });
        expect(parseA1Range("A1:B2:C3")).toBeNull();
    });
});

describe("formatSheetCell", () => {
    it("writes Excel-style references", () => {
        expect(formatSheetCell("Ugovori", "c2")).toBe("Ugovori!C2");
        expect(formatSheetCell("Q3 Budget", "A1:B2")).toBe("'Q3 Budget'!A1:B2");
        expect(formatSheetCell("Tom's", "A1")).toBe("'Tom''s'!A1");
        expect(formatSheetCell(null, "A1")).toBe("A1");
        expect(formatSheetCell("Ugovori", null)).toBe("Ugovori");
    });
});

// The page label as the callers build it (common.pageShort).
const tHr = createTranslator({ locale: "hr", messages: hr, namespace: "common" });
const tEn = createTranslator({ locale: "en", messages: en, namespace: "common" });
const pageHr = (page: string) => tHr("pageShort", { page });
const pageEn = (page: string) => tEn("pageShort", { page });

describe("spreadsheet chat citations", () => {
    const base: MikeCitationAnnotation = {
        type: "citation_data",
        ref: 1,
        doc_id: "doc-1",
        document_id: "d1",
        filename: "Ugovori.xlsx",
        quote: "1,250,000.00",
    };

    it("expand to one sheet/cell entry and format as Sheet!Cell", () => {
        const a = { ...base, sheet: "Ugovori", cell: "C2", page: null };
        expect(expandCitationToEntries(a)).toEqual([
            { sheet: "Ugovori", cell: "C2", quote: "1,250,000.00" },
        ]);
        expect(formatCitationLocation(a, pageHr)).toBe("Ugovori!C2");
    });

    it("leave page citations unchanged", () => {
        expect(expandCitationToEntries({ ...base, page: 4 })).toEqual([
            { page: 4, quote: "1,250,000.00" },
        ]);
        expect(
            expandCitationToEntries({
                ...base,
                page: "41-42",
                quote: "prvi dio[[PAGE_BREAK]]drugi dio",
            }),
        ).toEqual([
            { page: 41, quote: "prvi dio" },
            { page: 42, quote: "drugi dio" },
        ]);
    });
});

describe("citation location label", () => {
    const base: MikeCitationAnnotation = {
        type: "citation_data",
        ref: 1,
        doc_id: "doc-1",
        document_id: "d1",
        filename: "Smjernice.pdf",
        quote: "...",
    };

    it("is localized: str. N in Croatian, p. N in English, ranges kept", () => {
        expect(formatCitationLocation({ ...base, page: 38 }, pageHr)).toBe("str. 38");
        expect(formatCitationLocation({ ...base, page: 38 }, pageEn)).toBe("p. 38");
        expect(formatCitationLocation({ ...base, page: "41-42" }, pageHr)).toBe(
            "str. 41-42",
        );
    });

    it("keeps the spreadsheet form and is empty when no page is named", () => {
        expect(
            formatCitationLocation({ ...base, sheet: "Q3 Budget", cell: "B2" }, pageEn),
        ).toBe("'Q3 Budget'!B2");
        expect(formatCitationLocation({ ...base, page: null }, pageHr)).toBe("");
        expect(formatCitationLocation(base, pageHr)).toBe("");
    });
});
