import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { completeText, streamChatWithTools } from "./index";
import type { LlmCallUsage, StreamChatParams } from "./types";

// A user-pasted key always takes the direct Anthropic API path (never
// Vertex), so these tests are independent of CLAUDE_PROVIDER.
const base: StreamChatParams = {
    model: "claude-opus-5-5",
    systemPrompt: "stable instructions",
    messages: [{ role: "user", content: "question" }],
    apiKeys: { claude: "test-key" },
    enableThinking: true,
};

type Refusal = {
    type: "refusal";
    category: "cyber" | "bio" | "reasoning_extraction" | null;
    explanation: null;
};
const refusal = (category: Refusal["category"]): Refusal => ({
    type: "refusal",
    category,
    explanation: null,
});

/** One streamed Messages API response, as SSE events. */
function message(
    model: string,
    stopReason: "end_turn" | "refusal",
    text = "",
    stopDetails: Refusal | null = null,
) {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: "msg_test",
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1000, output_tokens: 1 },
            },
        },
    ];
    if (text)
        events.push(
            {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
            },
            {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
            },
            { type: "content_block_stop", index: 0 },
        );
    events.push(
        {
            type: "message_delta",
            delta: {
                stop_reason: stopReason,
                stop_sequence: null,
                stop_details: stopDetails,
            },
            usage: { output_tokens: text ? 50 : 0 },
        },
        { type: "message_stop" },
    );
    return events;
}

function mockMessages(t: TestContext, sequence: Record<string, unknown>[][]) {
    const requests: any[] = [];
    t.mock.method(console, "warn", () => {});
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, init: RequestInit) => {
            requests.push(JSON.parse(String(init.body)));
            const next = sequence.shift();
            assert.ok(next, "unexpected request");
            return new Response(
                next
                    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
                    .join(""),
                {
                    status: 200,
                    headers: {
                        "content-type": "text/event-stream",
                        "request-id": "req_test",
                    },
                },
            );
        },
    );
    return requests;
}

test("Opus 5.5 refusal before any answer text is retried on Sonnet 5, priced per model", async (t) => {
    const requests = mockMessages(t, [
        message("claude-opus-5-5", "refusal", "", refusal("bio")),
        message("claude-sonnet-5", "end_turn", "Odgovor."),
    ]);
    const receipts: LlmCallUsage[] = [];
    const result = await streamChatWithTools({
        ...base,
        onUsage: (u) => receipts.push(...(u.calls ?? [])),
    });
    assert.deepEqual(
        requests.map((r) => r.model),
        ["claude-opus-5-5", "claude-sonnet-5"],
    );
    assert.equal(result.fullText, "Odgovor.");
    assert.equal(result.model, "claude-sonnet-5");
    assert.deepEqual(
        receipts.map((c) => [c.model, c.inputTokens, c.outputTokens]),
        [
            ["claude-opus-5-5", 1000, 0],
            ["claude-sonnet-5", 1000, 50],
        ],
    );
});

test("reasoning_extraction refusals are not retried on a fallback model", async (t) => {
    const requests = mockMessages(t, [
        message("claude-opus-5-5", "refusal", "", refusal("reasoning_extraction")),
    ]);
    const result = await streamChatWithTools(base);
    assert.equal(requests.length, 1);
    assert.equal(result.fullText, "");
    assert.equal(result.model, "claude-opus-5-5");
    assert.deepEqual(
        result.usage?.calls?.map((c) => c.model),
        ["claude-opus-5-5"],
    );
});

test("a refusal after answer text was streamed is not retried", async (t) => {
    const requests = mockMessages(t, [
        message("claude-opus-5-5", "refusal", "Djelomičan", refusal("bio")),
    ]);
    const result = await streamChatWithTools(base);
    assert.equal(requests.length, 1);
    assert.equal(result.fullText, "Djelomičan");
});

test("thinking off maps to low effort on Opus 5.5, which rejects disabled thinking", async (t) => {
    const requests = mockMessages(t, [
        message("claude-opus-5-5", "end_turn", "ok"),
        message("claude-sonnet-5", "end_turn", "ok"),
    ]);
    await streamChatWithTools({ ...base, enableThinking: false });
    await streamChatWithTools({
        ...base,
        model: "claude-sonnet-5",
        enableThinking: false,
    });
    assert.equal(requests[0].thinking, undefined);
    assert.deepEqual(requests[0].output_config, { effort: "low" });
    assert.deepEqual(requests[1].thinking, { type: "disabled" });
});

test("thinking off on Sonnet 5.5 is between_tools, which replaced disabled", async (t) => {
    const requests = mockMessages(t, [message("claude-sonnet-5-5", "end_turn", "ok")]);
    await streamChatWithTools({
        ...base,
        model: "claude-sonnet-5-5",
        enableThinking: false,
    });
    // `disabled` is a 400 on Sonnet 5.5; between_tools takes no other field.
    assert.deepEqual(requests[0].thinking, { type: "between_tools" });
    assert.equal(requests[0].output_config, undefined);
});

function mockCompletion(t: TestContext) {
    const requests: any[] = [];
    t.mock.method(
        globalThis,
        "fetch",
        async (_url: unknown, init: RequestInit) => {
            const body = JSON.parse(String(init.body));
            requests.push(body);
            return new Response(
                JSON.stringify({
                    id: "msg_test",
                    type: "message",
                    role: "assistant",
                    model: body.model,
                    content: [
                        { type: "thinking", thinking: "", signature: "sig" },
                        { type: "text", text: "Odgovor." },
                    ],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: 5 },
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json", "request-id": "req_test" },
                },
            );
        },
    );
    return requests;
}

test("completeText keeps thinking on: adaptive at the requested effort, API default otherwise", async (t) => {
    const requests = mockCompletion(t);
    const low = await completeText({
        model: "claude-sonnet-5-5",
        user: "q",
        apiKeys: { claude: "test-key" },
        effort: "low",
    });
    await completeText({ model: "claude-sonnet-5-5", user: "q", apiKeys: { claude: "test-key" } });
    // Text is read by block type — a thinking block comes first.
    assert.equal(low.text, "Odgovor.");
    assert.deepEqual(requests[0].thinking, { type: "adaptive" });
    assert.deepEqual(requests[0].output_config, { effort: "low" });
    assert.equal(requests[1].thinking, undefined);
    assert.equal(requests[1].output_config, undefined);
});

test("completeText drops the partial text of a declined response", async (t) => {
    t.mock.method(console, "warn", () => {});
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Response(
            JSON.stringify({
                id: "msg_test",
                type: "message",
                role: "assistant",
                model: body.model,
                content: [{ type: "text", text: "Trebam pročitati" }],
                stop_reason: "refusal",
                stop_details: { type: "refusal", category: "reasoning_extraction" },
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 3 },
            }),
            { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } },
        );
    });
    const res = await completeText({ model: "claude-sonnet-5-5", user: "q", apiKeys: { claude: "test-key" } });
    // A fragment would pass as a (bad) translation and block the fallback.
    assert.equal(res.text, "");
    assert.ok(res.usage);
});

test("completeText adds thinking room on top of the answer budget for thinking-by-default models", async (t) => {
    const requests = mockCompletion(t);
    await completeText({ model: "claude-sonnet-5-5", user: "q", apiKeys: { claude: "test-key" }, maxTokens: 512 });
    await completeText({ model: "claude-sonnet-5-5", user: "q", apiKeys: { claude: "test-key" }, maxTokens: 64, effort: "low" });
    await completeText({ model: "claude-opus-4-8", user: "q", apiKeys: { claude: "test-key" }, maxTokens: 512 });
    // 512 alone was eaten by high-effort thinking on Sonnet 5.5 (column prompt 502, 30. 9.).
    assert.equal(requests[0].max_tokens, 512 + 8192);
    assert.equal(requests[1].max_tokens, 64 + 2048);
    assert.equal(requests[2].max_tokens, 512);
});

test("every Claude request is reported as its own receipt with the serving endpoint", async (t) => {
    mockMessages(t, [message("claude-opus-5-5", "end_turn", "Odgovor.")]);
    const receipts: LlmCallUsage[] = [];
    const result = await streamChatWithTools({
        ...base,
        onUsage: (u) => receipts.push(...(u.calls ?? [])),
    });
    // A user key goes to the direct API; Vertex receipts carry "vertex:<region>".
    assert.deepEqual(
        receipts.map((c) => [c.status, c.endpoint, c.responseId, c.outputTokens]),
        [["reported", "https://api.anthropic.com/", "msg_test", 50]],
    );
    assert.equal(result.usage?.calls?.length, 1);
    assert.equal(result.usage?.calls?.[0].status, "reported");
});

test("the Vertex receipt endpoint names the configured region", async () => {
    const { claudeReceiptEndpoint } = await import("./claude");
    const prev = process.env.VERTEX_CLAUDE_REGION;
    try {
        delete process.env.VERTEX_CLAUDE_REGION;
        assert.equal(claudeReceiptEndpoint(true), "vertex:eu");
        process.env.VERTEX_CLAUDE_REGION = "global";
        assert.equal(claudeReceiptEndpoint(true), "vertex:global");
        assert.equal(claudeReceiptEndpoint(false), "https://api.anthropic.com/");
    } finally {
        if (prev === undefined) delete process.env.VERTEX_CLAUDE_REGION;
        else process.env.VERTEX_CLAUDE_REGION = prev;
    }
});

test("effort max goes out with the 128k ceiling; the refusal fallback model gets high and 64k", async (t) => {
    const requests = mockMessages(t, [
        message("claude-opus-5-5", "refusal", "", refusal("cyber")),
        message("claude-sonnet-5", "end_turn", "Odgovor."),
    ]);
    const result = await streamChatWithTools({ ...base, reasoningEffort: "max" });
    assert.equal(result.fullText, "Odgovor.");
    assert.deepEqual(
        requests.map((r) => [r.model, r.output_config.effort, r.max_tokens]),
        [
            ["claude-opus-5-5", "max", 128_000],
            // Sonnet 5 was not probed for xhigh / max: sent at high, usual ceiling.
            ["claude-sonnet-5", "high", 64_000],
        ],
    );
});

test("the default effort keeps the 64k ceiling", async (t) => {
    const requests = mockMessages(t, [message("claude-opus-5-5", "end_turn", "Odgovor.")]);
    await streamChatWithTools(base);
    assert.deepEqual([requests[0].output_config.effort, requests[0].max_tokens], ["high", 64_000]);
});
