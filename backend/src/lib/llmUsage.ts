/** Provider token receipts + published prices, persisted once per user query. */
import type { LlmUsage } from "./llm/types";
import { query } from "./db";
import { priceUsage } from "./llmPricing";
export { computeCostUsd } from "./llmPricing";

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

    const breakdown = priceUsage(model, usage, extraCostUsd);
    const costUsd = breakdown.costUsd;
    const safeExtra = breakdown.extraCostUsd;
    const llmCostUsd = breakdown.knownLlmCostUsd;

    // Single structured line — easy to grep "[llm/usage]" in Cloud
    // Logging and dump it through `gcloud logging read` for ad-hoc
    // cost reports while we don't yet have a UI.
    console.log(
        `[llm/usage] user=${userId} model=${model} provider=${provider} ` +
            `iters=${usage.iterations} ` +
            `in=${usage.inputTokens} out=${usage.outputTokens} ` +
            `cache_w=${usage.cacheCreationInputTokens} cache_r=${usage.cacheReadInputTokens} ` +
            `cost_usd=${costUsd ?? "unknown"} cost_complete=${breakdown.complete} ` +
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
                client, cost_breakdown
            ) VALUES (
                $1, $2, $3,
                $4, $5,
                $6, $7,
                $8,
                $9, $10,
                $11, $12,
                $13, $14, $15, $16,
                $17, $18::jsonb
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
                JSON.stringify(breakdown),
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
 * Look up the user's tier_level_id for credit-drain accounting. Returns
 * null when we can't determine it — caller treats that as "skip credit
 * accounting", because without a tier we can't know the daily cap.
 *
 * Primary source is `user_tier_state` (the same Stripe-webhook-fed
 * override `requireAuth` uses), so a Pro/Team user's real daily cap is
 * respected — the old credits-imply-Plus heuristic drained their packs
 * while the (much larger) daily quota still had headroom. The heuristic
 * stays as a fallback for users with packs but no tier row.
 */
async function fetchTierLevelIdForUser(userId: string): Promise<number | null> {
    try {
        const state = await query<{
            active_tier_level_id: number | null;
            active_tier_until: string | Date | null;
        }>(
            `SELECT active_tier_level_id, active_tier_until
             FROM public.user_tier_state
             WHERE user_id = $1`,
            [userId],
        );
        const row = state.rows[0];
        if (row?.active_tier_level_id != null) {
            const expired =
                row.active_tier_until &&
                new Date(row.active_tier_until as string) < new Date();
            if (!expired) return Number(row.active_tier_level_id);
        }
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
