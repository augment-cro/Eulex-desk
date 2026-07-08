/**
 * Per-call USD pricing for the web-search providers we ship.
 *
 * Computed in application code because none of the providers return a
 * billing figure on the wire. Numbers are taken from the providers'
 * public pricing pages (verified May 2026) — see comments per entry
 * for the source URL. Update when prices move; unknown providers fall
 * back to $0 rather than throwing so we never tear down a chat turn
 * over telemetry.
 *
 * Pricing notes
 * -------------
 *   Tavily (search, search_depth: "advanced")
 *     2 credits / call × $0.008 / credit = $0.016 / call
 *     We always send `search_depth: "advanced"` in providers/tavily.ts.
 *     Free tier: 1,000 credits / mo. https://tavily.com/pricing
 *
 *   Exa (POST /search, type:"auto" + contents.text + highlights)
 *     Base search: $7 / 1k calls.
 *     contents.text: +$1 / 1k. contents.highlights: +$1 / 1k.
 *     Total for our request shape ≤10 results: $9 / 1k = $0.009 / call.
 *     Each extra result beyond 10 adds $1 / 1k = $0.001 / result.
 *     providers/exa.ts hard-caps numResults at 10 so the per-result
 *     extra only matters if we ever lift the cap. https://exa.ai/pricing
 *
 *   Parallel (POST /v1beta/search)
 *     Base: $5 / 1k requests (with up to 10 results).
 *     Extra results & excerpts beyond 10: $1 / 1k per result.
 *     providers/parallel.ts hard-caps max_results at 10 too — extra
 *     formula here is defensive.
 *     https://docs.parallel.ai/getting-started/pricing
 *
 *   You.com — no key configured in production, kept at $0 until we
 *     wire it up. Their unified web+news API is roughly $4 / 1k calls
 *     on the basic tier (https://api.you.com).
 */
import type { SearchProvider } from "./search/types";

/** Effective per-call USD cost for the providers' "default 10 results" tier. */
const BASE_COST_USD: Record<SearchProvider, number> = {
    tavily: 0.016,
    exa: 0.009,
    parallel: 0.005,
    you: 0.0,
};

/** Extra USD per result beyond the 10-result default tier. */
const EXTRA_RESULT_USD: Record<SearchProvider, number> = {
    tavily: 0.0,
    exa: 0.001,
    parallel: 0.001,
    you: 0.0,
};

const DEFAULT_TIER_RESULTS = 10;

/**
 * USD cost of one web_search call. `numResultsReturned` is best-effort:
 * we count what the provider actually shipped back, not what was asked
 * for (a search that returns 3 results when 10 were requested still
 * costs the base tier — that's how all three providers bill).
 */
export function computeSearchCallCostUsd(
    provider: SearchProvider,
    numResultsReturned: number,
): number {
    const base = BASE_COST_USD[provider] ?? 0;
    const extraRate = EXTRA_RESULT_USD[provider] ?? 0;
    const extra = Math.max(0, numResultsReturned - DEFAULT_TIER_RESULTS);
    const cost = base + extra * extraRate;
    // Match llm_usage.cost_usd numeric(12,6) — round to 6 decimals.
    return Math.round(cost * 1e6) / 1e6;
}

// NOTE: a batch-level `summarizeSearchUsage(events: WebSearchEvent[])`
// helper used to live here but became unused once we stopped surfacing
// the upstream provider name on the wire (the public WebSearchEvent
// now carries `provider: "eulex"` for branding consistency, so we can't
// reverse-look-up pricing from it). Billing is now tallied in-place at
// the call site where we still hold the real upstream provider —
// search `webSearchCostUsd` in chatTools.ts and columnSuggester.ts.
