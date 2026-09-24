import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_LLM_STREAM_DEADLINE_MS,
    LlmStreamStallError,
    createStallWatchdog,
    resolveLlmStreamDeadlineMs,
} from "./stallWatchdog";

describe("resolveLlmStreamDeadlineMs", () => {
    it("unset/empty → default (the watchdog has no disabled state)", () => {
        assert.equal(
            resolveLlmStreamDeadlineMs(undefined),
            DEFAULT_LLM_STREAM_DEADLINE_MS,
        );
        assert.equal(
            resolveLlmStreamDeadlineMs(""),
            DEFAULT_LLM_STREAM_DEADLINE_MS,
        );
    });
    it("0 / negative / non-numeric / Infinity → default", () => {
        for (const raw of ["0", "-5", "abc", "Infinity", "NaN"]) {
            assert.equal(
                resolveLlmStreamDeadlineMs(raw),
                DEFAULT_LLM_STREAM_DEADLINE_MS,
                `raw=${raw}`,
            );
        }
    });
    it("valid values pass through (floored to whole ms)", () => {
        assert.equal(resolveLlmStreamDeadlineMs("120000"), 120_000);
        assert.equal(resolveLlmStreamDeadlineMs("1500.9"), 1500);
    });
});

describe("LlmStreamStallError", () => {
    it("carries the STREAM_STALLED code the SSE error event ships", () => {
        const err = new LlmStreamStallError(240_000);
        assert.equal(err.code, "STREAM_STALLED");
        assert.equal(err.deadlineMs, 240_000);
        assert.match(err.message, /240s/);
        assert.ok(err instanceof Error);
    });
});

describe("createStallWatchdog", () => {
    const DEADLINE = 1000;

    it("silence longer than the deadline triggers onStall exactly once", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let fired = 0;
        const wd = createStallWatchdog({
            deadlineMs: DEADLINE,
            onStall: () => fired++,
        });
        t.mock.timers.tick(DEADLINE - 1);
        assert.equal(fired, 0);
        assert.equal(wd.stalled, false);
        t.mock.timers.tick(1);
        assert.equal(fired, 1);
        assert.equal(wd.stalled, true);
        // More silence never re-fires.
        t.mock.timers.tick(DEADLINE * 10);
        assert.equal(fired, 1);
    });

    it("touch() re-arms the idle deadline — chunks keep the turn alive", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let fired = 0;
        const wd = createStallWatchdog({
            deadlineMs: DEADLINE,
            onStall: () => fired++,
        });
        // Simulate a long legitimate generation: activity every DEADLINE-1
        // for 10 rounds — total duration far past the deadline, no stall.
        for (let i = 0; i < 10; i++) {
            t.mock.timers.tick(DEADLINE - 1);
            wd.touch();
        }
        assert.equal(fired, 0);
        assert.equal(wd.stalled, false);
        // Then true silence → exactly one stall.
        t.mock.timers.tick(DEADLINE);
        assert.equal(fired, 1);
        assert.equal(wd.stalled, true);
    });

    it("touch() after the stall is a no-op (never un-stalls or re-arms)", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let fired = 0;
        const wd = createStallWatchdog({
            deadlineMs: DEADLINE,
            onStall: () => fired++,
        });
        t.mock.timers.tick(DEADLINE);
        assert.equal(fired, 1);
        wd.touch();
        t.mock.timers.tick(DEADLINE * 5);
        assert.equal(fired, 1);
        assert.equal(wd.stalled, true);
    });

    it("stop() clears the timer — no stall fires afterwards", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let fired = 0;
        const wd = createStallWatchdog({
            deadlineMs: DEADLINE,
            onStall: () => fired++,
        });
        t.mock.timers.tick(DEADLINE - 1);
        wd.stop();
        t.mock.timers.tick(DEADLINE * 10);
        assert.equal(fired, 0);
        assert.equal(wd.stalled, false);
        // Idempotent, and touch() after stop() must not re-arm.
        wd.stop();
        wd.touch();
        t.mock.timers.tick(DEADLINE * 10);
        assert.equal(fired, 0);
    });

    it("defaults the deadline from LLM_STREAM_DEADLINE_MS when not given", (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const prev = process.env.LLM_STREAM_DEADLINE_MS;
        process.env.LLM_STREAM_DEADLINE_MS = "2000";
        t.after(() => {
            if (prev === undefined) delete process.env.LLM_STREAM_DEADLINE_MS;
            else process.env.LLM_STREAM_DEADLINE_MS = prev;
        });
        let fired = 0;
        const wd = createStallWatchdog({ onStall: () => fired++ });
        t.mock.timers.tick(1999);
        assert.equal(fired, 0);
        t.mock.timers.tick(1);
        assert.equal(fired, 1);
        wd.stop();
    });
});
