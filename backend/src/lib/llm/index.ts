import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { streamMistral, completeMistralText } from "./mistral";
import { providerForModel } from "./models";
import type {
    LlmUsage,
    StreamChatParams,
    StreamChatResult,
    UserApiKeys,
} from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    // Only the Claude adapter understands the static/dynamic system split
    // (it maps to two cache blocks). Every other provider does no prompt
    // caching here, so fold the dynamic suffix back onto the system prompt
    // and hand them a plain string — identical instructions, no behavioral
    // change.
    const merged: StreamChatParams = params.systemDynamicSuffix
        ? {
              ...params,
              systemPrompt: `${params.systemPrompt}${params.systemDynamicSuffix}`,
              systemDynamicSuffix: undefined,
          }
        : params;
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(merged);
    if (provider === "mistral") return streamMistral(merged);
    return streamGemini(merged);
}

export type CompleteTextResult = { text: string; usage?: LlmUsage };

/**
 * Single-shot non-streaming completion. Returns the model text PLUS
 * authoritative token usage from the provider, so callers can attribute
 * cost via `recordLlmUsage`. Previously returned only a string — any
 * call site that still treats the return as a string will fail
 * TypeScript compilation, which is intentional (it forces a usage
 * tracking decision at the call site).
 */
export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<CompleteTextResult> {
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    if (provider === "mistral") return completeMistralText(params);
    return completeGeminiText(params);
}

