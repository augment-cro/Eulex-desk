import type { LlmCallUsage, LlmUsage, StreamChatParams } from "./types";

/** Cache the stable instructions even when the per-turn document list changes.
 * Retrieval also caches the growing tool history. A writer only caches its
 * reusable prefix, avoiding a cache-write charge for a one-off evidence brief.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
export function responsesInput(
    params: StreamChatParams,
): Record<string, unknown>[] {
    return [
        {
            role: "developer",
            content: [
                {
                    type: "input_text",
                    text: params.systemPrompt,
                    prompt_cache_breakpoint: { mode: "explicit" },
                },
            ],
        },
        ...(params.systemDynamicSuffix
            ? [{ role: "developer", content: params.systemDynamicSuffix }]
            : []),
        ...params.messages.map((m) => ({ ...m })),
    ];
}

export function responsesCacheOptions(params: StreamChatParams) {
    return {
        prompt_cache_options: {
            mode: params.tools?.length ? "implicit" : "explicit",
            ttl: "30m",
        },
        ...(params.promptCacheKey
            ? { prompt_cache_key: params.promptCacheKey }
            : {}),
    };
}

/** Input categories are disjoint. Reasoning is already INCLUDED in output. */
export function responsesUsage(
    response: {
        model?: string;
        id?: string;
        _request_id?: string;
        service_tier?: string | null;
        usage?: unknown;
    },
    params: StreamChatParams,
    endpoint: string,
    status: LlmCallUsage["status"] = "reported",
): LlmUsage {
    const raw = response.usage as
        | {
              input_tokens?: number;
              output_tokens?: number;
              input_tokens_details?: {
                  cached_tokens?: number;
                  cache_write_tokens?: number;
              };
              output_tokens_details?: { reasoning_tokens?: number };
          }
        | null
        | undefined;
    const cached = raw?.input_tokens_details?.cached_tokens ?? 0;
    const written = raw?.input_tokens_details?.cache_write_tokens ?? 0;
    const counts = {
        inputTokens: Math.max(0, (raw?.input_tokens ?? 0) - cached - written),
        outputTokens: raw?.output_tokens ?? 0,
        cacheCreationInputTokens: written,
        cacheReadInputTokens: cached,
    };
    const valid =
        !!raw &&
        Number.isFinite(raw.input_tokens) &&
        Number.isFinite(raw.output_tokens) &&
        (raw.input_tokens ?? 0) >= cached + written;
    return {
        ...counts,
        iterations: 1,
        ...(!valid ? { incomplete: true } : {}),
        calls: [
            {
                ...counts,
                provider: "openai",
                model: response.model ?? params.model,
                phase: params.usagePhase ?? "single",
                endpoint,
                serviceTier: response.service_tier ?? "default",
                responseId: response.id,
                requestId: response._request_id,
                status: valid
                    ? "reported"
                    : status === "reported"
                      ? "missing"
                      : status,
                reasoningTokens:
                    raw?.output_tokens_details?.reasoning_tokens ?? 0,
                ...(raw ? { rawUsage: raw as Record<string, unknown> } : {}),
            },
        ],
    };
}

/** HTTP validation/auth/rate-limit rejection occurs before a model response.
 * Timeouts and server failures remain unknown (they may have consumed tokens).
 */
export function responsesErrorUsage(
    error: unknown,
    params: StreamChatParams,
    endpoint: string,
): LlmUsage {
    const status = (error as { status?: number })?.status;
    const rejected =
        status != null && [400, 401, 403, 404, 422, 429].includes(status);
    const usage = responsesUsage(
        {},
        params,
        endpoint,
        rejected
            ? "rejected"
            : params.abortSignal?.aborted
              ? "aborted"
              : "error",
    );
    if (rejected) usage.incomplete = false;
    usage.calls![0].httpStatus = status;
    usage.calls![0].requestId = (error as { request_id?: string })?.request_id;
    return usage;
}

export function retryEuGeographyRejection(
    error: unknown,
    endpoint: string,
    attempt: number,
): boolean {
    const e = error as { status?: number; message?: string };
    return (
        attempt < 2 &&
        endpoint.startsWith("https://eu.api.openai.com/") &&
        e?.status === 401 &&
        !!e.message?.includes("geography restrictions enabled")
    );
}
