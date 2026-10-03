import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    CITATION_MARKER_RE,
    createQuoteMatcher,
    verifyQuote,
    verifyCitationMarkers,
} from "./quoteVerification";

const SOURCE = [
    "UGOVOR O NAJMU POSLOVNOG PROSTORA",
    "",
    "Članak 1.",
    "Najmodavac daje u najam poslovni prostor površine 120 m² koji se",
    "nalazi u Zagrebu, Ilica 5, a najmoprimac ga prima u najam i obvezuje",
    "se plaćati mjesečnu najamninu u iznosu od 1.500,00 EUR.",
    "",
    "Članak 2.",
    "Ugovor se sklapa na određeno vrijeme od pet godina, počevši od",
    "1. siječnja 2026. godine. Svaka ugovorna strana može otkazati ugovor",
    "uz otkazni rok od šest mjeseci.",
].join("\n");

describe("verifyQuote — exact match", () => {
    it("verifies a verbatim quote", () => {
        const loc = verifyQuote(
            "najmoprimac ga prima u najam i obvezuje",
            SOURCE,
        );
        assert.deepEqual(loc, { status: "verified" });
    });

    it("verifies a verbatim quote spanning a newline", () => {
        const loc = verifyQuote(
            "poslovni prostor površine 120 m² koji se\nnalazi u Zagrebu",
            SOURCE,
        );
        assert.deepEqual(loc, { status: "verified" });
    });
});

describe("verifyQuote — whitespace tolerance", () => {
    it("repairs a quote whose line break was collapsed to a space", () => {
        const loc = verifyQuote(
            "poslovni prostor površine 120 m² koji se nalazi u Zagrebu",
            SOURCE,
        );
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "poslovni prostor površine 120 m² koji se\nnalazi u Zagrebu",
        );
    });

    it("repairs doubled spaces and NBSP", () => {
        const loc = verifyQuote(
            "otkazni rok  od šest   mjeseci",
            SOURCE,
        );
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "otkazni rok od šest mjeseci",
        );
    });
});

describe("verifyQuote — case tolerance", () => {
    it("repairs a case-mangled quote with the source casing", () => {
        const loc = verifyQuote("ugovor o najmu POSLOVNOG prostora", SOURCE);
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "UGOVOR O NAJMU POSLOVNOG PROSTORA",
        );
    });
});

describe("verifyQuote — diacritic tolerance", () => {
    it("repairs a quote typed without Croatian diacritics", () => {
        const loc = verifyQuote("placati mjesecnu najamninu", SOURCE);
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "plaćati mjesečnu najamninu",
        );
    });

    it("matches when the SOURCE has no diacritics but the quote does", () => {
        const loc = verifyQuote("časni čovjek", "On je castan... casni covjek u svemu.");
        assert.equal(loc.status, "repaired");
        assert.equal((loc as { exact: string }).exact, "casni covjek");
    });
});

describe("verifyQuote — ellipsis-elided quotes", () => {
    it("locates ordered fragments and rejoins with the exact texts", () => {
        const loc = verifyQuote(
            "Najmodavac daje u najam … otkazni rok od šest mjeseci",
            SOURCE,
        );
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "Najmodavac daje u najam … otkazni rok od šest mjeseci",
        );
    });

    it("flags the quote when one fragment does not exist", () => {
        const loc = verifyQuote(
            "Najmodavac daje u najam ... kaucija od tri najamnine",
            SOURCE,
        );
        assert.deepEqual(loc, { status: "unverified" });
    });

    it("flags fragments that only occur out of order (not 'repaired')", () => {
        const loc = verifyQuote(
            "otkazni rok od šest mjeseci … Najmodavac daje u najam",
            SOURCE,
        );
        assert.deepEqual(loc, { status: "unverified" });
    });
});

describe("verifyQuote — [[PAGE_BREAK]] quotes spanning two pages", () => {
    const PAGED = [
        "[Page 41]",
        "Section 4.2 describes the procedure",
        "Stranica 41 od 90",
        "",
        "[Page 42]",
        "in all material respects. The parties agree otherwise.",
    ].join("\n");

    it("verifies verbatim sides across the page marker and footer", () => {
        const loc = verifyQuote(
            "Section 4.2 describes the procedure [[PAGE_BREAK]] in all material respects.",
            PAGED,
        );
        assert.deepEqual(loc, { status: "verified" });
    });

    it("repairs a tolerant hit and keeps the sentinel in the exact text", () => {
        const loc = verifyQuote(
            "section 4.2 describes  the procedure [[page_break]] IN ALL material respects.",
            PAGED,
        );
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "Section 4.2 describes the procedure [[PAGE_BREAK]] in all material respects.",
        );
    });

    it("flags sides in the wrong order", () => {
        const loc = verifyQuote(
            "in all material respects. [[PAGE_BREAK]] Section 4.2 describes the procedure",
            PAGED,
        );
        assert.deepEqual(loc, { status: "unverified" });
    });

    it("flags sides that are too far apart to be one sentence", () => {
        const far = [
            "Section 4.2 describes the procedure",
            "filler ".repeat(1_000),
            "in all material respects.",
        ].join("\n");
        const loc = verifyQuote(
            "Section 4.2 describes the procedure [[PAGE_BREAK]] in all material respects.",
            far,
        );
        assert.deepEqual(loc, { status: "unverified" });
    });
});

describe("verifyQuote — no match / empty", () => {
    it("flags an invented quote", () => {
        const loc = verifyQuote(
            "najmoprimac plaća kauciju u iznosu tri najamnine",
            SOURCE,
        );
        assert.deepEqual(loc, { status: "unverified" });
    });

    it("flags an empty quote", () => {
        assert.deepEqual(verifyQuote("", SOURCE), { status: "unverified" });
    });

    it("flags a whitespace-only quote", () => {
        assert.deepEqual(verifyQuote("  \n\t ", SOURCE), {
            status: "unverified",
        });
    });

    it("flags any quote against empty source text", () => {
        assert.deepEqual(verifyQuote("bilo što", ""), {
            status: "unverified",
        });
    });
});

describe("verifyQuote — typographic punctuation folding", () => {
    it("matches straight quotes against curly source quotes", () => {
        const src = "Stranka je izjavila: “ne pristajem” na uvjete.";
        const loc = verifyQuote('izjavila: "ne pristajem"', src);
        assert.equal(loc.status, "repaired");
        assert.equal(
            (loc as { exact: string }).exact,
            "izjavila: “ne pristajem”",
        );
    });
});

describe("createQuoteMatcher — reuse across quotes", () => {
    it("locates multiple quotes with one matcher", () => {
        const m = createQuoteMatcher(SOURCE);
        assert.equal(m.locate("Članak 1.").status, "verified");
        assert.equal(m.locate("clanak 2.").status, "repaired");
        assert.equal(m.locate("nepostojeći tekst").status, "unverified");
    });
});

describe("verifyCitationMarkers — tabular [[page:N||quote:…]] markers", () => {
    it("keeps a verified marker byte-identical", () => {
        const text = "Rok je ugovoren [[page:2||quote:otkazni rok od šest mjeseci]].";
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers(text, m);
        assert.equal(out.text, text);
        assert.deepEqual(out.statuses, ["verified"]);
    });

    it("rewrites a repaired marker with the exact source text", () => {
        const text =
            "Obveza plaćanja [[page:1||quote:placati mjesecnu najamninu]] postoji.";
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers(text, m);
        assert.equal(
            out.text,
            "Obveza plaćanja [[page:1||quote:plaćati mjesečnu najamninu]] postoji.",
        );
        assert.deepEqual(out.statuses, ["repaired"]);
    });

    it("leaves an unverified marker untouched and flags it", () => {
        const text = "Kaucija [[page:3||quote:kaucija od tri najamnine]] ugovorena.";
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers(text, m);
        assert.equal(out.text, text);
        assert.deepEqual(out.statuses, ["unverified"]);
    });

    it("handles several markers in frontend badge order", () => {
        const text =
            "[[page:1||quote:Najmodavac daje u najam]] i " +
            "[[page:2||quote:ugovor se sklapa na odredeno vrijeme]] te " +
            "[[page:9||quote:izmišljeni citat]]";
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers(text, m);
        assert.deepEqual(out.statuses, ["verified", "repaired", "unverified"]);
        assert.ok(
            out.text.includes("[[page:2||quote:Ugovor se sklapa na određeno vrijeme]]"),
        );
        assert.ok(out.text.includes("[[page:9||quote:izmišljeni citat]]"));
    });

    it("tolerates the quote: prefix being absent (frontend regex parity)", () => {
        const text = "Vidi [[page:1||Najmodavac daje u najam]].";
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers(text, m);
        assert.deepEqual(out.statuses, ["verified"]);
        assert.equal(out.text, text);
    });

    it("returns no statuses for text without markers", () => {
        const m = createQuoteMatcher(SOURCE);
        const out = verifyCitationMarkers("Obična rečenica.", m);
        assert.equal(out.text, "Obična rečenica.");
        assert.deepEqual(out.statuses, []);
    });
});

// ---------------------------------------------------------------------------
// Spreadsheets: sheet + cell citations
// ---------------------------------------------------------------------------

const WORKBOOK = [
    "## Sheet: Ugovori",
    'Hidden rows: 3 · Comments: C2 "Provjeriti s klijentom"',
    "",
    "| Row | A | B | C |",
    "| --- | --- | --- | --- |",
    "| 1 | Ugovorna strana | Datum | Iznos (EUR) |",
    "| 2 | Alfa d.o.o. | 14.05.2023. | 1,250,000.00 |",
    "| 3 | ALFA D.O.O. |  | 300.00 |",
    "| 214 | Ukupno ⟨merged A214:B214⟩ |  | 18,402,113.50 |",
    "",
    "## Sheet: Interno (hidden)",
    "",
    "| Row | A |",
    "| --- | --- |",
    "| 1 | Tajna \\| napomena |",
].join("\n");

describe("CITATION_MARKER_RE — both tabular forms in one pattern", () => {
    it("matches page and sheet markers in document order with fixed groups", () => {
        const text =
            "A [[page:3||quote:prvi]] B [[sheet:Ugovori||cell:C2||quote:1,250,000.00]] " +
            "C [[sheet:Moj list||cell:a214:b214||quote:Ukupno]] D [[page:7||drugi]]";
        CITATION_MARKER_RE.lastIndex = 0;
        const matches = [...text.matchAll(CITATION_MARKER_RE)].map((m) => [
            m[1], m[2], m[3], m[4],
        ]);
        assert.deepEqual(matches, [
            ["3", undefined, undefined, "prvi"],
            [undefined, "Ugovori", "C2", "1,250,000.00"],
            [undefined, "Moj list", "a214:b214", "Ukupno"],
            ["7", undefined, undefined, "drugi"],
        ]);
    });

    it("does not treat tags or a malformed cell as citations", () => {
        CITATION_MARKER_RE.lastIndex = 0;
        assert.equal(
            [..."[[Yes]] [[sheet:S||cell:Row 2||quote:x]] [[USD]]".matchAll(CITATION_MARKER_RE)].length,
            0,
        );
    });
});

describe("createQuoteMatcher.locateInCell — the cited cell first", () => {
    const m = createQuoteMatcher(WORKBOOK);

    it("verifies a quote that is the cell's value", () => {
        assert.deepEqual(m.locateInCell("Ugovori", "C2", "1,250,000.00"), { status: "verified" });
    });

    it("repairs from the CITED cell, not the first match in the text", () => {
        // Whole-text search would repair to "Alfa d.o.o." (row 2); the
        // model cited A3, whose text is "ALFA D.O.O.".
        const loc = m.locateInCell("Ugovori", "A3", "alfa d.o.o.");
        assert.deepEqual(loc, { status: "repaired", exact: "ALFA D.O.O." });
        assert.deepEqual(m.locate("alfa d.o.o."), { status: "repaired", exact: "Alfa d.o.o." });
    });

    it("reads a merged range whole and a covered cell as its anchor", () => {
        assert.equal(m.locateInCell("Ugovori", "A214:B214", "Ukupno").status, "verified");
        assert.equal(m.locateInCell("Ugovori", "B214", "Ukupno").status, "verified");
    });

    it("unescapes table pipes and accepts a hidden sheet by its bare name", () => {
        assert.equal(m.locateInCell("Interno", "A1", "Tajna | napomena").status, "verified");
    });

    it("falls back to the whole text when the cell does not hold the quote", () => {
        assert.equal(m.locateInCell("Ugovori", "B2", "Alfa d.o.o.").status, "verified");
        assert.equal(m.locateInCell("Nepostojeći", "A1", "Ukupno").status, "verified");
        assert.equal(m.locateInCell("Ugovori", "C2", "999,999.00").status, "unverified");
    });
});

describe("verifyCitationMarkers — sheet markers", () => {
    it("verifies, repairs from the cell and flags, keeping the sheet form", () => {
        const text =
            "Iznos [[sheet:Ugovori||cell:C2||quote:1,250,000.00]], " +
            "strana [[sheet:Ugovori||cell:A3||quote:alfa d.o.o.]], " +
            "izmišljeno [[sheet:Ugovori||cell:C9||quote:7,000.00]] i " +
            "[[page:1||quote:Ugovorna strana]]";
        const out = verifyCitationMarkers(text, createQuoteMatcher(WORKBOOK));
        assert.deepEqual(out.statuses, ["verified", "repaired", "unverified", "verified"]);
        assert.ok(out.text.includes("[[sheet:Ugovori||cell:A3||quote:ALFA D.O.O.]]"));
        assert.ok(out.text.includes("[[sheet:Ugovori||cell:C9||quote:7,000.00]]"));
        assert.ok(out.text.includes("[[page:1||quote:Ugovorna strana]]"));
    });
});
