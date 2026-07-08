/**
 * Per-turn LLM cost tracking.
 *
 * Anthropic returns authoritative token counts on every API response.
 * The provider does NOT return a USD figure on the wire — we compute
 * it here from the published per-million-token rates so the numbers
 * match what shows up on the Anthropic console invoice.
 *
 * Pricing references (per-million-token rates, USD), verified against the
 * providers' public pricing pages May 2026. Each adapter normalises usage
 * to the same four-field shape (input / output / cacheWrite / cacheRead)
 * — see lib/llm/{claude,gemini,openai,mistral}.ts — so a single table prices
 * every provider.
 *
 *   ── Anthropic (Anthropic pricing page) ──────────────────────────────
 *   Claude Opus 4.8 (claude-opus-4-8):   in $5.00  out $25.00  cw $6.25  cr $0.50
 *   Claude Sonnet 5 (claude-sonnet-5):   in $3.00  out $15.00  cw $3.75  cr $0.30
 *     (Anthropic intro pricing $2/$10 runs through 2026-08-31; we track at the
 *      standard $3/$15 so cost reporting doesn't jump when intro pricing ends.)
 *   Claude Haiku 4.5 (claude-haiku-4-5): in $1.00  out $5.00   cw $1.25  cr $0.10
 *     cache write = 5-min ephemeral (1.25× input); cache read ≈ 0.10× input.
 *
 *   ── Google Gemini (ai.google.dev/gemini-api/docs/pricing) ───────────
 *   Gemini 3.1 Pro (gemini-3.1-pro-preview):
 *     ≤200k prompt:  in $2.00  out $12.00  cache-read $0.20
 *     >200k prompt:  in $4.00  out $18.00  cache-read $0.40   (longContext tier)
 *   Gemini 3.5 Flash (gemini-3.5-flash):     in $1.50 out $9.00 cache-read $0.15
 *   Gemini 3 Flash (gemini-3-flash-preview): in $0.50 out $3.00 cache-read $0.05
 *   Gemini 3.1 Flash-Lite (…flash-lite-preview): in $0.25 out $1.50 (no cache)
 *     Gemini bills caching by hourly *storage*, not a per-token write, and we
 *     never create explicit CachedContent — so cacheWrite is 0. The cache-read
 *     savings still land via usageMetadata.cachedContentTokenCount.
 *
 *   ── Mistral (mistral.ai/pricing) ────────────────────────────────────
 *   Mistral Large 3 (mistral-large-latest):  in $0.50  out $1.50
 *   Mistral Medium 3.5 (mistral-medium-latest): in $1.50 out $7.50
 *   Mistral Small 4 (mistral-small-latest):   in $0.10  out $0.30
 *     The models we use expose no separate prompt-cache rate; cache fields 0.
 *
 *   ── OpenAI (developers.openai.com/api/docs/pricing) ─────────────────
 *   GPT-5.5 (gpt-5.5):        in $5.00  cached-in $0.50   out $30.00
 *   GPT-5.4 Mini (gpt-5.4-mini): in $0.75 cached-in $0.075 out $4.50
 *   GPT-5.4 Nano (gpt-5.4-nano): in $0.20 cached-in $0.02  out $1.25
 *     OpenAI caching is automatic with no write surcharge → cacheWrite 0;
 *     the cached-input discount maps onto cacheRead. LocalLLM (vLLM, self-
 *     hosted) is intentionally unpriced — it incurs no per-token API cost.
 *
 * 1h Anthropic cache writes (Opus $10, Sonnet $6, Haiku $2) are NOT modelled:
 * the codebase never sets `cache_control: { ttl: "1h" }`, so we never pay
 * 1h-cache rates. Revisit if long-TTL caching is ever wired up.
 *
 * Add new model entries here when we expose them in product. Unknown
 * model ids fall back to no cost rather than guessing — the row still
 * gets the raw token counts so we can backfill USD later.
 */
import type { LlmUsage } from "./llm/types";
import { query } from "./db";

type Rate = {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    /**
     * Optional long-context tier. Some Gemini models (e.g. 3.1 Pro) bill at
     * a higher rate once a request's prompt crosses a token threshold. When
     * set and the turn's prompt size (uncached input + cache-read tokens)
     * exceeds `thresholdTokens`, these per-token rates replace the base ones.
     * Anthropic, Mistral and the OpenAI models we use don't tier by prompt
     * length, so they leave this undefined.
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
        input: 3.0 / M,
        output: 15.0 / M,
        cacheWrite: 3.75 / M,
        cacheRead: 0.3 / M,
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

/**
 * Compute USD cost for a usage block. Returns 0 (rather than throwing)
 * when the model is unpriced — that way unknown models still get a row
 * with token counts and we can revisit pricing later.
 */
export function computeCostUsd(model: string, usage: LlmUsage): number {
    const rate = PRICING[model];
    if (!rate) return 0;
    // Long-context tier (Gemini Pro): the turn pays the higher rate once its
    // prompt size (uncached input + cached read) exceeds the threshold. We
    // only retain per-turn sums, not per-API-call counts, so for multi-call
    // tool-use turns this is a close approximation, not an exact per-request
    // bracket. Models without `longContext` always use the base rate.
    const promptTokens = usage.inputTokens + usage.cacheReadInputTokens;
    const r =
        rate.longContext && promptTokens > rate.longContext.thresholdTokens
            ? rate.longContext
            : rate;
    const cost =
        usage.inputTokens * r.input +
        usage.outputTokens * r.output +
        usage.cacheCreationInputTokens * r.cacheWrite +
        usage.cacheReadInputTokens * r.cacheRead;
    // Round to 6 decimals to fit numeric(12, 6). The smallest meaningful
    // unit is 1 cache-read token = $3 × 10⁻⁷, which still rounds cleanly.
    return Math.round(cost * 1e6) / 1e6;
}

export type RecordUsageInput = {
    userId: string;
    provider: "claude" | "openai" | "gemini" | "mistral" | string;
    model: string;
    chatId?: string | null;
    projectId?: string | null;
    chatMessageId?: string | null;
    projectChatMessageId?: string | null;
    /** Which surface produced this turn: "web" or "word" (the Word add-in).
     *  Recorded for attribution/reporting; usage is counted toward the
     *  user's quota regardless of client. */
    client?: string | null;
    usage: LlmUsage;
    durationMs?: number | null;
    status?: "ok" | "error" | "aborted";
    errorMessage?: string | null;
    /**
     * Additional USD costs incurred during this turn that don't come
     * from LLM tokens — e.g. web-search provider charges aggregated
     * by lib/searchPricing. Folded into `cost_usd` before insert so
     * the column reflects the *full* per-turn spend. Optional; legacy
     * callers that don't pass it record only the LLM cost.
     */
    extraCostUsd?: number;
};

/**
 * Persist one usage row and emit a structured log line. Failures are
 * swallowed (logged at WARN) — a failed insert must never tear down a
 * successful chat response. This is observability, not core flow.
 */
export async function recordLlmUsage(input: RecordUsageInput): Promise<void> {
    const {
        userId,
        provider,
        model,
        chatId = null,
        projectId = null,
        chatMessageId = null,
        projectChatMessageId = null,
        client = null,
        usage,
        durationMs = null,
        status = "ok",
        errorMessage = null,
        extraCostUsd = 0,
    } = input;

    // LLM token cost + any caller-supplied extras (e.g. web search USD
    // from chatTools.runLLMStream). Re-rounded to 6 decimals to match
    // the numeric(12,6) column and so the structured log line below
    // never shows float drift like "0.00900000000000001".
    const llmCostUsd = computeCostUsd(model, usage);
    const safeExtra = Number.isFinite(extraCostUsd) ? extraCostUsd : 0;
    const costUsd = Math.round((llmCostUsd + safeExtra) * 1e6) / 1e6;

    // Single structured line — easy to grep "[llm/usage]" in Cloud
    // Logging and dump it through `gcloud logging read` for ad-hoc
    // cost reports while we don't yet have a UI.
    console.log(
        `[llm/usage] user=${userId} model=${model} provider=${provider} ` +
            `iters=${usage.iterations} ` +
            `in=${usage.inputTokens} out=${usage.outputTokens} ` +
            `cache_w=${usage.cacheCreationInputTokens} cache_r=${usage.cacheReadInputTokens} ` +
            `cost_usd=${costUsd.toFixed(6)} ` +
            (safeExtra > 0
                ? `(llm=${llmCostUsd.toFixed(6)} extra=${safeExtra.toFixed(6)}) `
                : "") +
            `chat=${chatId ?? "-"} project=${projectId ?? "-"} ` +
            `client=${client ?? "-"} ` +
            `status=${status}` +
            (durationMs != null ? ` duration_ms=${durationMs}` : "") +
            (errorMessage ? ` error=${JSON.stringify(errorMessage)}` : ""),
    );

    try {
        await query(
            `
            INSERT INTO public.llm_usage (
                user_id, provider, model,
                chat_id, project_id,
                chat_message_id, project_chat_message_id,
                iterations,
                input_tokens, output_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                cost_usd, duration_ms, status, error_message,
                client
            ) VALUES (
                $1, $2, $3,
                $4, $5,
                $6, $7,
                $8,
                $9, $10,
                $11, $12,
                $13, $14, $15, $16,
                $17
            )
            `,
            [
                userId,
                provider,
                model,
                chatId,
                projectId,
                chatMessageId,
                projectChatMessageId,
                usage.iterations,
                usage.inputTokens,
                usage.outputTokens,
                usage.cacheCreationInputTokens,
                usage.cacheReadInputTokens,
                costUsd,
                durationMs,
                status,
                errorMessage,
                client,
            ],
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[llm/usage] insert failed (non-fatal): ${msg}`);
    }

    // Drain any overage past the daily quota from active credit packs.
    // We do this AFTER the insert so the rolling-window aggregate the
    // limiter reads next time already includes this turn. Failures are
    // swallowed — they only affect bonus accounting, not the chat reply.
    try {
        await drainCreditsForOverage(userId, usage);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[llm/usage] credit drain failed (non-fatal): ${msg}`);
    }
}

/**
 * Compute the post-call rolling-window total for the user; if it
 * exceeds the daily tier quota, deduct the *new* overage portion from
 * active credit packs (FIFO). The rate limiter still gates future
 * requests off the rolling total — credit consumption is purely the
 * accounting half of "user spent past their daily quota".
 */
async function drainCreditsForOverage(
    userId: string,
    justRecorded: LlmUsage,
): Promise<void> {
    // Lazy import to avoid a circular load when ratelimit.ts pulls
    // this file in the future.
    const {
        getRollingTokenUsage,
        getActiveCredits,
        consumeCredits,
        resolveTierLimits,
    } = await import("./rateLimit");

    // We don't have tier_level_id on this code path (recordLlmUsage is
    // called from many handlers, some of which don't carry res.locals).
    // Fetch it from user_profiles … or fall back to free defaults.
    const tierLevelId = await fetchTierLevelIdForUser(userId);
    if (tierLevelId == null) return;
    const [tierLimits, snapshot, credits] = await Promise.all([
        resolveTierLimits(tierLevelId, null),
        getRollingTokenUsage(userId),
        getActiveCredits(userId),
    ]);
    if (credits.bonusRemaining <= 0) return;
    const rollingTotal = snapshot.tokens;
    const dailyCap = tierLimits.daily_tokens;
    if (rollingTotal <= dailyCap) return;

    // The user is over the daily cap — but we don't want to charge the
    // ENTIRE rolling overage to credits each call (that double-counts).
    // The new overage is at most the tokens recorded by THIS turn; the
    // earlier turns either drained or pre-dated cap-cross. We charge
    // min(thisTurnTokens, rollingTotal - dailyCap).
    const turnTokens =
        (justRecorded.inputTokens ?? 0) +
        (justRecorded.outputTokens ?? 0) +
        (justRecorded.cacheCreationInputTokens ?? 0) +
        (justRecorded.cacheReadInputTokens ?? 0);
    const overage = Math.min(turnTokens, rollingTotal - dailyCap);
    if (overage <= 0) return;
    const drawn = await consumeCredits(userId, overage);
    if (drawn > 0) {
        console.log(
            `[llm/usage] credit drain user=${userId} overage=${overage} drawn=${drawn}`,
        );
    }
}

/**
 * Look up the user's tier_level_id via the JWT trail captured on their
 * profile. Returns null when we can't determine it (e.g. user logged
 * in before the column existed) — caller treats that as "skip credit
 * accounting", because without a tier we can't know the daily cap.
 *
 * NOTE: tier_level_id is currently propagated through res.locals on
 * each request rather than persisted, so this helper falls back to a
 * cheap heuristic: if the user has any active credit pack, they are at
 * least Plus, so use tier_level_id 2.
 */
async function fetchTierLevelIdForUser(userId: string): Promise<number | null> {
    try {
        const res = await query<{ tier_level_id: number | null }>(
            `SELECT 2::int AS tier_level_id
             FROM public.user_token_credits
             WHERE user_id = $1
               AND voided_at IS NULL
               AND tokens_consumed < tokens_granted
               AND (expires_at IS NULL OR expires_at > NOW())
             LIMIT 1`,
            [userId],
        );
        if (res.rows.length > 0) return 2;
        return null;
    } catch {
        return null;
    }
}
