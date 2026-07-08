import type { LlmUsage } from "./llm/types";
import { computeCostUsd } from "./llmUsage";

/**
 * Terminal `usage` SSE event for /chat (answer-neutral observability enabler,
 * approved 2026-07-03 — bench spec §8 step 0). Mirrors what recordLlmUsage
 * persists to llm_usage so the evals harness can read cost/tokens off the
 * stream instead of the DB. Emitted after runLLMStream returns (post-[DONE],
 * same tail position as message_id) — it cannot influence the answer.
 */
export function buildUsageEvent(args: {
    usage: LlmUsage;
    model: string;
    webSearchCostUsd?: number;
    durationMs: number;
}) {
    const webSearchCostUsd = args.webSearchCostUsd ?? 0;
    return {
        type: "usage" as const,
        model: args.model,
        input_tokens: args.usage.inputTokens,
        output_tokens: args.usage.outputTokens,
        cache_creation_input_tokens: args.usage.cacheCreationInputTokens ?? 0,
        cache_read_input_tokens: args.usage.cacheReadInputTokens ?? 0,
        cost_usd: computeCostUsd(args.model, args.usage) + webSearchCostUsd,
        web_search_cost_usd: webSearchCostUsd,
        duration_ms: args.durationMs,
    };
}
