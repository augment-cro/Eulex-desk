import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUsageEvent } from "./usageEvent";

describe("buildUsageEvent", () => {
    const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 300,
        iterations: 2,
    };
    it("mirrors what llm_usage records: tokens + USD incl. web-search cost", () => {
        const ev = buildUsageEvent({
            usage,
            model: "claude-sonnet-4-6",
            webSearchCostUsd: 0.01,
            durationMs: 1234,
        });
        assert.equal(ev.type, "usage");
        assert.equal(ev.model, "claude-sonnet-4-6");
        assert.equal(ev.input_tokens, 1000);
        assert.equal(ev.output_tokens, 500);
        assert.equal(ev.cache_creation_input_tokens, 200);
        assert.equal(ev.cache_read_input_tokens, 300);
        assert.equal(ev.web_search_cost_usd, 0.01);
        assert.equal(ev.duration_ms, 1234);
        // cost_usd = computeCostUsd(model, usage) + webSearchCostUsd; computeCostUsd
        // prices claude-sonnet-4-6 > 0, so the sum must exceed the search cost alone.
        assert.ok(ev.cost_usd > 0.01);
    });
    it("tolerates unknown models (computeCostUsd falls back to 0) and no search cost", () => {
        const ev = buildUsageEvent({ usage, model: "unknown-model", durationMs: 10 });
        assert.equal(ev.cost_usd, 0);
        assert.equal(ev.web_search_cost_usd, 0);
    });
});
