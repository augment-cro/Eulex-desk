/**
 * Internal REST entrypoint for the multi-provider web search.
 *
 *   POST /search                    (auth required)
 *     Body:
 *       {
 *         query:           string                 (required)
 *         provider?:       "tavily" | "exa" | "parallel" | "you"
 *         num_results?:    number  (1-10)
 *         project_id?:     string  (resolves search_config.json defaults)
 *         source_keys?:    string[] (resolved against external_sources.json)
 *         include_domains?: string[]
 *         exclude_domains?: string[]
 *         recency_days?:   number
 *       }
 *     Returns: SearchResponse JSON (provider, query, results, optional answer/context).
 *
 * Used by Eulex Desk clients (Word add-in "Find sources" panel, debug UI)
 * that want to search without going through the LLM toolcall flow.
 * The LLM toolcall path lives in chatTools.ts and shares the same
 * underlying webSearch() function — so config and behavior stay in
 * lock-step automatically.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { webSearch, type SearchProvider } from "../lib/search";
import { resolveProjectSearchConfig } from "../lib/search/search_config";
import { computeSearchCallCostUsd } from "../lib/searchPricing";
import { recordLlmUsage } from "../lib/llmUsage";

export const searchRouter = Router();

function isProvider(s: unknown): s is SearchProvider {
    return s === "tavily" || s === "exa" || s === "parallel" || s === "you";
}

function asStringArray(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string");
    return out.length ? out : undefined;
}

searchRouter.post("/", requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
        return res.status(400).json({ error: "query is required" });
    }
    if (query.length > 2000) {
        return res
            .status(400)
            .json({ error: "query must be ≤ 2000 characters" });
    }

    const projectId =
        typeof body.project_id === "string" ? body.project_id : null;
    const cfg = resolveProjectSearchConfig(projectId);

    const requestedProvider = isProvider(body.provider)
        ? body.provider
        : undefined;
    // Honor per-call override; fall back to project preferred; final
    // fallback to webSearch's auto-pick.
    const provider =
        requestedProvider ?? cfg.preferred_provider ?? undefined;

    const numResultsRaw =
        typeof body.num_results === "number"
            ? body.num_results
            : cfg.num_results;
    const num_results = Math.min(Math.max(numResultsRaw ?? 5, 1), 10);

    const recencyRaw =
        typeof body.recency_days === "number"
            ? body.recency_days
            : cfg.recency_days;
    const recency_days = recencyRaw ?? undefined;

    const include_domains = asStringArray(body.include_domains);
    const exclude_domains = asStringArray(body.exclude_domains);
    const source_keys = asStringArray(body.source_keys) ?? cfg.source_keys;

    const turnStartedAt = Date.now();
    const resp = await webSearch({
        query,
        provider,
        num_results,
        include_domains,
        exclude_domains,
        recency_days,
        source_keys: source_keys.length ? source_keys : undefined,
        allowed_providers: cfg.providers,
    });

    // Bill the REST search exactly like a chat-tool search: one
    // llm_usage row with zero token counts and cost_usd = provider
    // call cost. Adminmax SUM(cost_usd) picks it up automatically; we
    // tag `provider` so spike forensics can filter web-search billings
    // separately from real LLM calls when needed.
    const userId =
        typeof res.locals.userId === "string" ? res.locals.userId : null;
    if (userId && resp.provider) {
        const cost = computeSearchCallCostUsd(
            resp.provider as SearchProvider,
            Array.isArray(resp.results) ? resp.results.length : 0,
        );
        if (cost > 0) {
            // Fire-and-forget; recordLlmUsage swallows its own failures.
            void recordLlmUsage({
                userId,
                provider: "web_search",
                model: resp.provider,
                projectId,
                usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationInputTokens: 0,
                    cacheReadInputTokens: 0,
                    iterations: 1,
                },
                durationMs: Date.now() - turnStartedAt,
                status: resp.error ? "error" : "ok",
                errorMessage: resp.error ?? null,
                extraCostUsd: cost,
            });
        }
    }

    // Strip the upstream provider id from the public response so the
    // Word add-in / debug UI never sees "tavily" / "exa" / "parallel".
    // Internal billing above keyed off the real provider already.
    res.json({ ...resp, provider: "eulex" });
});
