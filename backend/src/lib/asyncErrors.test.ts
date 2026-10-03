import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { installAsyncErrorForwarding } from "./asyncErrors.js";

installAsyncErrorForwarding();

function app() {
    const a = express();
    a.get("/boom", async () => {
        throw new TypeError("Invalid character in header content");
    });
    a.get("/ok", async (_req, res) => {
        res.json({ ok: true });
    });
    a.get("/sync", () => {
        throw new Error("sync");
    });
    a.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
    return a;
}

describe("installAsyncErrorForwarding", () => {
    it("answers 500 at once when an async handler rejects (was: hang → 504)", async () => {
        const res = await request(app()).get("/boom").timeout(2000);
        assert.equal(res.status, 500);
        assert.equal(res.body.error, "Invalid character in header content");
    });

    it("leaves successful async and throwing sync handlers as before", async () => {
        assert.equal((await request(app()).get("/ok")).status, 200);
        assert.equal((await request(app()).get("/sync")).status, 500);
    });
});
