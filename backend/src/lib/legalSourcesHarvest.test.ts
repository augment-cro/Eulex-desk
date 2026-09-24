import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { harvestLegalSources, deriveActiveJurisdictions } from "./chatTools.js";

// Unit coverage for the multi-jurisdiction legal-source harvest (SI/DE scope
// widening) and the connector→jurisdiction labelling. Fixtures mirror the
// real payloads the eulex_endpoint MCP servers return (verified live against
// eulex-si-mcp for KZ-1 čl. 170).

const SI_SOURCE = {
    id: "@si/regulation/2008-01-2296/article/170. člen",
    scope: "@si",
    title: "KZ-1, 170. člen",
    document: {
        canonical_id: "2008-01-2296",
        title: "Kazenski zakonik (KZ-1)",
        title_short: "KZ-1",
        act_type: null,
        version_key: "2024-01-3416-2008-01-2296-npb13",
        label: "170. člen",
    },
    links: {
        pisrs: "https://pisrs.si/pregledPredpisa?sop=2008-01-2296",
        backend_fetch: "/api/v1/regulations/2008-01-2296/article/170. člen",
    },
    in_force: true,
    similarity: null,
    relation_type: null,
};

const DE_SOURCE = {
    id: "@de/regulation/bgb/article/§ 823",
    scope: "@de",
    title: "BGB, § 823",
    document: { canonical_id: "bgb", title: "Bürgerliches Gesetzbuch", label: "§ 823" },
    links: {
        gii: "https://www.gesetze-im-internet.de/bgb/__823.html",
        backend_fetch: "/api/v1/regulations/bgb/article/§ 823",
    },
    in_force: true,
};

describe("harvestLegalSources — SI/DE scopes (sources[] widening)", () => {
    it("accepts an @si source and maps the PISRS link + fetch path", () => {
        const out = harvestLegalSources({
            text: "",
            structured: { sources: [SI_SOURCE] },
        });
        assert.equal(out.length, 1);
        const s = out[0];
        assert.equal(s.scope, "@si");
        assert.equal(s.id, "@si/regulation/2008-01-2296/article/170. člen");
        assert.equal(s.title, "KZ-1, 170. člen");
        assert.equal(s.externalUrl, "https://pisrs.si/pregledPredpisa?sop=2008-01-2296");
        assert.equal(s.fetchPath, "/api/v1/regulations/2008-01-2296/article/170. člen");
        assert.equal(s.inForce, true);
        assert.equal(s.kind, "regulation");
    });

    it("accepts a @de source and maps the Gesetze-im-Internet link", () => {
        const out = harvestLegalSources({
            text: "",
            structured: { sources: [DE_SOURCE] },
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].scope, "@de");
        assert.equal(
            out[0].externalUrl,
            "https://www.gesetze-im-internet.de/bgb/__823.html",
        );
    });

    it("falls back to JSON-parsing the text when structuredContent is absent", () => {
        const out = harvestLegalSources({
            text: JSON.stringify({ sources: [SI_SOURCE] }),
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].scope, "@si");
    });

    it("still rejects unknown scopes and sources without an id", () => {
        const out = harvestLegalSources({
            text: "",
            structured: {
                sources: [
                    { ...SI_SOURCE, scope: "@xx" },
                    { ...SI_SOURCE, id: undefined },
                    { ...SI_SOURCE, scope: undefined },
                ],
            },
        });
        assert.equal(out.length, 0);
    });

    it("@hr regression: external_url wins and the segment snippet is paired", () => {
        const out = harvestLegalSources({
            text: "",
            structured: {
                results: undefined,
                segments: [{ segment_id: "seg-1", text: "Tekst članka 5." }],
                sources: [
                    {
                        id: "@hr/regulation/uuid-1/article/5",
                        scope: "@hr",
                        title: "Zakon o radu, čl. 5.",
                        document: { citation: "NN 93/14" },
                        match: { segment_id: "seg-1" },
                        links: { backend_fetch: "/api/v1/regulations/uuid-1/article/5" },
                        external_url: "https://narodne-novine.nn.hr/eli/...",
                        in_force: true,
                    },
                ],
            },
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].scope, "@hr");
        assert.equal(out[0].externalUrl, "https://narodne-novine.nn.hr/eli/...");
        assert.equal(out[0].snippet, "Tekst članka 5.");
    });

    it("@fr regression: links.legifrance still maps to externalUrl", () => {
        const out = harvestLegalSources({
            text: "",
            structured: {
                sources: [
                    {
                        id: "@fr/code/Code civil/article/1240",
                        scope: "@fr",
                        title: "Code civil, art. 1240",
                        document: {},
                        links: { legifrance: "https://www.legifrance.gouv.fr/x" },
                    },
                ],
            },
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].externalUrl, "https://www.legifrance.gouv.fr/x");
    });

    it("@eu regression: results with celex_id still mint @eu sources", () => {
        const out = harvestLegalSources({
            text: "",
            structured: {
                results: [
                    { celex_id: "32016R0679", title: "GDPR", article: "17" },
                ],
            },
        });
        assert.equal(out.length, 1);
        assert.equal(out[0].scope, "@eu");
        assert.equal(out[0].id, "@eu/celex/32016R0679#17");
    });
});

describe("deriveActiveJurisdictions — SI/DE connector labelling", () => {
    const label = (slug: string, name: string) =>
        deriveActiveJurisdictions([{ row: { slug, name } }]);

    it("sys-eulex-si → Slovenian law (not swallowed by the EU branch)", () => {
        const out = label("sys-eulex-si", "Slovenija");
        assert.equal(out.length, 1);
        assert.match(out[0], /^Slovenian law/);
    });

    it("sys-eulex-de → German law (not swallowed by the EU branch)", () => {
        const out = label("sys-eulex-de", "Njemačka");
        assert.equal(out.length, 1);
        assert.match(out[0], /^German law/);
    });

    it("a pure EULEX EU connector still labels as EU law", () => {
        const out = label("eulex", "EULEX");
        assert.equal(out.length, 1);
        assert.match(out[0], /^EU law/);
    });

    it("zakon-ai → Croatian law; web-search connectors are skipped", () => {
        const out = deriveActiveJurisdictions([
            { row: { slug: "sys-zakon-ai", name: "Hrvatska" } },
            { row: { slug: "tavily", name: "Search" } },
        ]);
        assert.equal(out.length, 1);
        assert.match(out[0], /^Croatian law/);
    });
});
