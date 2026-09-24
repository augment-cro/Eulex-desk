/** Per-request list-price calculation. Sol rates verified 2026-09-13:
 * https://developers.openai.com/api/docs/pricing (promo through at least 2026-11-21).
 * Other adapters still report legacy aggregates; these remain labelled estimates.
 */
import type { LlmCallUsage, LlmUsage } from "./llm/types";
import { providerForModel } from "./llm/models";

type Rate = {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    /**
     * Prompt-length tier per API request, including cache reads and writes.
     */
    longContext?: {
        thresholdTokens: number;
        input: number;
        output: number;
        cacheWrite: number;
        cacheRead: number;
    };
};

const M = 1_000_000;

const PRICING: Record<string, Rate> = {
    "gpt-5.6-sol": {
        input: 4 / M,
        output: 20 / M,
        cacheWrite: 5 / M,
        cacheRead: 0.4 / M,
        longContext: {
            thresholdTokens: 272_000,
            input: 8 / M,
            output: 30 / M,
            cacheWrite: 10 / M,
            cacheRead: 0.8 / M,
        },
    },
    "claude-opus-5": {
        input: 5 / M,
        output: 25 / M,
        cacheWrite: 6.25 / M,
        cacheRead: 0.5 / M,
    },
    // ── Anthropic ──────────────────────────────────────────────────────
    "claude-opus-4-8": {
        input: 5.0 / M,
        output: 25.0 / M,
        cacheWrite: 6.25 / M,
        cacheRead: 0.5 / M,
    },
    // Retired id — keep so historical llm_usage rows still price correctly.
    "claude-opus-4-7": {
        input: 5.0 / M,
        output: 25.0 / M,
        cacheWrite: 6.25 / M,
        cacheRead: 0.5 / M,
    },
    "claude-sonnet-5": {
        input: 2.0 / M,
        output: 10.0 / M,
        cacheWrite: 2.5 / M,
        cacheRead: 0.2 / M,
    },
    // Retired id — keep so historical llm_usage rows still price correctly.
    "claude-sonnet-4-6": {
        input: 3.0 / M,
        output: 15.0 / M,
        cacheWrite: 3.75 / M,
        cacheRead: 0.3 / M,
    },
    "claude-haiku-4-5": {
        input: 1.0 / M,
        output: 5.0 / M,
        cacheWrite: 1.25 / M,
        cacheRead: 0.1 / M,
    },

    // ── Google Gemini ──────────────────────────────────────────────────
    // Pro tiers by prompt size: ≤200k is the base rate, >200k doubles input
    // and lifts output (longContext). cacheWrite stays 0 — we never create
    // an explicit CachedContent, we only reap implicit cache-read savings.
    "gemini-3.1-pro-preview": {
        input: 2.0 / M,
        output: 12.0 / M,
        cacheWrite: 0,
        cacheRead: 0.2 / M,
        longContext: {
            thresholdTokens: 200_000,
            input: 4.0 / M,
            output: 18.0 / M,
            cacheWrite: 0,
            cacheRead: 0.4 / M,
        },
    },
    "gemini-3.5-flash": {
        input: 1.5 / M,
        output: 9.0 / M,
        cacheWrite: 0,
        cacheRead: 0.15 / M,
    },
    "gemini-3-flash-preview": {
        input: 0.5 / M,
        output: 3.0 / M,
        cacheWrite: 0,
        cacheRead: 0.05 / M,
    },
    // Flash-Lite has no published context-cache rate (caching N/A).
    "gemini-3.1-flash-lite-preview": {
        input: 0.25 / M,
        output: 1.5 / M,
        cacheWrite: 0,
        cacheRead: 0,
    },

    // ── Mistral ────────────────────────────────────────────────────────
    // The Mistral models we use expose no separate prompt-cache rate, and
    // the adapter never populates cache fields, so cacheWrite/Read are 0.
    "mistral-large-latest": {
        input: 0.5 / M,
        output: 1.5 / M,
        cacheWrite: 0,
        cacheRead: 0,
    },
    "mistral-medium-latest": {
        input: 1.5 / M,
        output: 7.5 / M,
        cacheWrite: 0,
        cacheRead: 0,
    },
    "mistral-small-latest": {
        input: 0.1 / M,
        output: 0.3 / M,
        cacheWrite: 0,
        cacheRead: 0,
    },

    // ── OpenAI ─────────────────────────────────────────────────────────
    // Caching is automatic with no write surcharge → cacheWrite 0; the
    // cached-input discount maps onto cacheRead (adapter reads
    // prompt_tokens_details.cached_tokens). LocalLLM stays unpriced.
    "gpt-5.5": {
        input: 5.0 / M,
        output: 30.0 / M,
        cacheWrite: 0,
        cacheRead: 0.5 / M,
    },
    "gpt-5.4-mini": {
        input: 0.75 / M,
        output: 4.5 / M,
        cacheWrite: 0,
        cacheRead: 0.075 / M,
    },
    "gpt-5.4-nano": {
        input: 0.2 / M,
        output: 1.25 / M,
        cacheWrite: 0,
        cacheRead: 0.02 / M,
    },
};

const rounded = (value: number) => Math.round(value * 1e10) / 1e10;

function priceCall(call: LlmCallUsage) {
    const model = call.model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const rate = PRICING[model];
    const promptTokens =
        call.inputTokens +
        call.cacheCreationInputTokens +
        call.cacheReadInputTokens;
    const longContext =
        !!rate?.longContext && promptTokens > rate.longContext.thresholdTokens;
    const r = longContext ? rate!.longContext! : rate;
    const sol = model === "gpt-5.6-sol";
    const tier = call.serviceTier ?? "default";
    const tierMultiplier = sol
        ? (
              {
                  default: 1,
                  standard: 1,
                  priority: 2,
                  fast: 2,
                  flex: 0.5,
                  batch: 0.5,
              } as Record<string, number>
          )[tier]
        : 1;
    const euMultiplier =
        sol && call.endpoint?.startsWith("https://eu.api.openai.com/")
            ? 1.1
            : 1;
    const reported = call.status === "reported" || call.status === "legacy";
    const costUsd =
        call.status === "rejected"
            ? 0
            : !r || tierMultiplier == null || !reported
              ? null
              : rounded(
                    (call.inputTokens * r.input +
                        call.outputTokens * r.output +
                        call.cacheCreationInputTokens * r.cacheWrite +
                        call.cacheReadInputTokens * r.cacheRead) *
                        tierMultiplier *
                        euMultiplier,
                );
    return {
        ...call,
        promptTokens,
        longContext,
        tierMultiplier,
        euMultiplier,
        ratesUsdPerMillion: r
            ? {
                  input: r.input * M,
                  output: r.output * M,
                  cacheWrite: r.cacheWrite * M,
                  cacheRead: r.cacheRead * M,
              }
            : null,
        costUsd,
    };
}

export function priceUsage(model: string, usage: LlmUsage, extraCostUsd = 0) {
    const safeExtra = Number.isFinite(extraCostUsd)
        ? Math.max(0, extraCostUsd)
        : 0;
    const hasTokens =
        usage.inputTokens +
            usage.outputTokens +
            usage.cacheCreationInputTokens +
            usage.cacheReadInputTokens >
        0;
    let aggregateProvider: LlmCallUsage["provider"] = "unknown";
    try {
        aggregateProvider = providerForModel(model);
    } catch {}
    const receipts: LlmCallUsage[] = usage.calls?.length
        ? usage.calls
        : hasTokens
          ? [
                {
                    provider: aggregateProvider,
                    model,
                    phase: "single",
                    status: "legacy",
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheCreationInputTokens: usage.cacheCreationInputTokens,
                    cacheReadInputTokens: usage.cacheReadInputTokens,
                },
            ]
          : [];
    const calls = receipts.map(priceCall);
    const knownLlmCostUsd = rounded(
        calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
    );
    const unknown =
        !!usage.incomplete || calls.some((call) => call.costUsd == null);
    const perRequest = calls.every(
        (call) => call.status === "reported" || call.status === "rejected",
    );
    return {
        version: 1,
        pricingVersion: "2026-09-13",
        currency: "USD",
        basis: perRequest ? "provider_usage_list_price" : "legacy_estimate",
        complete: !unknown && perRequest,
        knownLlmCostUsd,
        extraCostUsd: safeExtra,
        knownCostUsd: rounded(knownLlmCostUsd + safeExtra),
        costUsd: unknown ? null : rounded(knownLlmCostUsd + safeExtra),
        calls,
    };
}

/** Unknown or incomplete usage is never reported as a free query. */
export function computeCostUsd(model: string, usage: LlmUsage): number | null {
    return priceUsage(model, usage).costUsd;
}
