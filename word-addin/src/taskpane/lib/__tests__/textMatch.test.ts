import { describe, it, expect } from "vitest";
import {
    normalizeForMatch,
    hasAmbiguousChars,
    toWordWildcardQuery,
    scoreContextMatch,
    splitParagraphs,
    clip,
} from "../textMatch";

// Build typographic inputs from code points so this test file stays pure
// ASCII (no invisible / look-alike glyphs in source).
const LSQUO = String.fromCodePoint(0x2018); // '
const RSQUO = String.fromCodePoint(0x2019); // '
const LDQUO = String.fromCodePoint(0x201c); // "
const RDQUO = String.fromCodePoint(0x201d); // "
const NBSP = String.fromCodePoint(0x00a0);
const ENDASH = String.fromCodePoint(0x2013); // -
const EMDASH = String.fromCodePoint(0x2014); // -

describe("normalizeForMatch", () => {
    it("straightens curly single and double quotes", () => {
        expect(normalizeForMatch(`${LDQUO}hi${RDQUO} ${LSQUO}x${RSQUO}`)).toBe(
            `"hi" 'x'`,
        );
    });

    it("folds dashes to hyphen and exotic spaces to a normal space", () => {
        expect(normalizeForMatch(`a${ENDASH}b${EMDASH}c`)).toBe("a-b-c");
        expect(normalizeForMatch(`x${NBSP}y`)).toBe("x y");
    });

    it("collapses whitespace runs and trims", () => {
        expect(normalizeForMatch("  a   b \t c  ")).toBe("a b c");
    });

    it("is null/empty safe", () => {
        expect(normalizeForMatch("")).toBe("");
    });
});

describe("hasAmbiguousChars", () => {
    it("detects curly quotes, dashes, nbsp and ASCII quotes/apostrophes", () => {
        expect(hasAmbiguousChars(RSQUO)).toBe(true);
        expect(hasAmbiguousChars(`a${ENDASH}b`)).toBe(true);
        expect(hasAmbiguousChars(`a${NBSP}b`)).toBe(true);
        expect(hasAmbiguousChars("it's")).toBe(true);
    });

    it("is false for plain alphanumerics and ordinary spaces", () => {
        expect(hasAmbiguousChars("plain text 123")).toBe(false);
    });
});

describe("toWordWildcardQuery", () => {
    it("returns null when there is nothing ambiguous to bridge", () => {
        expect(toWordWildcardQuery("plain text")).toBeNull();
    });

    it("turns an ASCII apostrophe into ? so it matches a curly one", () => {
        expect(toWordWildcardQuery("it's here")).toBe("it?s here");
    });

    it("turns curly quotes and dashes into ?", () => {
        expect(toWordWildcardQuery(`${LDQUO}hi${RDQUO}`)).toBe("?hi?");
        expect(toWordWildcardQuery(`a${EMDASH}b`)).toBe("a?b");
    });

    it("escapes wildcard metacharacters in the literal remainder", () => {
        // Parens are wildcard operators; the apostrophe forces wildcard mode.
        expect(toWordWildcardQuery("a (b)'c")).toBe("a \\(b\\)?c");
    });

    it("returns null when the text contains a caret (unsafe to escape)", () => {
        expect(toWordWildcardQuery("a^b's")).toBeNull();
    });

    it("leaves ordinary spaces literal", () => {
        expect(toWordWildcardQuery("a's b")).toBe("a?s b");
    });
});

describe("scoreContextMatch", () => {
    const para =
        "The parties agree that the price shall be fixed for the term.";

    it("returns 0 without a hint", () => {
        expect(scoreContextMatch(para, undefined)).toBe(0);
    });

    it("scores > 0 when contextBefore is present in the paragraph", () => {
        expect(
            scoreContextMatch(para, { contextBefore: "parties agree that the" }),
        ).toBeGreaterThan(0);
    });

    it("returns 0 when the context is not in the paragraph", () => {
        expect(
            scoreContextMatch(para, { contextBefore: "zzz nonexistent qqq" }),
        ).toBe(0);
    });

    it("is quote-insensitive on the context", () => {
        const curlyPara = `He said ${LDQUO}the price${RDQUO} is fixed.`;
        expect(
            scoreContextMatch(curlyPara, { contextAfter: `"the price" is` }),
        ).toBeGreaterThan(0);
    });
});

describe("splitParagraphs / clip", () => {
    it("splits on newlines and drops lines shorter than 6 chars", () => {
        expect(splitParagraphs("hello world\n\nx\nsecond line")).toEqual([
            "hello world",
            "second line",
        ]);
    });

    it("clip truncates to n and is a no-op when already short", () => {
        expect(clip("abcdef", 3)).toBe("abc");
        expect(clip("ab", 3)).toBe("ab");
    });
});
