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
    touchPromptPack,
    awaitInitialPromptPack,
    GENERIC_PROMPT_BLOCKS,
    __resetPromptPackForTests,
    __setPromptPackForTests,
    fillPromptTemplate,
    getCapabilitiesPrompt,
    getPiiAddendumOverride,
    getTitleGenerationPrompt,
    getWebSearchPrompt,
    type PromptPack,
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

    // ── Cloud Run CPU-throttling guards (tracker #41) ───────────────────
    it("touchPromptPack: with no pack, concurrent callers share ONE fetch and get the pack", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        await Promise.all([touchPromptPack(), touchPromptPack(), touchPromptPack()]);
        assert.equal(requests.length, 1);
        assert.equal(getPromptPackVersion(), 7);
    });

    it("touchPromptPack: with a fresh pack it makes no request; with a stale one it revalidates in the background", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        await refreshPromptPack();
        assert.equal(requests.length, 1);
        await touchPromptPack();
        assert.equal(requests.length, 1, "fresh pack → no revalidation");
        // Simulate "last attempt older than the interval" by pinning a pack
        // without a fetch: lastAttemptAt resets to 0 on reset.
        __resetPromptPackForTests();
        __setPromptPackForTests(FIXTURE_PACK as PromptPack);
        requests = [];
        await touchPromptPack();
        // fire-and-forget: give the round-trip a moment to land
        for (let i = 0; i < 50 && requests.length === 0; i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(requests.length, 1, "stale pack → one background revalidation");
    });

    it("touchPromptPack: bounded wait — returns on the bound when the service hangs, pack stays null", async () => {
        process.env.GOVERNANCE_URL = "http://127.0.0.1:1"; // nothing listens here
        const t0 = Date.now();
        await touchPromptPack(50);
        assert.ok(Date.now() - t0 < 2_000);
        assert.equal(getPromptPack(), null);
    });

    it("touchPromptPack / awaitInitialPromptPack: zero network calls without GOVERNANCE_URL", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw new Error("seam network call attempted with GOVERNANCE_URL unset");
        }) as typeof fetch;
        try {
            await touchPromptPack();
            await awaitInitialPromptPack();
            assert.equal(fetchCalls, 0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("awaitInitialPromptPack: resolves with the pack loaded, and immediately once cached", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        await awaitInitialPromptPack();
        assert.equal(getPromptPackVersion(), 7);
        const t0 = Date.now();
        await awaitInitialPromptPack();
        assert.ok(Date.now() - t0 < 100);
        assert.equal(requests.length, 1);
    });
});

// ── Extended blocks (issue #67) ─────────────────────────────────────────
// Unlike the core blocks (empty = insert nothing), an absent/empty extended
// key means "not provided" and the getter serves the FULL in-code default —
// the former hardcoded literal — so a pack that predates these keys changes
// nothing (pure-refactor guarantee).

describe("promptPack extended blocks (issue #67)", () => {
    beforeEach(() => {
        delete process.env.GOVERNANCE_URL;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        __resetPromptPackForTests();
        requests = [];
        serveMode = "ok";
    });
    after(() => {
        // Close stubs started inside THIS suite — the first suite's after
        // hook has already run and only closed the servers it knew about.
        for (const server of servers) server.close();
        __resetPromptPackForTests();
    });

    it("without a pack, the getters serve the in-code defaults", () => {
        assert.ok(getWebSearchPrompt().includes("WEB SEARCH — three tools are LIVE"));
        assert.ok(getCapabilitiesPrompt().startsWith("DOCX GENERATION:"));
        assert.ok(getCapabilitiesPrompt().includes("{{METHOD_SECTION_HEADING}}"));
        assert.ok(getTitleGenerationPrompt().includes("{{LANG_NAME}}"));
        assert.equal(getPiiAddendumOverride("hr"), null);
        assert.equal(getPiiAddendumOverride("en"), null);
    });

    it("a fetched pack that OMITS the extended keys keeps every default", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        await refreshPromptPack();
        assert.equal(getPromptPackVersion(), 7); // fixture pack is active…
        // …but the extended surfaces are untouched.
        assert.ok(getWebSearchPrompt().includes("WEB SEARCH — three tools are LIVE"));
        assert.ok(getCapabilitiesPrompt().startsWith("DOCX GENERATION:"));
        assert.equal(getPiiAddendumOverride("hr"), null);
    });

    it("non-empty pack values override the defaults; empty ones do not", () => {
        const pack: PromptPack = {
            version: 8,
            blocks: {
                ...GENERIC_PROMPT_BLOCKS,
                web_search: "PACK WEB SEARCH",
                pii_addendum: { hr: "PACK PII HR", en: "" },
                capabilities: "",
            },
            workflow_packs: [],
            enrichment_prompt: "",
        };
        __setPromptPackForTests(pack);
        assert.equal(getWebSearchPrompt(), "PACK WEB SEARCH");
        assert.equal(getPiiAddendumOverride("hr"), "PACK PII HR");
        assert.equal(getPiiAddendumOverride("en"), null);
        assert.ok(getCapabilitiesPrompt().startsWith("DOCX GENERATION:"));
    });

    it("fillPromptTemplate substitutes {{TOKEN}}s in ONE pass and leaves unknown tokens", () => {
        const out = fillPromptTemplate("A={{A}} B={{B}} C={{C}}", {
            A: "x{{B}}y", // must NOT be re-scanned
            B: "$'$&", // regex-special replacement chars stay literal
        });
        assert.equal(out, "A=x{{B}}y B=$'$& C={{C}}");
    });
});

describe("jurisdiction-of-the-question defaults (language ≠ jurisdiction)", () => {
    beforeEach(() => __resetPromptPackForTests());

    it("default web-search block routes unnamed-jurisdiction questions to the active connectors", () => {
        const ws = getWebSearchPrompt();
        assert.match(ws, /JURISDICTION OF THE QUESTION/);
        assert.match(ws, /NOT a jurisdiction signal/);
        // The HR official-sources tool must not fire for questions governed
        // by another enabled jurisdiction.
        assert.match(
            ws,
            /ONLY when the question actually concerns Croatian law/,
        );
    });

    it("generic fallback jurisdictions block carries the same default rule", () => {
        assert.match(
            GENERIC_PROMPT_BLOCKS.jurisdictions,
            /the language the question is written in is NOT a jurisdiction signal/,
        );
    });
});
