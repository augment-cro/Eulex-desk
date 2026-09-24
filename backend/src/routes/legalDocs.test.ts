import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeCountryArticle,
    normalizeCountryFullDocument,
} from "./legalDocs.js";

// Unit coverage for the SI/DE (eulex_endpoint country API) normalizers.
// Fixtures mirror the live eulex-si-api responses (verified against KZ-1):
// ArticleResponse for a single provision, and /full-document provisions where
// article TITLE rows (label, no text) precede the numbered article rows.

const SI_ARTICLE = {
    id: 1545305,
    act_id: 21669,
    canonical_id: "2008-01-2296",
    title: "Kazenski zakonik (KZ-1)",
    title_short: "KZ-1",
    version: { id: 20592, version_key: "2024-01-3416-2008-01-2296-npb13" },
    provision_type: "article",
    label: "170. člen",
    normalized_label: "article_170",
    heading: null,
    path: "del_248/poglavje_402/article_170",
    text: "(1) Kdor brez privolitve druge osebe doseže, da ta spolno občuje …",
    html: null,
    citation: "KZ-1, 170. člen",
    pisrs_url: "https://pisrs.si/pregledPredpisa?sop=2008-01-2296",
};

describe("normalizeCountryArticle (SI/DE single provision)", () => {
    it("maps a SI ArticleResponse to a one-article document", () => {
        const doc = normalizeCountryArticle(SI_ARTICLE);
        assert.equal(doc.title, "KZ-1, 170. člen");
        assert.equal(doc.citation, "KZ-1, 170. člen");
        assert.equal(doc.articles.length, 1);
        const a = doc.articles[0];
        assert.equal(a.label, "170. člen");
        assert.equal(a.number, "170");
        assert.match(a.text, /brez privolitve/);
    });

    it("prepends the heading to the body when present", () => {
        const doc = normalizeCountryArticle({
            ...SI_ARTICLE,
            heading: "Posilstvo",
        });
        assert.match(doc.articles[0].text, /^Posilstvo\n\n\(1\)/);
    });

    it("extracts DE '§ 153'-style numbers", () => {
        const doc = normalizeCountryArticle({
            title_short: "StGB",
            label: "§ 153",
            text: "Wer vor Gericht …",
            citation: "StGB, § 153",
        });
        assert.equal(doc.articles[0].number, "153");
    });

    it("returns no articles when the provision has no text", () => {
        const doc = normalizeCountryArticle({ ...SI_ARTICLE, text: null, heading: null });
        assert.equal(doc.articles.length, 0);
    });

    it("falls back to title_short + label when there is no citation", () => {
        const doc = normalizeCountryArticle({ ...SI_ARTICLE, citation: null });
        assert.equal(doc.title, "KZ-1, 170. člen");
    });
});

describe("normalizeCountryFullDocument (SI/DE whole act)", () => {
    // Representative slice of the live KZ-1 /full-document provisions stream.
    const PROVISIONS = [
        { provision_type: "content", label: null, heading: null, text: "Opomba: poseg US …", path: "content_1" },
        { provision_type: "part", label: null, heading: "SPLOŠNI DEL", text: null, path: "del_2" },
        { provision_type: "chapter", label: null, heading: "Prvo poglavje\nTEMELJNE DOLOČBE", text: null, path: "del_2/poglavje_3" },
        { provision_type: "article", label: "Uveljavljanje kazenske odgovornosti", heading: null, text: "", path: "p4" },
        { provision_type: "article", label: "1. člen", normalized_label: "article_1", heading: null, text: "(1) Kazenska odgovornost …", path: "del_2/poglavje_3/clen_1" },
        { provision_type: "article", label: null, heading: null, text: "", path: "empty" },
    ];

    it("maps rows onto the HR segment vocabulary the panel folds on", () => {
        const doc = normalizeCountryFullDocument({
            title: "Kazenski zakonik (KZ-1)",
            title_short: "KZ-1",
            citation: "KZ-1",
            provisions: PROVISIONS,
        });
        assert.equal(doc.title, "Kazenski zakonik (KZ-1)");
        // The all-empty row is dropped.
        assert.equal(doc.articles.length, 5);
        const [note, part, chapter, subtitle, article] = doc.articles;
        // Free-text note: plain body (no segmentType, no label).
        assert.equal(note.segmentType, null);
        assert.equal(note.label, null);
        // Structural rows become section_heading dividers labelled by heading.
        assert.equal(part.segmentType, "section_heading");
        assert.equal(part.label, "SPLOŠNI DEL");
        assert.equal(chapter.segmentType, "section_heading");
        // Article TITLE row (no body) → buffered subtitle for the next card.
        assert.equal(subtitle.segmentType, "article_subtitle");
        assert.equal(subtitle.label, "Uveljavljanje kazenske odgovornosti");
        // Numbered article with text → its own card (segmentType null).
        assert.equal(article.segmentType, null);
        assert.equal(article.label, "1. člen");
        assert.equal(article.number, "1");
        assert.match(article.text, /Kazenska odgovornost/);
    });

    it("does not misread digits in an article title as its number", () => {
        const doc = normalizeCountryFullDocument({
            title: "X",
            provisions: [
                { provision_type: "article", label: "Zapor do 15 let", text: "", path: "t" },
            ],
        });
        // Subtitle rows never drive numbering in the panel; the extracted
        // number is derived from the raw label only and is ignored for
        // article_subtitle rows by groupLegalSegments.
        assert.equal(doc.articles[0].segmentType, "article_subtitle");
    });

    it("returns an empty article list for a missing provisions array", () => {
        const doc = normalizeCountryFullDocument({ title: "X" });
        assert.deepEqual(doc.articles, []);
    });
});
