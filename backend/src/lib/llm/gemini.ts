import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
    LlmUsage,
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";
import { toGeminiTools } from "./tools";

type GeminiPart = {
    text?: string;
    // Set by Gemini when the text content is a thought summary rather than
    // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
    thought?: boolean;
    functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
    functionResponse?: {
        id?: string;
        name: string;
        response: Record<string, unknown>;
    };
    // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
    // a functionCall. It must be echoed back verbatim on the same part when
    // we replay the model's turn, or the API rejects the next call.
    thoughtSignature?: string;
};

type GeminiContent = {
    role: "user" | "model";
    parts: GeminiPart[];
};

function client(override?: string | null): GoogleGenAI {
    const apiKey = override?.trim() || process.env.GEMINI_API_KEY || "";
    // Without explicit retryOptions the SDK performs no retries at all, so
    // a single transient 429/5xx/socket reset failed the whole call (a
    // tabular cell, a chat turn). 5 attempts + a 10-min per-request ceiling
    // match the Claude and OpenAI adapters.
    return new GoogleGenAI({
        apiKey,
        httpOptions: { retryOptions: { attempts: 5 }, timeout: 600_000 },
    });
}

/**
 * Billable output tokens for a Gemini response.
 *
 * Google bills the output rate on *visible output + thinking tokens*, but
 * surfaces them inconsistently: on the Gemini Developer API
 * `candidatesTokenCount` already folds in thoughts, on Vertex it does not,
 * and some preview models (e.g. gemini-3-flash-preview) omit
 * `thoughtsTokenCount` entirely. `totalTokenCount - promptTokenCount`
 * equals candidates + thoughts on *both* surfaces, so we prefer it and only
 * fall back to candidates(+thoughts) when the total is missing. Using
 * `candidatesTokenCount` alone undercounts (and under-bills) every thinking
 * turn — which is most of them, since interactive chat enables thinking.
 */
function geminiOutputTokens(meta: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
}): number {
    const prompt = meta.promptTokenCount ?? 0;
    const total = meta.totalTokenCount ?? 0;
    if (total > prompt) return total - prompt;
    return (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
}

function toNativeContents(messages: StreamChatParams["messages"]): GeminiContent[] {
    return messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));
}

export async function streamGemini(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools, apiKeys, enableThinking, reasoningEffort } = params;
    const maxIter = params.maxIterations ?? 10;
    const ai = client(apiKeys?.gemini);
    const functionDeclarations = toGeminiTools(tools);
    // Gemini's `ThinkingLevel` enum uses uppercase string values
    // ("LOW" | "MEDIUM" | "HIGH"); our public effort knob is lowercase
    // to match the OpenAI/Anthropic naming. Map between them here so
    // the SDK doesn't reject the request with a 400.
    const thinkingLevel: ThinkingLevel =
        reasoningEffort === "low"
            ? ThinkingLevel.LOW
            : reasoningEffort === "medium"
              ? ThinkingLevel.MEDIUM
              : ThinkingLevel.HIGH;

    const contents: GeminiContent[] = toNativeContents(params.messages);
    let fullText = "";
    // Per-turn usage. Gemini surfaces `usageMetadata` on the final
    // chunk of each streaming call; we sum across the tool-use loop.
    const usage: LlmUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        iterations: 0,
    };

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = await ai.models.generateContentStream({
            model,
            contents: contents as never,
            config: {
                systemInstruction: systemPrompt,
                tools: functionDeclarations.length
                    ? [{ functionDeclarations } as never]
                    : undefined,
                // When enabled, ask Gemini to surface thought summaries
                // and dial the depth via `thinkingLevel` (Gemini 3 native
                // knob — "low" | "medium" | "high"). When disabled,
                // explicitly zero the thinking budget so the model skips
                // thinking entirely (saves tokens and latency for bulk
                // extraction jobs).
                thinkingConfig: enableThinking
                    ? { includeThoughts: true, thinkingLevel }
                    : { thinkingBudget: 0 },
            },
        });

        // Per-iteration accumulators.
        const textParts: string[] = [];
        const callParts: GeminiPart[] = [];
        const toolCalls: NormalizedToolCall[] = [];
        let sawThinking = false;

        for await (const chunk of stream) {
            console.log("[gemini stream chunk]", JSON.stringify(chunk, null, 2));
            // Capture `usageMetadata` whenever Gemini surfaces it
            // (typically on the final chunk of each call). Map fields
            // onto our LlmUsage shape — `cachedContentTokenCount` lines
            // up with Anthropic's `cache_read_input_tokens`.
            const meta = (
                chunk as unknown as {
                    usageMetadata?: {
                        promptTokenCount?: number;
                        candidatesTokenCount?: number;
                        cachedContentTokenCount?: number;
                        thoughtsTokenCount?: number;
                        totalTokenCount?: number;
                    };
                }
            ).usageMetadata;
            if (meta) {
                usage.iterations += 1;
                const cached = meta.cachedContentTokenCount ?? 0;
                const promptTotal = meta.promptTokenCount ?? 0;
                usage.inputTokens += Math.max(0, promptTotal - cached);
                usage.cacheReadInputTokens += cached;
                usage.outputTokens += geminiOutputTokens(meta);
            }
            const parts =
                (chunk as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
                    .candidates?.[0]?.content?.parts ?? [];

            for (const part of parts) {
                if (part.text) {
                    if (part.thought) {
                        sawThinking = true;
                        callbacks.onReasoningDelta?.(part.text);
                    } else {
                        textParts.push(part.text);
                        callbacks.onContentDelta?.(part.text);
                    }
                }
                if (part.functionCall) {
                    // Preserve the whole part (including thoughtSignature)
                    // so it can be echoed verbatim in the replay turn.
                    callParts.push(part);
                    const call: NormalizedToolCall = {
                        id: part.functionCall.id ?? `${part.functionCall.name}-${toolCalls.length}`,
                        name: part.functionCall.name,
                        input: part.functionCall.args ?? {},
                    };
                    callbacks.onToolCallStart?.(call);
                    toolCalls.push(call);
                }
            }
        }

        if (sawThinking) callbacks.onReasoningBlockEnd?.();

        fullText += textParts.join("");

        if (!toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        // Append the model's turn (text + functionCall parts, in that order)
        // and the matching functionResponse turn.
        const modelParts: GeminiPart[] = [];
        if (textParts.length) modelParts.push({ text: textParts.join("") });
        for (const cp of callParts) modelParts.push(cp);
        contents.push({ role: "model", parts: modelParts });

        contents.push({
            role: "user",
            parts: results.map((r) => {
                const match = toolCalls.find((c) => c.id === r.tool_use_id);
                return {
                    functionResponse: {
                        ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                            ? { id: r.tool_use_id }
                            : {}),
                        name: match?.name ?? "tool",
                        response: { output: r.content },
                    },
                };
            }),
        });
    }

    return { fullText, usage: usage.iterations > 0 ? usage : undefined };
}

export async function completeGeminiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    apiKeys?: { gemini?: string | null };
}): Promise<{ text: string; usage?: LlmUsage }> {
    const ai = client(params.apiKeys?.gemini);
    const resp = await ai.models.generateContent({
        model: params.model,
        contents: [{ role: "user", parts: [{ text: params.user }] }],
        config: params.systemPrompt
            ? { systemInstruction: params.systemPrompt }
            : undefined,
    });

    // Gemini surfaces `usageMetadata` on every response. We map
    // `cachedContentTokenCount` onto `cacheReadInputTokens` to keep
    // the cost model symmetric with Anthropic — see streamGemini for
    // the same pattern.
    const meta = (resp as unknown as {
        usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            cachedContentTokenCount?: number;
            thoughtsTokenCount?: number;
            totalTokenCount?: number;
        };
    }).usageMetadata;
    const usage: LlmUsage | undefined = meta
        ? (() => {
              const cached = meta.cachedContentTokenCount ?? 0;
              const promptTotal = meta.promptTokenCount ?? 0;
              return {
                  iterations: 1,
                  inputTokens: Math.max(0, promptTotal - cached),
                  outputTokens: geminiOutputTokens(meta),
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: cached,
              };
          })()
        : undefined;
    return { text: resp.text ?? "", usage };
}
