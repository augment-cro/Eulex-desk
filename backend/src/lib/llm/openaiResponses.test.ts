import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { streamChatWithTools } from "./index";
import { runOrchestratedChat } from "../orchestration/runOrchestratedChat";
import { getErrorUsage } from "./usage";
import { responsesInput, responsesCacheOptions } from "./openaiResponses";
import type { StreamChatParams } from "./types";

const base: StreamChatParams = {
    model: "gpt-5.6-sol",
    systemPrompt: "stable instructions",
    systemDynamicSuffix: "changing documents",
    messages: [{ role: "user", content: "question" }],
    apiKeys: { openai: "test-key" },
    promptCacheKey: "test-user",
};
const answer = (text: string, input = 2000) => ({
    id: "resp_test",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    service_tier: "default",
    output: text
        ? [
              {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text, annotations: [] }],
              },
          ]
        : [],
    usage: {
        input_tokens: input,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 500 },
        output_tokens_details: { reasoning_tokens: 20 },
    },
});
function mockResponses(t: TestContext, sequence: unknown[]) {
    const requests: any[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, init: RequestInit) => {
            requests.push(JSON.parse(String(init.body)));
            const next = sequence.shift();
            if (next === "error")
                return new Response(
                    JSON.stringify({
                        error: {
                            message: "invalid request",
                            type: "invalid_request_error",
                        },
                    }),
                    { status: 400 },
                );
            assert.ok(next, "unexpected request");
            return new Response(JSON.stringify(next), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "x-request-id": "req_test",
                },
            });
        },
    );
    return requests;
}

test("writer caches stable instructions while retrieval also caches changing history", () => {
    assert.deepEqual(
        responsesInput(base)[0],
        responsesInput({
            ...base,
            systemDynamicSuffix: "other docs",
            messages: [],
        })[0],
    );
    assert.equal(
        (responsesInput(base)[1] as any).content,
        "changing documents",
    );
    assert.deepEqual(responsesCacheOptions(base), {
        prompt_cache_options: { mode: "explicit", ttl: "30m" },
        prompt_cache_key: "test-user",
    });
    assert.equal(
        responsesCacheOptions({
            ...base,
            tools: [
                {
                    type: "function",
                    function: { name: "read", description: "", parameters: {} },
                },
            ],
        }).prompt_cache_options.mode,
        "implicit",
    );
});

test("orchestration retains each actual model/phase and only streams writer text", async (t) => {
    const requests = mockResponses(t, [
        answer("evidence"),
        answer("final answer"),
    ]);
    const visible: string[] = [];
    const result = await runOrchestratedChat({
        retrieverModel: base.model,
        writerModel: base.model,
        base: {
            ...base,
            callbacks: { onContentDelta: (text) => visible.push(text) },
        },
    });
    assert.equal(result.model, base.model);
    assert.equal(result.usage?.iterations, 2);
    assert.deepEqual(
        result.usage?.calls?.map((c) => c.phase),
        ["retriever", "writer"],
    );
    assert.equal(result.usage?.cacheCreationInputTokens, 1000);
    assert.deepEqual(visible, ["final answer"]);
    assert.equal(requests[0].instructions, undefined);
    assert.ok(requests[0].input[0].content[0].prompt_cache_breakpoint);
    assert.equal(requests[1].service_tier, "default");
});

test("writer failure and retriever fallback preserve already reported usage", async (t) => {
    mockResponses(t, [
        answer("brief"),
        "error",
        answer(""),
        answer("fallback"),
    ]);
    await assert.rejects(
        runOrchestratedChat({
            retrieverModel: base.model,
            writerModel: base.model,
            base,
        }),
        (error) => {
            const partial = getErrorUsage(error);
            assert.equal(partial?.usage.iterations, 2);
            assert.equal(partial?.usage.outputTokens, 100);
            assert.notEqual(partial?.usage.incomplete, true);
            assert.equal(partial?.usage.calls?.[1].status, "rejected");
            return true;
        },
    );
    const fallback = await runOrchestratedChat({
        retrieverModel: base.model,
        writerModel: base.model,
        base: { ...base, model: "claude-sonnet-5" },
    });
    assert.equal(fallback.model, base.model);
    assert.deepEqual(
        fallback.usage?.calls?.map((c) => c.phase),
        ["retriever", "fallback"],
    );
});

test("tool loops preserve previous receipts and mark result cache boundaries", async (t) => {
    const first = {
        ...answer(""),
        output: [
            {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "read",
                arguments: "{}",
            },
        ],
    };
    const requests = mockResponses(t, [first, answer("done")]);
    const result = await streamChatWithTools({
        ...base,
        maxIterations: 2,
        tools: [
            {
                type: "function",
                function: { name: "read", description: "", parameters: {} },
            },
        ],
        runTools: async () => [
            { tool_use_id: "call_1", content: "public source" },
        ],
    });
    assert.equal(result.usage?.iterations, 2);
    const toolOutput = requests[1].input.find(
        (x: any) => x.type === "function_call_output",
    );
    assert.deepEqual(toolOutput.output[0].prompt_cache_breakpoint, {
        mode: "explicit",
    });
    assert.equal(requests[1].tool_choice, "none");
    assert.equal(result.fullText, "done");
});

test("abort after retrieval does not start a writer", async (t) => {
    const requests = mockResponses(t, [answer("brief")]);
    const controller = new AbortController();
    const result = await runOrchestratedChat({
        retrieverModel: base.model,
        writerModel: base.model,
        base: {
            ...base,
            abortSignal: controller.signal,
            onUsage: () => controller.abort(),
        },
    });
    assert.equal(requests.length, 1);
    assert.equal(result.usage?.iterations, 1);
    assert.equal(result.fullText, "");
});

test("transient EU rejection retries only in EU and keeps zero-cost rejection receipts", async (t) => {
    const previousEu = process.env.OPENAI_EU;
    process.env.OPENAI_EU = "1";
    t.after(() => {
        if (previousEu === undefined) delete process.env.OPENAI_EU;
        else process.env.OPENAI_EU = previousEu;
    });
    let attempts = 0;
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
        urls.push(String(url));
        attempts++;
        if (attempts === 1)
            return new Response(
                JSON.stringify({
                    error: {
                        message:
                            "This endpoint is only accessible by projects with geography restrictions enabled.",
                        type: "invalid_request_error",
                    },
                }),
                { status: 401 },
            );
        return new Response(JSON.stringify(answer("OK")), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    });
    const result = await streamChatWithTools(base);
    assert.equal(attempts, 2);
    assert.ok(
        urls.every((url) => url === "https://eu.api.openai.com/v1/responses"),
    );
    assert.deepEqual(
        result.usage?.calls?.map((c) => c.status),
        ["rejected", "reported"],
    );
    assert.equal(result.usage?.inputTokens, 500);
    assert.notEqual(result.usage?.incomplete, true);
});
