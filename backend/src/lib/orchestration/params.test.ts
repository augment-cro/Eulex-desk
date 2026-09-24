import test from "node:test";
import assert from "node:assert/strict";
import { buildRetrieverParams, buildWriterParams } from "./params";
import type { StreamChatParams } from "../llm/types";

test("paired writers receive identical evidence without mutating history or inheriting tools", () => {
    const base: StreamChatParams = {
        model: "original",
        systemPrompt: "full governance prompt",
        systemDynamicSuffix: "documents",
        messages: [
            { role: "user", content: "old question" },
            { role: "assistant", content: "old answer" },
            { role: "user", content: "new question" },
        ],
        enableWebSearch: true,
        tools: [
            {
                type: "function",
                function: { name: "search", description: "", parameters: {} },
            },
        ],
        runTools: async () => [],
        callbacks: { onContentDelta() {} },
        abortSignal: new AbortController().signal,
    };
    const original = structuredClone(base.messages);
    const sonnet = buildWriterParams(base, "claude-sonnet-5", "evidence");
    const sol = buildWriterParams(base, "gpt-5.6-sol", "evidence");
    assert.deepEqual(sol.messages, sonnet.messages);
    assert.equal(sol.systemPrompt, sonnet.systemPrompt);
    assert.equal(sol.systemDynamicSuffix, sonnet.systemDynamicSuffix);
    assert.deepEqual(base.messages, original);
    assert.equal(sol.messages[0].content, "old question");
    assert.equal(
        sol.messages[2].content,
        "PITANJE KORISNIKA:\nnew question\n\n=== BRIEF ===\nevidence",
    );
    for (const writer of [sonnet, sol]) {
        assert.deepEqual(writer.tools, []);
        assert.equal(writer.runTools, undefined);
        assert.equal(writer.enableWebSearch, false);
        assert.equal(writer.maxIterations, 1);
        assert.equal(writer.abortSignal, base.abortSignal);
        assert.equal(writer.callbacks, base.callbacks);
    }
});

test("retriever suppresses user text but preserves tools, document context, liveness and cancellation", () => {
    const onToolCallStart = () => {};
    const onStreamActivity = () => {};
    const base: StreamChatParams = {
        model: "original",
        systemPrompt: "desk",
        systemDynamicSuffix: "docs",
        messages: [{ role: "user", content: "question" }],
        runTools: async () => [],
        onStreamActivity,
        abortSignal: new AbortController().signal,
        callbacks: {
            onContentDelta() {},
            onReasoningDelta() {},
            onReasoningBlockEnd() {},
            onToolCallStart,
        },
    };
    const retriever = buildRetrieverParams(base, "gpt-5.6-sol");
    assert.equal(retriever.callbacks?.onContentDelta, undefined);
    assert.equal(retriever.callbacks?.onReasoningDelta, undefined);
    assert.equal(retriever.callbacks?.onToolCallStart, onToolCallStart);
    assert.equal(retriever.onStreamActivity, onStreamActivity);
    assert.equal(retriever.runTools, base.runTools);
    assert.equal(retriever.abortSignal, base.abortSignal);
    assert.equal(retriever.systemDynamicSuffix, "docs");
    assert.equal(retriever.maxIterations, 24);
    assert.equal(buildRetrieverParams(base, "gpt-5.6-sol", 4).maxIterations, 4);
});
