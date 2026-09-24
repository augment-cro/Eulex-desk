import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
    FixedWindowLimiter,
    clientIpFrom,
    envInt,
    ipRateLimit,
} from "./ipRateLimit";

const MIN = 60_000;

describe("FixedWindowLimiter", () => {
    it("allows up to the limit, rejects the attempt after", () => {
        const lim = new FixedWindowLimiter(3, 15 * MIN);
        const t0 = 1_000_000;
        assert.equal(lim.hit("a", t0).allowed, true);
        assert.equal(lim.hit("a", t0 + 1).allowed, true);
        assert.equal(lim.hit("a", t0 + 2).allowed, true);
        const fourth = lim.hit("a", t0 + 3);
        assert.equal(fourth.allowed, false);
        assert.equal(fourth.count, 4);
    });

    it("isolates keys (per-IP isolation)", () => {
        const lim = new FixedWindowLimiter(2, 15 * MIN);
        const t0 = 0;
        lim.hit("1.1.1.1", t0);
        lim.hit("1.1.1.1", t0);
        assert.equal(lim.hit("1.1.1.1", t0).allowed, false);
        // A different IP still has a fresh budget.
        assert.equal(lim.hit("2.2.2.2", t0).allowed, true);
    });

    it("rolls the window over: budget resets after windowMs", () => {
        const lim = new FixedWindowLimiter(1, 15 * MIN);
        const t0 = 5_000;
        assert.equal(lim.hit("a", t0).allowed, true);
        // Still inside the window — rejected.
        assert.equal(lim.hit("a", t0 + 15 * MIN - 1).allowed, false);
        // Window elapsed — fresh budget, count restarts at 1.
        const fresh = lim.hit("a", t0 + 15 * MIN);
        assert.equal(fresh.allowed, true);
        assert.equal(fresh.count, 1);
    });

    it("computes Retry-After as whole seconds to window end, rounded up, min 1", () => {
        const lim = new FixedWindowLimiter(1, 15 * MIN);
        const t0 = 0;
        assert.equal(lim.hit("a", t0).retryAfterSeconds, 900);
        // 10s into the window: 890s left.
        assert.equal(lim.hit("a", t0 + 10_000).retryAfterSeconds, 890);
        // 400ms shy of the end rounds UP to a full second …
        assert.equal(lim.hit("a", t0 + 15 * MIN - 400).retryAfterSeconds, 1);
        // … and never reports 0 even at the last millisecond.
        assert.equal(lim.hit("a", t0 + 15 * MIN - 1).retryAfterSeconds, 1);
    });

    it("sweeps expired windows so the map does not grow unbounded", () => {
        const lim = new FixedWindowLimiter(5, 15 * MIN);
        for (let i = 0; i < 100; i++) lim.hit(`ip-${i}`, 0);
        assert.equal(lim.size(0), 100);
        // Two windows later, one hit triggers the lazy sweep.
        lim.hit("fresh", 30 * MIN);
        assert.equal(lim.size(30 * MIN), 1);
    });

    it("rejects nonsensical construction", () => {
        assert.throws(() => new FixedWindowLimiter(0, 1000));
        assert.throws(() => new FixedWindowLimiter(10, 0));
    });
});

function fakeReq(headers: Record<string, string | string[]>, remote?: string): Request {
    return {
        headers,
        socket: { remoteAddress: remote },
    } as unknown as Request;
}

describe("clientIpFrom", () => {
    it("takes the LAST X-Forwarded-For entry (the one Cloud Run appended)", () => {
        const req = fakeReq(
            { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
            "169.254.1.1",
        );
        assert.equal(clientIpFrom(req), "203.0.113.9");
    });

    it("ignores spoofed earlier entries even with odd whitespace", () => {
        const req = fakeReq({ "x-forwarded-for": "1.2.3.4,5.6.7.8 , 9.9.9.9 " });
        assert.equal(clientIpFrom(req), "9.9.9.9");
    });

    it("falls back to the socket peer when no XFF (local dev)", () => {
        assert.equal(clientIpFrom(fakeReq({}, "127.0.0.1")), "127.0.0.1");
    });

    it("returns 'unknown' when nothing is available", () => {
        assert.equal(clientIpFrom(fakeReq({})), "unknown");
    });
});

describe("envInt", () => {
    it("parses positive integers and falls back on garbage", () => {
        process.env.__IPRL_TEST = "25";
        assert.equal(envInt("__IPRL_TEST", 10), 25);
        process.env.__IPRL_TEST = "banana";
        assert.equal(envInt("__IPRL_TEST", 10), 10);
        process.env.__IPRL_TEST = "0";
        assert.equal(envInt("__IPRL_TEST", 10), 10);
        process.env.__IPRL_TEST = "-4";
        assert.equal(envInt("__IPRL_TEST", 10), 10);
        delete process.env.__IPRL_TEST;
        assert.equal(envInt("__IPRL_TEST", 10), 10);
    });
});

/** Minimal Response double capturing status/headers/body. */
function fakeRes() {
    const out = {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        setHeader(k: string, v: string) {
            out.headers[k.toLowerCase()] = v;
        },
        status(c: number) {
            out.statusCode = c;
            return out;
        },
        json(b: unknown) {
            out.body = b;
        },
    };
    return out;
}

describe("ipRateLimit middleware", () => {
    it("passes under both limits, 429s the same IP past its budget, keeps other IPs open", () => {
        const mw = ipRateLimit({
            name: "test",
            windowMs: 15 * MIN,
            perIpLimit: 2,
            globalLimit: 100,
        });
        const reqA = fakeReq({ "x-forwarded-for": "203.0.113.9" });
        let passed = 0;
        const next = () => {
            passed += 1;
        };
        mw(reqA, fakeRes() as unknown as Response, next);
        mw(reqA, fakeRes() as unknown as Response, next);
        assert.equal(passed, 2);

        const res3 = fakeRes();
        mw(reqA, res3 as unknown as Response, next);
        assert.equal(passed, 2);
        assert.equal(res3.statusCode, 429);
        assert.ok(Number(res3.headers["retry-after"]) >= 1);
        assert.equal((res3.body as { code: string }).code, "RATE_LIMITED");

        // A different IP is unaffected by A's exhaustion.
        const reqB = fakeReq({ "x-forwarded-for": "198.51.100.7" });
        mw(reqB, fakeRes() as unknown as Response, next);
        assert.equal(passed, 3);
    });

    it("enforces the global cap across distinct IPs", () => {
        const mw = ipRateLimit({
            name: "test",
            windowMs: 15 * MIN,
            perIpLimit: 100,
            globalLimit: 3,
        });
        let passed = 0;
        const next = () => {
            passed += 1;
        };
        for (let i = 0; i < 3; i++) {
            mw(
                fakeReq({ "x-forwarded-for": `10.0.0.${i}` }),
                fakeRes() as unknown as Response,
                next,
            );
        }
        assert.equal(passed, 3);
        // Fourth request from a BRAND NEW IP still trips the global cap.
        const res = fakeRes();
        mw(
            fakeReq({ "x-forwarded-for": "10.0.0.99" }),
            res as unknown as Response,
            next,
        );
        assert.equal(passed, 3);
        assert.equal(res.statusCode, 429);
        assert.ok(Number(res.headers["retry-after"]) >= 1);
    });
});
