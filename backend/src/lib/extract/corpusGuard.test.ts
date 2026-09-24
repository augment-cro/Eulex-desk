import assert from "node:assert/strict";
import { test } from "node:test";

import { celexFromUrl, corpusOwnedUrlNotice, looksLikePdfUrl } from "./index";

test("refuses EUR-Lex and CURIA URLs in every shape they arrive in", () => {
    for (const url of [
        "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32026R1392",
        "https://eur-lex.europa.eu/legal-content/HR/TXT/HTML/?uri=CELEX:32016R0679",
        "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
        "https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32016R0679",
        "https://www.eur-lex.europa.eu/homepage.html",
        "https://curia.europa.eu/juris/document/document.jsf?docid=123456",
    ]) {
        const notice = corpusOwnedUrlNotice(url);
        assert.ok(notice, `expected a refusal for ${url}`);
        assert.match(notice, /legal source tools/);
    }
});

test("names the CELEX id when the URL carries one", () => {
    assert.match(
        corpusOwnedUrlNotice(
            "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32026R1392",
        )!,
        /CELEX 32026R1392/,
    );
    assert.equal(
        celexFromUrl("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:32016r0679"),
        "32016R0679",
    );
    assert.equal(celexFromUrl("https://eur-lex.europa.eu/eli/reg/2016/679/oj"), null);
});

test("leaves every other source extractable", () => {
    for (const url of [
        "https://narodne-novine.nn.hr/clanci/sluzbeni/2023_01_1_1.html",
        "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006419285",
        "https://example.com/report.pdf",
        // lookalike host must not be caught by the suffix match
        "https://eur-lex.europa.eu.evil.example/legal-content/EN/TXT/?uri=CELEX:1",
        "not a url",
    ]) {
        assert.equal(corpusOwnedUrlNotice(url), null, url);
    }
});

test("PDF detection is unchanged", () => {
    assert.equal(looksLikePdfUrl("https://example.com/doc.pdf"), true);
    assert.equal(looksLikePdfUrl("https://example.com/doc.html"), false);
});
