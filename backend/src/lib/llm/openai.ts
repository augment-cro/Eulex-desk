import OpenAI from "openai";
import {
    responsesInput,
    responsesCacheOptions,
    responsesUsage,
    responsesErrorUsage,
    retryEuGeographyRejection,
} from "./openaiResponses";
import { emptyUsage, sumUsage, attachUsage } from "./usage";
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
//
// OPENAI_EU routes every OpenAI-direct call to the EU data-residency
// endpoint. The project must meet OpenAI's EU eligibility and retention
// requirements; OPENAI_EU=0/unset selects the standard endpoint.
function openaiBaseUrl(): string | undefined {
    const eu = process.env.OPENAI_EU;
    return eu === "1" || eu === "true"
        ? "https://eu.api.openai.com/v1"
        : undefined;
}

function openaiClient(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.OPENAI_API_KEY || "";
    return new OpenAI({
        apiKey,
        baseURL: openaiBaseUrl(),
        maxRetries: 5,
        timeout: 600_000,
    });
}

function vllmClient(override?: string | null): OpenAI {
    const apiKey = override?.trim() || process.env.VLLM_API_KEY || "";
    const baseURL = process.env.VLLM_BASE_URL || "http://localhost:8000/v1";
    console.log("[localllm] Client init:", {
        baseURL,
        apiKeyPresent: !!apiKey,
    });
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
        return (
            process.env.VLLM_LIGHT_MODEL || "unsloth/gemma-4-E2B-it-GGUF:Q5_K_S"
        );
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

// gpt-5.6-* (sol/terra) reject function tools on /v1/chat/completions when
// reasoning is on ("use /v1/responses or set reasoning_effort to 'none'").
// Their agentic value IS the reasoning, so those models go through the
// Responses API instead. Older gpt-5.x stay on Chat Completions untouched.
function usesResponsesApi(model: string): boolean {
    return model.startsWith("gpt-5.6");
}

/**
 * Responses-API tool loop for the gpt-5.6 family. Stateless on purpose
 * (`store: false`, full item list resent each iteration) so it also works
 * on zero-data-retention projects, where `previous_response_id` chaining
 * is unavailable. Non-streaming per
 * iteration: the orchestration retriever (the intended caller) never
 * streams text to the user anyway; onContentDelta still fires once per
 * iteration with that iteration's text.
 */
async function streamOpenAIResponses(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        reasoningEffort,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const client = getClient(model, apiKeys?.openai);

    const responseTools = (tools ?? []).map((t) => ({
        type: "function" as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: false,
    }));

    const input = responsesInput(params);

    let fullText = "";
    let usage = emptyUsage();
    let responseModel = model;
    const endpoint = `${client.baseURL.replace(/\/$/, "")}/responses`;
    const report = (delta: LlmUsage) => {
        usage = sumUsage(usage, delta);
        params.onUsage?.(delta);
    };

    try {
        for (let iter = 0; iter < maxIter; iter++) {
            if (params.abortSignal?.aborted) break;
            // Last allowed iteration: force a text answer. Without this an
            // agentic model that wants ANOTHER tool call on every iteration
            // exhausts the loop having produced zero text (seen on bench
            // Q08 — 24 iterations of case-law hunting, empty brief).
            const lastIteration = iter === maxIter - 1;
            let resp: OpenAI.Responses.Response | undefined;
            for (let attempt = 0; ; attempt++) {
                try {
                    resp = await client.responses.create(
                        {
                            model: getActualModelName(model),
                            input: input as never,
                            ...responsesCacheOptions(params),
                            ...(responseTools.length
                                ? {
                                      tools: responseTools as never,
                                      ...(lastIteration
                                          ? { tool_choice: "none" as const }
                                          : {}),
                                  }
                                : {}),
                            reasoning: { effort: reasoningEffort ?? "high" },
                            service_tier: "default",
                            store: false,
                        },
                        params.abortSignal
                            ? { signal: params.abortSignal }
                            : undefined,
                    );
                    break;
                } catch (error) {
                    report(responsesErrorUsage(error, params, endpoint));
                    // Identical EU requests have alternated between 401 and 200.
                    // A bounded retry does not establish regional eligibility.
                    // Retry twice in EU; never reroute globally.
                    if (
                        !params.abortSignal?.aborted &&
                        retryEuGeographyRejection(error, endpoint, attempt)
                    )
                        continue;
                    throw error;
                }
            }
            if (!resp) throw new Error("OpenAI returned no response");
            responseModel = resp.model;
            report(responsesUsage(resp, params, endpoint));
            params.onStreamActivity?.();

            // Carry the FULL output (reasoning + function_call items) into
            // the next iteration's input — required by the stateless loop.
            input.push(
                ...(resp.output as unknown as Record<string, unknown>[]),
            );

            const text = resp.output_text ?? "";
            if (text) {
                fullText += text;
                callbacks.onContentDelta?.(text);
            }

            const calls: NormalizedToolCall[] = (resp.output ?? [])
                .filter(
                    (o): o is Extract<typeof o, { type: "function_call" }> =>
                        o.type === "function_call",
                )
                .map((o) => {
                    let parsed: Record<string, unknown> = {};
                    try {
                        parsed = JSON.parse(o.arguments || "{}");
                    } catch {}
                    return { id: o.call_id, name: o.name, input: parsed };
                });

            if (!calls.length || !runTools) break;
            for (const c of calls) callbacks.onToolCallStart?.(c);

            const results = await runTools(calls);
            for (const r of results) {
                input.push({
                    type: "function_call_output",
                    call_id: r.tool_use_id,
                    output: [
                        {
                            type: "input_text",
                            text: r.content,
                            prompt_cache_breakpoint: { mode: "explicit" },
                        },
                    ],
                });
            }
        }
    } catch (error) {
        if (!params.abortSignal?.aborted)
            throw attachUsage(error, { usage, model: responseModel });
    }

    return {
        fullText,
        model: responseModel,
        usage: usage.iterations > 0 ? usage : undefined,
    };
}

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    if (usesResponsesApi(params.model)) {
        return streamOpenAIResponses(params);
    }
    const {
        model,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        reasoningEffort,
    } = params;
    const systemPrompt =
        params.systemPrompt + (params.systemDynamicSuffix ?? "");
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
        ...params.messages.map(
            (m): OpenAI.ChatCompletionMessageParam =>
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
            if (params.abortSignal?.aborted) break;
            const stream = await client.chat.completions.create(
                {
                    model: actualModel,
                    messages,
                    tools: openaiTools,
                    stream: true,
                    ...(isLocalModel(model)
                        ? {}
                        : { stream_options: { include_usage: true } }),
                    ...(effortParam as Record<string, unknown>),
                },
                params.abortSignal ? { signal: params.abortSignal } : undefined,
            );

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
                    const cached =
                        chunkUsage.prompt_tokens_details?.cached_tokens ?? 0;
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
        // Client Stop: the aborted fetch surfaces as an APIUserAbortError /
        // AbortError. Mirror the Claude adapter — return the partial result
        // instead of throwing, so the caller persists what was streamed.
        if (!params.abortSignal?.aborted) {
            if (isLocalModel(model)) {
                console.error("[localllm] streaming error:", error.message);
                console.error(
                    "[localllm] error details:",
                    JSON.stringify(error, null, 2),
                );
            }
            throw error;
        }
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
