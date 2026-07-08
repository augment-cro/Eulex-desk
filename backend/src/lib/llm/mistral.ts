import { Mistral } from "@mistralai/mistralai";
import type {
    LlmUsage,
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";

const MAX_TOKENS = 16384;

function client(override?: string | null): Mistral {
    const apiKey = override?.trim() || process.env.MISTRAL_API_KEY || "";
    // The SDK ships with no retry strategy by default, so a single
    // transient 429/5xx/socket reset failed the whole call. Backoff caps
    // at ~1 min total, in line with the other adapters' retry behaviour.
    return new Mistral({
        apiKey,
        retryConfig: {
            strategy: "backoff",
            backoff: {
                initialInterval: 500,
                maxInterval: 10_000,
                exponent: 1.8,
                maxElapsedTime: 60_000,
            },
            retryConnectionErrors: true,
        },
    });
}

/**
 * Mistral exposes a *binary* reasoning switch (`reasoning_effort: "none" | "high"`,
 * see the SDK's ReasoningEffort enum) — there is no low/medium/high dial like
 * Claude / Gemini / OpenAI. Only Small and Medium are reasoning models; Large 3
 * is not, so we never send the param to it (and the picker hides it). The UI
 * surfaces this as "Nema" / "Visoka" mapped onto our shared low/high effort, so
 * here anything other than an explicit "high" disables reasoning.
 */
function mistralSupportsReasoningEffort(model: string): boolean {
    return model.startsWith("mistral-small") || model.startsWith("mistral-medium");
}

function mistralReasoningEffort(
    model: string,
    effort: "low" | "medium" | "high" | undefined,
): "none" | "high" | undefined {
    if (!mistralSupportsReasoningEffort(model)) return undefined;
    return effort === "high" ? "high" : "none";
}

type MistralMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null | undefined;
    tool_call_id?: string;
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};

export async function streamMistral(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const reasoningEffort = mistralReasoningEffort(model, params.reasoningEffort);
    const mistral = client(apiKeys?.mistral);

    // Mistral rejects assistant messages with empty/blank content and no tool_calls.
    // Remove any [user, assistant(empty)] pairs from history (failed prior attempts).
    const skipIndices = new Set<number>();
    for (let i = 0; i < params.messages.length; i++) {
        const m = params.messages[i];
        if (m.role === "assistant" && !m.content?.trim()) {
            skipIndices.add(i);
            // Also drop the preceding user message to avoid consecutive user messages.
            if (i > 0 && params.messages[i - 1]?.role === "user") {
                skipIndices.add(i - 1);
            }
        }
    }
    const filteredMessages = params.messages.filter((_, i) => !skipIndices.has(i));

    const messages: MistralMessage[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...filteredMessages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
        })),
    ];

    let fullText = "";
    // Per-turn token usage accumulated across the tool-use loop.
    // Mistral surfaces an OpenAI-shape `usage` block on the final chunk
    // of each streaming call (no cache fields — Mistral does not expose
    // prompt caching).
    const usage: LlmUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        iterations: 0,
    };

    const mistralTools = tools.map((t) => ({
        type: "function" as const,
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
    }));

    for (let iter = 0; iter < maxIter; iter++) {
        let stream: Awaited<ReturnType<typeof mistral.chat.stream>>;
        try {
            stream = await mistral.chat.stream({
                model,
                messages: messages as Parameters<typeof mistral.chat.stream>[0]["messages"],
                tools: mistralTools.length ? mistralTools : undefined,
                maxTokens: MAX_TOKENS,
                ...(reasoningEffort ? { reasoningEffort } : {}),
            });
        } catch (err: unknown) {
            const body = (err as { body?: string }).body ?? "";
            if (
                (err as { statusCode?: number }).statusCode === 400 &&
                body.includes("too large for model")
            ) {
                throw new Error(
                    "The document or conversation is too long for this model's context window. Try asking about a specific section, or start a new chat.",
                );
            }
            throw err;
        }

        let currentText = "";
        // Accumulate tool call chunks by index — Mistral streams name + args incrementally
        const pendingCalls = new Map<number, { id: string; name: string; argsStr: string }>();
        let finishReason = "";

        for await (const chunk of stream) {
            // Mistral surfaces `usage` on chunks at end-of-stream. Sum
            // across the loop. Some chunks don't carry usage at all,
            // hence the optional chain.
            const u = (chunk.data as unknown as {
                usage?: { promptTokens?: number; completionTokens?: number };
            }).usage;
            if (u && (u.promptTokens || u.completionTokens)) {
                usage.iterations += 1;
                usage.inputTokens += u.promptTokens ?? 0;
                usage.outputTokens += u.completionTokens ?? 0;
            }
            const choice = chunk.data.choices[0];
            if (!choice) continue;

            finishReason = choice.finishReason ?? "";

            const delta = choice.delta;
            if (delta.content && typeof delta.content === "string") {
                callbacks.onContentDelta?.(delta.content);
                currentText += delta.content;
            }

            if (delta.toolCalls) {
                for (const tc of delta.toolCalls) {
                    const idx = (tc as { index?: number }).index ?? 0;
                    if (!pendingCalls.has(idx)) {
                        pendingCalls.set(idx, {
                            id: tc.id ?? `tool-${iter}-${idx}`,
                            name: tc.function?.name ?? "",
                            argsStr: "",
                        });
                    }
                    const pending = pendingCalls.get(idx)!;
                    if (tc.id) pending.id = tc.id;
                    if (tc.function?.name) pending.name = tc.function.name;
                    if (tc.function?.arguments) {
                        pending.argsStr +=
                            typeof tc.function.arguments === "string"
                                ? tc.function.arguments
                                : JSON.stringify(tc.function.arguments);
                    }
                }
            }
        }

        // Build final tool calls from accumulated map after stream ends
        const toolCalls: NormalizedToolCall[] = [];
        for (const [, tc] of [...pendingCalls.entries()].sort(([a], [b]) => a - b)) {
            let input: Record<string, unknown> = {};
            try {
                input = tc.argsStr ? JSON.parse(tc.argsStr) : {};
            } catch {
                input = {};
            }
            const call: NormalizedToolCall = { id: tc.id, name: tc.name, input };
            callbacks.onToolCallStart?.(call);
            toolCalls.push(call);
        }

        fullText += currentText;

        if (finishReason !== "tool_calls" || !toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        // Use camelCase `toolCalls` — the Mistral SDK's Zod schema ignores snake_case `tool_calls`.
        const assistantMsg = {
            role: "assistant" as const,
            content: currentText || null,
            toolCalls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.input),
                },
            })),
        };
        messages.push(assistantMsg as unknown as MistralMessage);

        for (const result of results) {
            messages.push({
                role: "tool",
                content: result.content,
                toolCallId: result.tool_use_id,
            } as unknown as MistralMessage);
        }
    }

    return { fullText, usage: usage.iterations > 0 ? usage : undefined };
}

export async function completeMistralText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { mistral?: string | null };
}): Promise<{ text: string; usage?: LlmUsage }> {
    const mistral = client(params.apiKeys?.mistral);
    const resp = await mistral.chat.complete({
        model: params.model,
        maxTokens: params.maxTokens ?? 512,
        messages: [
            ...(params.systemPrompt
                ? [{ role: "system" as const, content: params.systemPrompt }]
                : []),
            { role: "user" as const, content: params.user },
        ],
    });
    const content = resp.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : "";

    // Mistral exposes prompt/completion totals — no cache distinction
    // (Mistral does not bill caching separately for the models we use),
    // so cacheRead/Write stay 0.
    const mu = (resp as unknown as {
        usage?: { promptTokens?: number; completionTokens?: number };
    }).usage;
    const usage: LlmUsage | undefined =
        mu && (mu.promptTokens || mu.completionTokens)
            ? {
                  iterations: 1,
                  inputTokens: mu.promptTokens ?? 0,
                  outputTokens: mu.completionTokens ?? 0,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 0,
              }
            : undefined;
    return { text, usage };
}

export type { NormalizedToolResult };
