import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "./concurrency";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("mapWithConcurrency", () => {
    it("visits every item and never exceeds the limit", async () => {
        let inFlight = 0;
        let peak = 0;
        const seen: number[] = [];
        await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await tick();
            await tick();
            seen.push(n);
            inFlight--;
        });
        assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
        assert.equal(peak, 3);
    });

    it("clamps the limit to the item count and to at least one", async () => {
        let peak = 0;
        let inFlight = 0;
        await mapWithConcurrency([1, 2], 10, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await tick();
            inFlight--;
        });
        assert.equal(peak, 2);
        const seen: number[] = [];
        await mapWithConcurrency([1, 2, 3], 0, async (n) => {
            seen.push(n);
        });
        assert.deepEqual(seen, [1, 2, 3]);
    });

    it("is a no-op for an empty list", async () => {
        let calls = 0;
        await mapWithConcurrency([], 4, async () => {
            calls++;
        });
        assert.equal(calls, 0);
    });

    it("rejects with the first failure and starts nothing further", async () => {
        const started: number[] = [];
        await assert.rejects(
            mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
                started.push(n);
                await tick();
                if (n === 1) throw new Error("boom");
            }),
            /boom/,
        );
        // Items 1 and 2 were in flight when 1 failed; the queue behind
        // them must not drain onto a failing dependency.
        assert.ok(started.includes(1) && started.includes(2));
        assert.ok(!started.includes(5) && !started.includes(6), `started: ${started.join(",")}`);
    });
});
