import { test } from "node:test";
import assert from "node:assert/strict";
import {
    bridgeNarodneNovineUrl,
    findNnBridgeServer,
    nnRefFromUrl,
    normalizeTitle,
} from "./nnBridge";
import type { LoadedMcpServer } from "../mcp/types";

test("nnRefFromUrl — article page, full page and ELI shapes", () => {
    assert.deepEqual(
        nnRefFromUrl("https://narodne-novine.nn.hr/clanci/sluzbeni/2026_09_101_1212.html"),
        { year: "2026", issue: "101", doc: "1212", nnRef: "2026/101/1212" },
    );
    assert.equal(
        nnRefFromUrl("https://narodne-novine.nn.hr/clanci/sluzbeni/full/2026_09_101_1212.html")?.nnRef,
        "2026/101/1212",
    );
    assert.equal(
        nnRefFromUrl("https://narodne-novine.nn.hr/eli/sluzbeni/2026/101/1212")?.nnRef,
        "2026/101/1212",
    );
    assert.equal(
        nnRefFromUrl("https://narodne-novine.nn.hr/eli/sluzbeni/2025/40/540/hrv/html")?.nnRef,
        "2025/40/540",
    );
});

test("nnRefFromUrl — anything else is null", () => {
    for (const u of [
        "https://narodne-novine.nn.hr/search.aspx",
        "https://narodne-novine.nn.hr/eli/sluzbeni/2026/101/pdf",
        "https://example.com/clanci/sluzbeni/2026_09_101_1212.html",
        "https://narodne-novine.nn.hr.evil.example/clanci/sluzbeni/2026_09_101_1212.html",
        "not a url",
    ]) {
        assert.equal(nnRefFromUrl(u), null, u);
    }
});

test("normalizeTitle — case, punctuation and whitespace insensitive", () => {
    assert.equal(
        normalizeTitle("Odluku o isticanju dodatne cijene  kao mjera izravne kontrole cijena."),
        normalizeTitle("ODLUKU O ISTICANJU DODATNE CIJENE KAO MJERA IZRAVNE KONTROLE CIJENA"),
    );
});

type Call = { tool: string; args: Record<string, unknown> };

function fakeServer(
    slug: string,
    tools: string[],
    reply: (tool: string, args: Record<string, unknown>) => unknown,
    calls: Call[] = [],
): LoadedMcpServer {
    return {
        row: { slug, name: slug } as LoadedMcpServer["row"],
        tools: [],
        toolNameMap: new Map(tools.map((t) => [`mcp__${slug}__${t}`, t])),
        client: {
            callTool: async () => "",
            callToolRich: async (tool, args) => {
                calls.push({ tool, args });
                const out = reply(tool, args);
                if (out instanceof Error) throw out;
                return { text: JSON.stringify(out), structured: out };
            },
            close: async () => {},
        },
    };
}

const PUBLICATION = {
    total: 1,
    items: [
        {
            id: "71ce8a3d-228c-4dec-8eef-5fdcbf8b82cb",
            title: "Odluku o isticanju dodatne cijene kao mjera izravne kontrole cijena",
            nn_reference: "NN 101/2026-1212",
            eli_url: "https://narodne-novine.nn.hr/eli/sluzbeni/2026/101/1212",
        },
    ],
};
const RESOLVED = {
    matches: [
        {
            uri: "@hr/regulation/114c21bf-8366-4074-b272-26fee99da3ee",
            title: "Odluku o isticanju dodatne cijene kao mjera izravne kontrole cijena",
            in_force: false,
            similarity: 0.93,
        },
        {
            uri: "@hr/regulation/956b561c-ae8c-4802-88ff-ffa081767adc",
            title: "Odluka o objavi cjenika i isticanju dodatne cijene kao mjera izravne kontrole cijena u trgovini na malo",
            in_force: true,
            similarity: 0.67,
        },
    ],
};
const NN_URL = "https://narodne-novine.nn.hr/clanci/sluzbeni/2026_09_101_1212.html";

test("findNnBridgeServer — built-in eulex first, legal servers only", () => {
    const drive = fakeServer("google-drive", ["find_publication", "resolve"], () => ({}));
    const fr = fakeServer("sys-eulex-fr", ["find_publication", "resolve"], () => ({}));
    const hr = fakeServer("sys-eulex", ["find_publication", "resolve"], () => ({}));
    const partial = fakeServer("zakon-hr", ["resolve"], () => ({}));
    assert.equal(findNnBridgeServer([drive, fr, hr, partial]), hr);
    assert.equal(findNnBridgeServer([drive, fr]), fr);
    assert.equal(findNnBridgeServer([drive, partial]), null);
});

test("bridge — NN URL resolves to the regulation source + a note for the model", async () => {
    const calls: Call[] = [];
    const server = fakeServer(
        "sys-eulex",
        ["find_publication", "resolve"],
        (tool) => (tool === "find_publication" ? PUBLICATION : RESOLVED),
        calls,
    );
    const r = await bridgeNarodneNovineUrl(NN_URL, { servers: [server] });
    assert.deepEqual(
        calls.map((c) => [c.tool, c.args]),
        [
            ["find_publication", { scope: "@hr", nn_ref: "2026/101/1212" }],
            ["resolve", { query: PUBLICATION.items[0].title, scope: "@hr", top_k: 5 }],
        ],
    );
    assert.equal(r.sources.length, 1);
    const s = r.sources[0];
    assert.equal(s.id, "@hr/regulation/114c21bf-8366-4074-b272-26fee99da3ee");
    assert.equal(s.fetchPath, "/api/v1/regulations/114c21bf-8366-4074-b272-26fee99da3ee");
    assert.equal(s.title, PUBLICATION.items[0].title);
    assert.equal(s.citation, "NN 101/2026-1212");
    assert.equal(s.externalUrl, "https://narodne-novine.nn.hr/eli/sluzbeni/2026/101/1212");
    assert.equal(s.articleLabel, null);
    assert.equal(s.inForce, false);
    assert.match(r.note ?? "", /Corpus match/);
    assert.match(r.note ?? "", /NN 101\/2026-1212/);
    assert.match(r.note ?? "", /fetch each such article/);
});

test("bridge — no exact regulation title → publication-only source (no panel path)", async () => {
    const server = fakeServer(
        "sys-eulex",
        ["find_publication", "resolve"],
        (tool) =>
            tool === "find_publication"
                ? PUBLICATION
                : { matches: [RESOLVED.matches[1]] },
    );
    const r = await bridgeNarodneNovineUrl(NN_URL, { servers: [server] });
    assert.equal(r.sources.length, 1);
    assert.equal(r.sources[0].id, "@hr/publication/71ce8a3d-228c-4dec-8eef-5fdcbf8b82cb");
    assert.equal(r.sources[0].fetchPath, null);
    assert.ok(r.note);
});

test("bridge — publication not in corpus → nothing", async () => {
    const server = fakeServer("sys-eulex", ["find_publication", "resolve"], (tool) =>
        tool === "find_publication" ? { total: 0, items: [] } : RESOLVED,
    );
    assert.deepEqual(await bridgeNarodneNovineUrl(NN_URL, { servers: [server] }), {
        sources: [],
        note: null,
    });
});

test("bridge — non-NN URL, no server, or a throwing server → nothing", async () => {
    const server = fakeServer("sys-eulex", ["find_publication", "resolve"], () => new Error("boom"));
    assert.deepEqual(
        await bridgeNarodneNovineUrl("https://example.com/x.pdf", { servers: [server] }),
        { sources: [], note: null },
    );
    assert.deepEqual(await bridgeNarodneNovineUrl(NN_URL, { servers: [] }), {
        sources: [],
        note: null,
    });
    assert.deepEqual(await bridgeNarodneNovineUrl(NN_URL, { servers: [server] }), {
        sources: [],
        note: null,
    });
});

test("bridge — out-of-scope document under an active context → nothing", async () => {
    const server = fakeServer("sys-eulex", ["find_publication", "resolve"], (tool) =>
        tool === "find_publication" ? PUBLICATION : RESOLVED,
    );
    const r = await bridgeNarodneNovineUrl(NN_URL, {
        servers: [server],
        whitelist: new Set(["00000000-0000-0000-0000-000000000000"]),
    });
    assert.deepEqual(r, { sources: [], note: null });
});
