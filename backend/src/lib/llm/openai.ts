import OpenAI from "openai";
import type {
    LlmUsage,
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";

// ---------------------------------------------------------------------------
// Client factory — returns either an OpenAI-direct client or a vLLM-
// compatible client depending on the model being used.
// ---------------------------------------------------------------------------

function isLocalModel(model: string): boolean {
    return model.startsWith("localllm");
}

// maxRetries/timeout match the Claude adapter (claude.ts client()): the SDK
// default of 2 retries is not enough for the transient Cloud Run socket
// resets we see mid-stream; 5 attempts + a 10-min per-request ceiling keep
// long tabular extractions alive without hanging forever.
function openaiClient(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.OPENAI_API_KEY || "";
    return new OpenAI({ apiKey, maxRetries: 5, timeout: 600_000 });
}

function vllmClient(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.VLLM_API_KEY || "";
    const baseURL = process.env.VLLM_BASE_URL || "http://localhost:8000/v1";
    console.log("[localllm] Client init:", { baseURL, apiKeyPresent: !!apiKey });
    return new OpenAI({ apiKey, baseURL, maxRetries: 5, timeout: 600_000 });
}

function getClient(model: string, apiKeyOverride?: string | null): OpenAI {
    if (isLocalModel(model)) return vllmClient(apiKeyOverride);
    return openaiClient(apiKeyOverride);
}

function getActualModelName(model: string): string {
    if (model === "localllm-main") {
        return process.env.VLLM_MAIN_MODEL || "BredaAI";
    }
    if (model === "localllm-lite") {
        return process.env.VLLM_LIGHT_MODEL || "unsloth/gemma-4-E2B-it-GGUF:Q5_K_S";
    }
    return model;
}

// ---------------------------------------------------------------------------
// Tool conversion
// ---------------------------------------------------------------------------

function toOpenAITools(
    tools: StreamChatParams["tools"],
): OpenAI.ChatCompletionTool[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
        type: "function" as const,
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
    }));
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

// Models that accept the GPT-5/o-series `reasoning_effort` parameter.
// Sending it to a non-reasoning model (e.g. gpt-5.4-nano if treated as
// non-reasoning, or local models) returns a 400. LocalLLM is always off
// because vLLM doesn't surface reasoning_effort uniformly.
function supportsReasoningEffort(model: string): boolean {
    if (model.startsWith("localllm")) return false;
    return (
        model.startsWith("gpt-5") ||
        model.startsWith("o1") ||
        model.startsWith("o3") ||
        model.startsWith("o4")
    );
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        reasoningEffort,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const actualModel = getActualModelName(model);
    const client = getClient(model, apiKeys?.openai);
    const openaiTools = toOpenAITools(tools);
    const effortParam = supportsReasoningEffort(model)
        ? { reasoning_effort: reasoningEffort ?? "high" }
        : {};

    if (isLocalModel(model)) {
        console.log("[localllm] streaming request:", {
            internalModel: model,
            actualModel,
            baseURL: process.env.VLLM_BASE_URL,
        });
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...params.messages.map((m): OpenAI.ChatCompletionMessageParam =>
            m.role === "assistant"
                ? { role: "assistant", content: m.content }
                : { role: "user", content: m.content },
        ),
    ];

    let fullText = "";
    // Per-turn usage. OpenAI Chat Completions streaming only emits the
    // `usage` block when we explicitly opt in via `stream_options`. We
    // ignore it for vLLM/LocalLLM (uneven server support) and just leave
    // counters at zero — that path is self-hosted anyway and not subject
    // to the SaaS rate limit.
    const usage: LlmUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        iterations: 0,
    };

    try {
        for (let iter = 0; iter < maxIter; iter++) {
            const stream = await client.chat.completions.create({
                model: actualModel,
                messages,
                tools: openaiTools,
                stream: true,
                ...(isLocalModel(model)
                    ? {}
                    : { stream_options: { include_usage: true } }),
                ...(effortParam as Record<string, unknown>),
            });

            const textParts: string[] = [];
            const toolCalls: NormalizedToolCall[] = [];
            const toolCallAccumulators: Map<
                number,
                { id: string; name: string; args: string }
            > = new Map();

            for await (const chunk of stream) {
                // The final chunk in an `include_usage` stream has no
                // `choices` array but carries `usage`. Capture it before
                // the early-continue further down.
                const chunkUsage = (
                    chunk as unknown as {
                        usage?: {
                            prompt_tokens?: number;
                            completion_tokens?: number;
                            prompt_tokens_details?: {
                                cached_tokens?: number;
                            };
                        };
                    }
                ).usage;
                if (chunkUsage) {
                    usage.iterations += 1;
                    const cached = chunkUsage.prompt_tokens_details?.cached_tokens ?? 0;
                    const promptTotal = chunkUsage.prompt_tokens ?? 0;
                    // OpenAI reports prompt_tokens as the FULL prompt
                    // size including cache hits. Split it so our
                    // bookkeeping mirrors Anthropic's semantics
                    // (cache_read counted separately, fresh input on
                    // its own line).
                    usage.inputTokens += Math.max(0, promptTotal - cached);
                    usage.cacheReadInputTokens += cached;
                    usage.outputTokens += chunkUsage.completion_tokens ?? 0;
                }

                const delta = chunk.choices[0]?.delta;
                if (!delta) continue;

                if (delta.content) {
                    textParts.push(delta.content);
                    callbacks.onContentDelta?.(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const existing = toolCallAccumulators.get(tc.index);
                        if (existing) {
                            if (tc.function?.arguments)
                                existing.args += tc.function.arguments;
                        } else {
                            toolCallAccumulators.set(tc.index, {
                                id: tc.id ?? `tool-${tc.index}`,
                                name: tc.function?.name ?? "",
                                args: tc.function?.arguments ?? "",
                            });
                        }
                    }
                }
            }

            for (const [, acc] of toolCallAccumulators) {
                let input: Record<string, unknown> = {};
                try {
                    input = JSON.parse(acc.args);
                } catch {}
                const call: NormalizedToolCall = {
                    id: acc.id,
                    name: acc.name,
                    input,
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }

            fullText += textParts.join("");

            if (!toolCalls.length || !runTools) {
                break;
            }

            const results = await runTools(toolCalls);

            const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
                role: "assistant",
                content: textParts.join("") || "",
                tool_calls: toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: {
                        name: tc.name,
                        arguments: JSON.stringify(tc.input),
                    },
                })),
            };
            messages.push(assistantMsg);

            for (const r of results) {
                messages.push({
                    role: "tool",
                    tool_call_id: r.tool_use_id,
                    content: r.content,
                });
            }
        }
    } catch (error: any) {
        if (isLocalModel(model)) {
            console.error("[localllm] streaming error:", error.message);
            console.error("[localllm] error details:", JSON.stringify(error, null, 2));
        }
        throw error;
    }

    return { fullText, usage: usage.iterations > 0 ? usage : undefined };
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<{ text: string; usage?: LlmUsage }> {
    const actualModel = getActualModelName(params.model);
    const client = getClient(params.model, params.apiKeys?.openai);
    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.user });
    const resp = await client.chat.completions.create({
        model: actualModel,
        messages,
        max_completion_tokens: params.maxTokens ?? 512,
    });

    // OpenAI reports prompt/completion + a `cached_tokens` slice of
    // prompt tokens. We map cached → cacheReadInputTokens to match the
    // Anthropic semantic the cost table already expects.
    const cu = resp.usage;
    const usage: LlmUsage | undefined = cu
        ? (() => {
              const cached = cu.prompt_tokens_details?.cached_tokens ?? 0;
              const promptTotal = cu.prompt_tokens ?? 0;
              return {
                  iterations: 1,
                  inputTokens: Math.max(0, promptTotal - cached),
                  outputTokens: cu.completion_tokens ?? 0,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: cached,
              };
          })()
        : undefined;
    return { text: resp.choices[0]?.message?.content ?? "", usage };
}

export type { NormalizedToolResult };
