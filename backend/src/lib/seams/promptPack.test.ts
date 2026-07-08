import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
    getPromptPack,
    getPromptPackVersion,
    getPromptBlocks,
    getWorkflowPacks,
    refreshPromptPack,
    GENERIC_PROMPT_BLOCKS,
    __resetPromptPackForTests,
} from "./promptPack.js";

// NON-proprietary fixture pack — fake block texts only. The real pack lives
// in the private governance repo; it must never be committed here.
const FIXTURE_PACK = {
    version: 7,
    blocks: {
        method: "FIXTURE METHOD BLOCK",
        citations_legal: "FIXTURE CITATIONS BLOCK",
        grounding: "\n\n---\nFIXTURE GROUNDING 1. {{GROUNDING_POINT_1}}\n---\n",
        grounding_point1_eulex: "FIXTURE EULEX BRANCH",
        grounding_point1_generic: "FIXTURE GENERIC BRANCH",
        jurisdictions: "\n\n---\nFIXTURE JURISDICTIONS: {{ACTIVE_JURISDICTIONS}}\n---\n",
        layered_research: "\n\n---\nFIXTURE LAYERED\n---\n",
        topic_routing: "\n\n---\nFIXTURE ROUTING\n---\n",
        locale_legal: { hr: "FIXTURE HR LEGAL", en: "FIXTURE EN LEGAL" },
    },
    workflow_packs: [{ id: "builtin-fixture", title: "Fixture WF", prompt_md: "## Fixture" }],
    enrichment_prompt: "FIXTURE ENRICH {{SOURCES}}{{DOC_CONTEXT}}\n{{LOCALE_RULE}}",
};

const servers: http.Server[] = [];
let requests: { etagHeader?: string; auth?: string }[] = [];
let serveMode: "ok" | "fail" | "not-modified-when-matched" = "ok";
let servedEtag = '"pack-v7"';

function startStub(): Promise<string> {
    const server = http.createServer((req, res) => {
        requests.push({
            etagHeader: req.headers["if-none-match"] as string | undefined,
            auth: req.headers.authorization,
        });
        if (serveMode === "fail") {
            res.statusCode = 503;
            res.end("{}");
            return;
        }
        if (
            serveMode === "not-modified-when-matched" &&
            req.headers["if-none-match"] === servedEtag
        ) {
            res.statusCode = 304;
            res.end();
            return;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("etag", servedEtag);
        res.end(JSON.stringify(FIXTURE_PACK));
    });
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

describe("promptPack client", () => {
    beforeEach(() => {
        delete process.env.GOVERNANCE_URL;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        __resetPromptPackForTests();
        requests = [];
        serveMode = "ok";
    });
    after(() => {
        for (const server of servers) server.close();
        __resetPromptPackForTests();
    });

    it("is null and makes ZERO network calls without GOVERNANCE_URL (standalone-core rule)", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw new Error("seam network call attempted with GOVERNANCE_URL unset");
        }) as typeof fetch;
        try {
            await refreshPromptPack();
            assert.equal(getPromptPack(), null);
            assert.equal(getPromptPackVersion(), null);
            assert.equal(fetchCalls, 0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("serves the generic fallback blocks and no workflow packs without a pack", () => {
        assert.equal(getPromptBlocks(), GENERIC_PROMPT_BLOCKS);
        assert.deepEqual(getWorkflowPacks(), []);
        // The fallback carries the placeholder the assembly substitutes.
        assert.ok(GENERIC_PROMPT_BLOCKS.jurisdictions.includes("{{ACTIVE_JURISDICTIONS}}"));
    });

    it("fetches, caches, and exposes the pack + version, sending identity when configured", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        process.env.GOVERNANCE_SERVICE_SECRET = "g-secret";
        await refreshPromptPack();
        assert.equal(getPromptPackVersion(), 7);
        assert.equal(getPromptPack()?.blocks.method, "FIXTURE METHOD BLOCK");
        assert.equal(getPromptBlocks().locale_legal.hr, "FIXTURE HR LEGAL");
        assert.deepEqual(getWorkflowPacks(), FIXTURE_PACK.workflow_packs);
        assert.match(requests[0]?.auth ?? "", /^Bearer /);
        assert.equal(requests[0]?.etagHeader, undefined);
    });

    it("revalidates with If-None-Match and keeps the cached pack on 304", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        serveMode = "not-modified-when-matched";
        await refreshPromptPack();
        const first = getPromptPack();
        assert.equal(first?.version, 7);
        await refreshPromptPack();
        assert.equal(requests.length, 2);
        assert.equal(requests[1]?.etagHeader, servedEtag);
        assert.equal(getPromptPack(), first); // same object — 304 kept it
    });

    it("keeps the last-known pack when a later refresh fails", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        await refreshPromptPack();
        assert.equal(getPromptPackVersion(), 7);
        serveMode = "fail";
        await refreshPromptPack();
        assert.equal(getPromptPackVersion(), 7);
        assert.equal(getPromptPack()?.blocks.citations_legal, "FIXTURE CITATIONS BLOCK");
    });

    it("stays null (fallback posture) when the service is unreachable with no cache", async () => {
        process.env.GOVERNANCE_URL = "http://127.0.0.1:1"; // nothing listens here
        await refreshPromptPack();
        assert.equal(getPromptPack(), null);
        assert.equal(getPromptPackVersion(), null);
        assert.equal(getPromptBlocks(), GENERIC_PROMPT_BLOCKS);
    });
});
