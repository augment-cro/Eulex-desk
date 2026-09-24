import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { streamMistral, completeMistralText } from "./mistral";
import { providerForModel } from "./models";
import { attachUsage, emptyUsage, sumUsage } from "./usage";
import type {
    LlmUsage,
    StreamChatParams,
    StreamChatResult,
    UserApiKeys,
} from "./types";

export * from "./types";
export * from "./models";
export * from "./stallWatchdog";

/**
 * Stall-watchdog liveness wiring (tracker #25): when the caller supplies
 * `onStreamActivity`, wrap the surfaced-event callbacks and the tool
 * runner so every provider chunk/event re-arms the caller's idle
 * deadline. The wrappers are ALWAYS defined (even where the underlying
 * callback is not) so suppressed streams — e.g. the orchestration
 * retriever, which drops content/reasoning deltas on purpose — still
 * count as live while the provider is producing output. This is the one
 * shared chunk-consumption point both the single-model flow and each
 * orchestrated phase pass through.
 */
function withStreamActivity(params: StreamChatParams): StreamChatParams {
    const touch = params.onStreamActivity;
    if (!touch) return params;
    const base = params.callbacks ?? {};
    return {
        ...params,
        callbacks: {
            onContentDelta: (text) => {
                touch();
                base.onContentDelta?.(text);
            },
            onReasoningDelta: (text) => {
                touch();
                base.onReasoningDelta?.(text);
            },
            onReasoningBlockEnd: () => {
                touch();
                base.onReasoningBlockEnd?.();
            },
            onToolCallStart: (call) => {
                touch();
                base.onToolCallStart?.(call);
            },
        },
        runTools: params.runTools
            ? async (calls) => {
                  touch();
                  try {
                      return await params.runTools!(calls);
                  } finally {
                      // Tool batches can legitimately run long — count the
                      // completed batch as provider liveness so the next
                      // model iteration starts with a fresh deadline.
                      touch();
                  }
              }
            : undefined,
    };
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const provider = providerForModel(params.model);
    let usage = emptyUsage();
    const active = withStreamActivity({
        ...params,
        onUsage: (delta) => {
            usage = sumUsage(usage, delta);
            params.onUsage?.(delta);
        },
    });
    const merged: StreamChatParams = active.systemDynamicSuffix
        ? {
              ...active,
              systemPrompt: active.systemPrompt + active.systemDynamicSuffix,
              systemDynamicSuffix: undefined,
          }
        : active;
    try {
        const result = await (provider === "claude"
            ? streamClaude(active)
            : provider === "openai"
              ? streamOpenAI(active)
              : provider === "mistral"
                ? streamMistral(merged)
                : streamGemini(merged));
        // Older adapters report a turn aggregate. Keep it explicitly labelled
        // as a legacy estimate, never pretend it is a per-request receipt.
        if (!usage.iterations && result.usage) {
            const u = result.usage;
            active.onUsage?.({
                ...u,
                calls: [
                    {
                        provider,
                        model: result.model ?? params.model,
                        phase: params.usagePhase ?? "single",
                        status: "legacy",
                        inputTokens: u.inputTokens,
                        outputTokens: u.outputTokens,
                        cacheCreationInputTokens: u.cacheCreationInputTokens,
                        cacheReadInputTokens: u.cacheReadInputTokens,
                    },
                ],
            });
        }
        return {
            ...result,
            model: result.model ?? params.model,
            usage: usage.iterations ? usage : result.usage,
        };
    } catch (error) {
        if (!usage.iterations)
            active.onUsage?.({ ...emptyUsage(), incomplete: true });
        throw attachUsage(error, { usage, model: params.model });
    }
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
