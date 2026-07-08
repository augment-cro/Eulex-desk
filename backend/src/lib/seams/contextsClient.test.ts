import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { contextsClient } from "./contextsClient.js";

// Every stub server started during the run — closed in after() so the
// test process can exit (two tests each start their own stub).
const servers: http.Server[] = [];
let lastAuth: string | undefined;

function startStub(): Promise<string> {
    const server = http.createServer((req, res) => {
        lastAuth = req.headers.authorization;
        if (req.method === "GET" && req.url === "/contexts") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify([{ id: "c1", name: "Test context" }]));
            return;
        }
        if (req.method === "POST" && req.url === "/contexts/c1/resolve") {
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    instructions_md: "Follow these.",
                    sources: [{ id: "s1", label: "Source 1" }],
                    scope_allowlist: ["s1"],
                }),
            );
            return;
        }
        res.statusCode = 404;
        res.end("{}");
    });
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

describe("contextsClient", () => {
    beforeEach(() => {
        delete process.env.CONTEXTS_URL;
        delete process.env.CONTEXTS_SERVICE_SECRET;
        lastAuth = undefined;
    });
    after(() => {
        for (const server of servers) server.close();
    });

    it("is unconfigured and fails fast without CONTEXTS_URL", async () => {
        assert.equal(contextsClient.isConfigured(), false);
        const res = await contextsClient.list("u1");
        assert.deepEqual(res, { ok: false, error: "CONTEXTS_URL_NOT_SET" });
    });

    it("makes ZERO network calls when CONTEXTS_URL is unset (standalone-core rule)", async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
            fetchCalls++;
            throw new Error("seam network call attempted with CONTEXTS_URL unset");
        }) as typeof fetch;
        try {
            assert.equal(contextsClient.isConfigured(), false);
            const list = await contextsClient.list("u1");
            assert.equal(list.ok, false);
            const resolved = await contextsClient.resolve("c1", "q", "u1");
            assert.equal(resolved.ok, false);
            assert.equal(fetchCalls, 0);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("lists and resolves against a live endpoint, sending identity when configured", async () => {
        process.env.CONTEXTS_URL = await startStub();
        process.env.CONTEXTS_SERVICE_SECRET = "s3cret";

        const list = await contextsClient.list("u1");
        assert.ok(list.ok);
        assert.equal(list.data[0].id, "c1");
        assert.match(lastAuth ?? "", /^Bearer /);

        const resolved = await contextsClient.resolve("c1", "what applies?", "u1");
        assert.ok(resolved.ok);
        assert.equal(resolved.data.instructions_md, "Follow these.");
        assert.deepEqual(resolved.data.scope_allowlist, ["s1"]);
    });

    it("returns ok:false on HTTP errors instead of throwing", async () => {
        process.env.CONTEXTS_URL = await startStub();
        const res = await contextsClient.resolve("missing", "q", "u1");
        assert.equal(res.ok, false);
    });
});
