import type { StreamChatParams } from "../llm/types";
import {
    getOrchestrationRetrieverPrompt,
    getOrchestrationWriterSuffix,
} from "../seams/promptPack";

/** Shared by the production flow and the paired, frozen-brief benchmark. */
export function buildRetrieverParams(
    base: StreamChatParams,
    model: string,
    maxIterations = 24,
): StreamChatParams {
    return {
        ...base,
        model,
        usagePhase: "retriever",
        systemPrompt: getOrchestrationRetrieverPrompt(),
        maxIterations,
        callbacks: {
            ...base.callbacks,
            onContentDelta: undefined,
            onReasoningDelta: undefined,
            onReasoningBlockEnd: undefined,
        },
    };
}

export function buildWriterParams(
    base: StreamChatParams,
    model: string,
    brief: string,
): StreamChatParams {
    const messages = base.messages.map((message) => ({ ...message }));
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            messages[i].content =
                `PITANJE KORISNIKA:\n${messages[i].content}\n\n=== BRIEF ===\n${brief}`;
            break;
        }
    }
    return {
        ...base,
        model,
        usagePhase: "writer",
        systemDynamicSuffix:
            (base.systemDynamicSuffix ?? "") + getOrchestrationWriterSuffix(),
        messages,
        tools: [],
        runTools: undefined,
        enableWebSearch: false,
        maxIterations: 1,
    };
}
