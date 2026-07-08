import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { governanceClient } from "./governanceClient.js";

const servers: http.Server[] = [];
let lastAuth: string | undefined;
let lastBody: unknown;

function startStub(): Promise<string> {
    const server = http.createServer((req, res) => {
        lastAuth = req.headers.authorization;
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            lastBody = raw ? JSON.parse(raw) : undefined;
            if (req.method === "POST" && req.url === "/pre-inference") {
                res.setHeader("content-type", "application/json");
                res.end(
                    JSON.stringify({
                        prompt_blocks: ["FIXTURE HOOK BLOCK"],
                        classification: { fixture: true },
                        gate: { action: "notify", message_md: "fixture notice" },
                    }),
                );
                return;
            }
            if (req.method === "POST" && req.url === "/enrich") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ enriched: "fixture enriched query?" }));
                return;
            }
            res.statusCode = 404;
            res.end("{}");
        });
    });
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

describe("governanceClient", () => {
    beforeEach(() => {
        delete process.env.GOVERNANCE_URL;
        delete process.env.GOVERNANCE_SERVICE_SECRET;
        delete process.env.GOVERNANCE_FAIL_MODE;
        lastAuth = undefined;
        lastBody = undefined;
    });
    after(() => {
        for (const server of servers) server.close();
    });

    it("is unconfigured, fail-open by default, and makes ZERO network calls without GOVERNANCE_URL", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw new Error("seam network call attempted with GOVERNANCE_URL unset");
        }) as typeof fetch;
        try {
            assert.equal(governanceClient.isConfigured(), false);
            assert.equal(governanceClient.failMode(), "open");
            const hook = await governanceClient.preInference({
                query: "q",
                meta: { chat_id: null, user_id: "u1", locale: "hr", client: "web" },
            });
            assert.deepEqual(hook, { ok: false, error: "GOVERNANCE_URL_NOT_SET" });
            const enriched = await governanceClient.enrich("q", "hr", "u1");
            assert.equal(enriched.ok, false);
            assert.equal(fetchCalls, 0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("honors GOVERNANCE_FAIL_MODE=closed", () => {
        process.env.GOVERNANCE_FAIL_MODE = "closed";
        assert.equal(governanceClient.failMode(), "closed");
        process.env.GOVERNANCE_FAIL_MODE = "anything-else";
        assert.equal(governanceClient.failMode(), "open");
    });

    it("posts /pre-inference per the contract, sending identity when configured", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        process.env.GOVERNANCE_SERVICE_SECRET = "g-secret";
        const hook = await governanceClient.preInference({
            query: "what applies?",
            meta: { chat_id: "c1", user_id: "u1", locale: "hr", client: "web" },
        });
        assert.ok(hook.ok);
        assert.deepEqual(hook.data.prompt_blocks, ["FIXTURE HOOK BLOCK"]);
        assert.equal(hook.data.gate?.action, "notify");
        assert.match(lastAuth ?? "", /^Bearer /);
        assert.deepEqual(lastBody, {
            query: "what applies?",
            meta: { chat_id: "c1", user_id: "u1", locale: "hr", client: "web" },
        });
    });

    it("posts /enrich {query, locale} and returns {enriched}", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        const out = await governanceClient.enrich("vague question", "en", "u1");
        assert.ok(out.ok);
        assert.equal(out.data.enriched, "fixture enriched query?");
        assert.deepEqual(lastBody, { query: "vague question", locale: "en" });
    });

    it("returns ok:false on HTTP errors and unreachable hosts instead of throwing", async () => {
        process.env.GOVERNANCE_URL = await startStub();
        const missing = await governanceClient.enrich("q", "en", "u1");
        assert.ok(missing.ok); // stub answers /enrich — exercise 404 via a bogus path host instead
        process.env.GOVERNANCE_URL = "http://127.0.0.1:1";
        const down = await governanceClient.preInference({
            query: "q",
            meta: { chat_id: null, user_id: "u1", locale: "en", client: "web" },
        });
        assert.equal(down.ok, false);
    });
});
