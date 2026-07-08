/**
 * Shared types for the multi-provider web search module.
 *
 * Each provider (Tavily / Exa / Parallel / You.com) has its own quirks
 * and request/response shape. We normalise everything to this small
 * `SearchResult` interface so the LLM always sees identical citations
 * regardless of which backend produced them.
 */

export type SearchProvider = "tavily" | "exa" | "parallel" | "you";

export interface SearchResult {
    /** Display title of the page. */
    title: string;
    /** Canonical page URL. */
    url: string;
    /** Short summary / snippet (≤ ~500 chars). Cheap for prose use. */
    content: string;
    /** Full extracted body. May be truncated. Use for grounding. */
    raw_content: string;
    /** ISO 8601 publication date if known. */
    published_date?: string | null;
    /** Author byline if known. */
    author?: string | null;
    /** Provider-specific relevance score, normalised to 0-1 when known. */
    score?: number | null;
    /** Per-provider tag, useful for debugging and citation rendering. */
    source: string;
}

export interface SearchResponse {
    /** Provider that produced the results. */
    provider: SearchProvider;
    /** Echoed query (after any rewriting). */
    query: string;
    /** Optional one-shot answer from the provider (Tavily). */
    answer?: string | null;
    /** Concatenated context string useful as a single LLM input (Exa). */
    context?: string | null;
    /** Normalised result list. */
    results: SearchResult[];
    /** Set when the provider failed; results will be empty. */
    error?: string;
}

export interface WebSearchInput {
    query: string;
    provider?: SearchProvider;
    /** 1-10. Most providers cap themselves at 10 anyway. */
    num_results?: number;
    /** Allowlist (overrides project-level allowlist). */
    include_domains?: string[];
    /** Denylist. */
    exclude_domains?: string[];
    /** Restrict to results published in the last N days. */
    recency_days?: number;
    /**
     * Free-form source-namespace selector. Resolves to domains via
     * external_sources.json (e.g. ['gdpr', 'dora'] → list of domains).
     * Mutually exclusive with `include_domains`; if both are supplied,
     * `include_domains` wins.
     */
    source_keys?: string[];
}
