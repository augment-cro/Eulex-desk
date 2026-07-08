/**
 * Unified web-search entrypoint used by `chatTools.runToolCalls()`.
 *
 * Responsibilities:
 *  - choose the provider (LLM-supplied, defaulting to whichever
 *    provider has an API key configured),
 *  - resolve `source_keys` → domains via the curated
 *    `external_sources.json` (per-project allowlist support),
 *  - call the provider wrapper,
 *  - format a compact tool-result string for the LLM (we deliberately
 *    don't dump the full body — the model gets enough to cite
 *    accurately and ~3-5K tokens stays out of context bloat).
 */

import {
    getDefaultExcludedDomains,
    getDomainsForSources,
} from "./external_sources";
import { exaSearch } from "./providers/exa";
import { parallelSearch } from "./providers/parallel";
import { tavilySearch } from "./providers/tavily";
import { youSearch } from "./providers/you";
import type {
    SearchProvider,
    SearchResponse,
    WebSearchInput,
} from "./types";

export type { SearchProvider, SearchResponse, WebSearchInput } from "./types";

export interface ProviderAvailability {
    tavily: boolean;
    exa: boolean;
    parallel: boolean;
    you: boolean;
}

/** Snapshot of which provider env keys are configured at this moment. */
export function getAvailableProviders(): ProviderAvailability {
    return {
        tavily: !!process.env.TAVILY_API_KEY?.trim(),
        exa: !!process.env.EXA_API_KEY?.trim(),
        parallel: !!process.env.PARALLEL_API_KEY?.trim(),
        you: !!process.env.YOU_API_KEY?.trim(),
    };
}

export function isAnyProviderConfigured(): boolean {
    const a = getAvailableProviders();
    return a.tavily || a.exa || a.parallel || a.you;
}

/**
 * Pick a provider when the caller didn't ask for a specific one. We
 * prefer Tavily for breadth, fall back to Exa for technical/long-form
 * needs, then Parallel, then You.com. The order matches per-provider
 * strengths observed in production. When `allowed` is supplied, only
 * providers in that allowlist are considered.
 */
function pickAutoProvider(
    allowed?: SearchProvider[],
): SearchProvider | null {
    const a = getAvailableProviders();
    const order: SearchProvider[] = ["tavily", "exa", "parallel", "you"];
    for (const p of order) {
        if (allowed?.length && !allowed.includes(p)) continue;
        if (a[p]) return p;
    }
    return null;
}

function getApiKey(provider: SearchProvider): string | undefined {
    switch (provider) {
        case "tavily":
            return process.env.TAVILY_API_KEY?.trim();
        case "exa":
            return process.env.EXA_API_KEY?.trim();
        case "parallel":
            return process.env.PARALLEL_API_KEY?.trim();
        case "you":
            return process.env.YOU_API_KEY?.trim();
    }
}

export async function webSearch(
    rawInput: WebSearchInput & {
        /**
         * Optional whitelist of providers permitted by the project's
         * search_config.json. Caller-requested providers outside this
         * list are downgraded to the auto-pick fallback.
         */
        allowed_providers?: SearchProvider[];
    },
): Promise<SearchResponse> {
    const allowed = rawInput.allowed_providers;
    let provider = rawInput.provider ?? pickAutoProvider(allowed);
    if (provider && allowed?.length && !allowed.includes(provider)) {
        // Caller asked for a provider the project's config doesn't
        // permit — fall back to the first allowed provider that has a
        // key configured rather than silently calling something the
        // operator excluded.
        provider = pickAutoProvider(allowed);
    }
    if (!provider) {
        return {
            provider: "tavily",
            query: rawInput.query,
            results: [],
            error: "No web search provider configured (set TAVILY_API_KEY / EXA_API_KEY / PARALLEL_API_KEY / YOU_API_KEY).",
        };
    }
    const apiKey = getApiKey(provider);
    if (!apiKey) {
        return {
            provider,
            query: rawInput.query,
            results: [],
            error: `Provider '${provider}' has no API key configured.`,
        };
    }

    // Resolve include_domains in priority order:
    //  1) explicit per-call include_domains from the tool call,
    //  2) explicit per-call source_keys → domains.
    // Project-level source_keys are pre-applied by the caller (chatTools)
    // before invoking this function, so we never need to read them here.
    // Falling through everything leaves the search open to the web.
    let includeDomains = rawInput.include_domains;
    if (!includeDomains?.length && rawInput.source_keys?.length) {
        includeDomains = getDomainsForSources(rawInput.source_keys);
    }

    // Always layer the curated excluded_domains list on top so we don't
    // surface results from sources we have first-party data for (EUR-Lex).
    const excludeDomains = Array.from(
        new Set([
            ...(rawInput.exclude_domains ?? []),
            ...getDefaultExcludedDomains(),
        ]),
    );

    const input: WebSearchInput = {
        ...rawInput,
        provider,
        include_domains: includeDomains,
        exclude_domains: excludeDomains,
    };

    switch (provider) {
        case "tavily":
            return tavilySearch(input, apiKey);
        case "exa":
            return exaSearch(input, apiKey);
        case "parallel":
            return parallelSearch(input, apiKey);
        case "you":
            return youSearch(input, apiKey);
    }
}

/**
 * Compact, citation-friendly text format for the tool result. Each
 * result becomes a numbered block with title + URL + a short body
 * excerpt. The model can cite back to URLs by index.
 */
export function formatSearchResultsForLLM(resp: SearchResponse): string {
    if (resp.error) {
        return `Web search failed (${resp.provider}): ${resp.error}`;
    }
    if (!resp.results.length) {
        return `Web search (${resp.provider}) returned no results for "${resp.query}".`;
    }
    const lines: string[] = [];
    lines.push(
        `Web search via ${resp.provider} for "${resp.query}" — ${resp.results.length} results:`,
    );
    if (resp.answer) {
        lines.push("", `Answer hint: ${resp.answer.slice(0, 600)}`);
    }
    resp.results.forEach((r, i) => {
        const head = `[${i + 1}] ${r.title || "(untitled)"} — ${r.url}`;
        const meta = [
            r.published_date ? `Published: ${r.published_date}` : null,
            r.author ? `Author: ${r.author}` : null,
        ]
            .filter(Boolean)
            .join(" · ");
        lines.push("", head);
        if (meta) lines.push(meta);
        // Cap each block to ~2K chars so 5 results stay <12K tokens.
        const body = (r.raw_content || r.content || "").slice(0, 2000);
        if (body) lines.push(body);
    });
    return lines.join("\n");
}
