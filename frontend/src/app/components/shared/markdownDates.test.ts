import { describe, expect, it } from "vitest";
import { escapeLineStartDates } from "./markdownDates";

describe("escapeLineStartDates", () => {
    it("escapes a numeric date that opens a bullet item", () => {
        expect(escapeLineStartDates("- 1. 1. 2015. – Osnovni ugovor")).toBe(
            "- 1\\. 1. 2015. – Osnovni ugovor",
        );
    });

    it("escapes a date at the start of a line", () => {
        expect(escapeLineStartDates("17. 5. 2021. – Dodatak br. 1")).toBe(
            "17\\. 5. 2021. – Dodatak br. 1",
        );
    });

    it("escapes a date with a month name", () => {
        expect(escapeLineStartDates("1. siječnja 2026. stupio je na snagu")).toBe(
            "1\\. siječnja 2026. stupio je na snagu",
        );
    });

    it("escapes a date inside a numbered list item", () => {
        expect(escapeLineStartDates("3. 13. 2. 2023. – Dodatak br. 3")).toBe(
            "3. 13\\. 2. 2023. – Dodatak br. 3",
        );
    });

    it("works on every line of a multi-line answer", () => {
        const md = "Kronologija\n\n- 1. 1. 2015. – A\n- 14. 2. 2022. – B";
        expect(escapeLineStartDates(md)).toBe(
            "Kronologija\n\n- 1\\. 1. 2015. – A\n- 14\\. 2. 2022. – B",
        );
    });

    it("leaves genuine ordered lists alone", () => {
        const md = "1. Pravna osnova\n2. Rokovi\n10. 2026. je rok";
        expect(escapeLineStartDates(md)).toBe(md);
    });

    it("leaves dates in the middle of a sentence alone", () => {
        const md = "Ugovor je sklopljen 1. 1. 2015. u Puli.";
        expect(escapeLineStartDates(md)).toBe(md);
    });
});
