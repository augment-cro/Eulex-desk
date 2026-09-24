import test from "node:test";
import assert from "node:assert/strict";
import { priceUsage } from "./llmPricing";
import { responsesUsage } from "./llm/openaiResponses";
import { emptyUsage, sumUsage } from "./llm/usage";

const params = {
    model: "gpt-5.6-sol",
    systemPrompt: "",
    messages: [],
    usagePhase: "retriever" as const,
};
const endpoint = "https://eu.api.openai.com/v1/responses";
const receipt = (
    input: number,
    cached = 0,
    written = 0,
    output = 100,
    tier = "default",
) =>
    responsesUsage(
        {
            model: params.model,
            id: "resp_test",
            service_tier: tier,
            usage: {
                input_tokens: input,
                input_tokens_details: {
                    cached_tokens: cached,
                    cache_write_tokens: written,
                },
                output_tokens: output,
                output_tokens_details: { reasoning_tokens: 80 },
            },
        },
        params,
        endpoint,
    );

test("EU Sol bills disjoint fresh/write/read input and includes reasoning once", () => {
    const usage = receipt(10_000, 6000, 3000);
    assert.equal(usage.inputTokens, 1000);
    assert.equal(usage.outputTokens, 100);
    assert.equal(usage.calls?.[0].reasoningTokens, 80);
    const cost = priceUsage("ignored-writer-model", usage);
    assert.equal(cost.costUsd, 0.02574); // (1000*4 + 6000*.4 + 3000*5 + 100*20) / 1e6 * 1.1
    assert.equal(cost.complete, true);
    assert.equal(cost.calls[0].rawUsage?.input_tokens, 10000);
});

test("long context is evaluated per request and includes all cache categories", () => {
    const short = receipt(200_000);
    const combined = priceUsage(params.model, sumUsage(short, short));
    assert.equal(combined.costUsd, 1.7644);
    assert.deepEqual(
        combined.calls.map((c) => c.longContext),
        [false, false],
    );
    assert.equal(
        priceUsage(params.model, receipt(272_000)).calls[0].longContext,
        false,
    );
    const long = priceUsage(params.model, receipt(272_001, 200_000, 70_000));
    assert.equal(long.calls[0].longContext, true);
    assert.equal(long.costUsd, 0.9669088);
});

test("actual service tier and mixed-model phases are priced independently", () => {
    assert.equal(
        priceUsage(params.model, receipt(1000, 0, 0, 100, "fast")).costUsd,
        0.0132,
    );
    const a = receipt(1000);
    const b = receipt(1000);
    b.calls![0] = {
        ...b.calls![0],
        model: "claude-opus-5",
        phase: "writer",
        provider: "claude",
        endpoint: "https://api.anthropic.com/v1/messages",
    };
    const cost = priceUsage(params.model, sumUsage(a, b), 0.01);
    assert.equal(cost.costUsd, 0.0241);
    assert.deepEqual(
        cost.calls.map((c) => c.phase),
        ["retriever", "writer"],
    );
});

test("missing usage preserves known spend but never claims a complete zero cost", () => {
    const missing = responsesUsage({}, params, endpoint, "aborted");
    const cost = priceUsage(
        params.model,
        sumUsage(receipt(1000), missing),
        0.02,
    );
    assert.equal(cost.costUsd, null);
    assert.equal(cost.knownCostUsd, 0.0266);
    assert.equal(cost.complete, false);
    assert.equal(cost.calls[1].status, "aborted");
    const unknown = receipt(1000);
    unknown.calls![0].model = "future-model";
    assert.equal(priceUsage(params.model, unknown).costUsd, null);
    assert.equal(
        priceUsage(params.model, receipt(1000, 0, 0, 100, "future-tier"))
            .costUsd,
        null,
    );
    assert.equal(priceUsage("search", emptyUsage(), 0.01).costUsd, 0.01);
});
