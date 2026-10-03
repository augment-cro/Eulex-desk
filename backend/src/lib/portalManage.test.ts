import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    PortalManageError,
    clampInt,
    portalManageConfigured,
    portalManageFetch,
} from "./portalManage";

describe("clampInt", () => {
    it("falls back when absent or not a number", () => {
        assert.equal(clampInt(undefined, 30, 1, 365), 30);
        assert.equal(clampInt("abc", 30, 1, 365), 30);
        assert.equal(clampInt("", 7, 1, 365), 7);
    });
    it("clamps into [min, max] and truncates", () => {
        assert.equal(clampInt("0", 30, 1, 365), 1);
        assert.equal(clampInt("9999", 30, 1, 365), 365);
        assert.equal(clampInt("90", 30, 1, 365), 90);
        assert.equal(clampInt("12.9", 30, 1, 365), 12);
        assert.equal(clampInt(-5, 200, 1, 500), 1);
    });
});

describe("portalManageFetch", () => {
    const origFetch = globalThis.fetch;
    const origUrl = process.env.PORTAL_MANAGE_URL;
    const origKey = process.env.PORTAL_MANAGE_KEY;
    let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    beforeEach(() => {
        calls = [];
        process.env.PORTAL_MANAGE_URL = "https://portal.example.test/";
        process.env.PORTAL_MANAGE_KEY = "secret-key";
    });
    afterEach(() => {
        globalThis.fetch = origFetch;
        if (origUrl === undefined) delete process.env.PORTAL_MANAGE_URL;
        else process.env.PORTAL_MANAGE_URL = origUrl;
        if (origKey === undefined) delete process.env.PORTAL_MANAGE_KEY;
        else process.env.PORTAL_MANAGE_KEY = origKey;
    });

    function mockFetch(status: number, body: string) {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(input), init });
            return new Response(body, {
                status,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;
    }

    it("reports unconfigured when the URL is unset", () => {
        process.env.PORTAL_MANAGE_URL = "   ";
        assert.equal(portalManageConfigured(), false);
        process.env.PORTAL_MANAGE_URL = "https://portal.example.test";
        assert.equal(portalManageConfigured(), true);
    });

    it("joins base URL (trailing slash stripped) + path and sends the service key", async () => {
        mockFetch(200, JSON.stringify({ days: 30 }));
        const out = await portalManageFetch<{ days: number }>("/manage/overview?days=30");
        assert.deepEqual(out, { days: 30 });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://portal.example.test/manage/overview?days=30");
        const headers = calls[0].init?.headers as Record<string, string>;
        assert.equal(headers["X-Portal-Service-Key"], "secret-key");
        assert.equal(headers.Authorization, undefined);
        assert.equal(calls[0].init?.method, "GET");
    });

    it("throws PortalManageError with status and detail on non-2xx", async () => {
        mockFetch(403, JSON.stringify({ detail: "bad service key" }));
        await assert.rejects(
            portalManageFetch("/manage/overview?days=30"),
            (err: unknown) =>
                err instanceof PortalManageError &&
                err.status === 403 &&
                /403: bad service key/.test(err.message),
        );
    });

    it("passes POST through and tolerates an empty body", async () => {
        mockFetch(200, "");
        const out = await portalManageFetch("/manage/keys/abc/revoke?note=adminmax", {
            method: "POST",
        });
        assert.deepEqual(out, {});
        assert.equal(calls[0].init?.method, "POST");
    });
});
