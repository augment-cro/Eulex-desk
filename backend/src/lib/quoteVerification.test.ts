import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
