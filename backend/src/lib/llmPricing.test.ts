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

test("Opus 5.5 aggregate is priced at its list rate, cache reads at 0.05x input", () => {
    const usage = {
        ...emptyUsage(),
        iterations: 3,
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheCreationInputTokens: 4_000,
        cacheReadInputTokens: 50_000,
    };
    // (10000*4 + 2000*20 + 4000*5 + 50000*0.2) / 1e6
    assert.equal(priceUsage("claude-opus-5-5", usage).costUsd, 0.11);
    // Same tokens on Sonnet 5: (10000*2 + 2000*10 + 4000*2.5 + 50000*0.2) / 1e6
    assert.equal(priceUsage("claude-sonnet-5", usage).costUsd, 0.06);
});

// Claude per-request receipts carry the serving endpoint (claude.ts).
const opusReceipt = (endpoint: string) => ({
    ...emptyUsage(),
    iterations: 1,
    inputTokens: 1000,
    outputTokens: 2000,
    cacheCreationInputTokens: 10_000,
    cacheReadInputTokens: 100_000,
    calls: [
        {
            provider: "claude" as const,
            model: "claude-opus-5-5",
            phase: "single" as const,
            endpoint,
            status: "reported" as const,
            inputTokens: 1000,
            outputTokens: 2000,
            cacheCreationInputTokens: 10_000,
            cacheReadInputTokens: 100_000,
        },
    ],
});

test("Claude on Vertex EU multi-region is 10 % over list for every token type", () => {
    // list: 1000*4 + 2000*20 + 10000*5 + 100000*0.2 = 114000 µ$ = $0.114
    const eu = priceUsage("claude-opus-5-5", opusReceipt("vertex:eu"));
    assert.equal(eu.costUsd, 0.1254);
    assert.equal(eu.complete, true);
    assert.equal(eu.basis, "provider_usage_list_price");
    assert.equal(eu.calls[0].vertexMultiplier, 1.1);
});

test("Claude on Vertex global and on the direct Anthropic API is list price", () => {
    assert.equal(
        priceUsage("claude-opus-5-5", opusReceipt("vertex:global")).costUsd,
        0.114,
    );
    const direct = priceUsage(
        "claude-opus-5-5",
        opusReceipt("https://api.anthropic.com/"),
    );
    assert.equal(direct.costUsd, 0.114);
    assert.equal(direct.calls[0].vertexMultiplier, 1);
});
