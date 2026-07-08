/**
 * Role-based web-search tool surface.
 *
 * Instead of exposing a single `web_search` tool with an opaque
 * `provider` enum, we present the model three intent-named tools:
 *
 *   - search_official_sources → curated, verified official/government
 *     domains (tax authority, government, official gazette, courts…).
 *     Backed by the Tavily provider with a forced include_domains
 *     allowlist drawn from external_sources.json source-keys.
 *   - search_web              → general open-web search for facts and
 *     background. Backed by Parallel (semantic agentic search).
 *   - search_news             → current news / recent developments on a
 *     topic. Backed by You.com, defaulting to a recency window.
 *
 * The tool NAME is the provider selection — we never surface vendor
 * identity to the model or user (see the "eulex" masking in chatTools).
 * Each route carries a provider `chain`: the first configured provider
 * wins, the rest are fallbacks so a missing API key degrades gracefully.
 *
 * `webSearch()` in ./index.ts remains the single execution core; this
 * module only shapes which tool the model sees and how its arguments map
 * onto a WebSearchInput.
 */

import { getAvailableProviders } from "./index";
import type { SearchProvider, WebSearchInput } from "./types";

export type SearchKind = "official" | "web" | "news";

export interface SearchToolRoute {
    /** Tool name the model sees and calls. */
    name: string;
    /** UI/event label discriminator (also masks the upstream provider). */
    kind: SearchKind;
    /**
     * Providers to try in order. First one with an env key configured
     * (and permitted by the project config at call time) is used; the
     * rest are graceful fallbacks.
     */
    chain: SearchProvider[];
    /** Defaults merged UNDER any per-call args. */
    defaults: Partial<Pick<WebSearchInput, "num_results" | "recency_days">>;
    /**
     * For the official-sources tool: the curated source-key group that
     * resolves to an include_domains allowlist via external_sources.json
     * when neither the model nor the project config narrows it further.
     */
    sourceGroupDefault?: string;
    /** Source-group slugs the model may pass via `source_group`. */
    sourceGroupChoices?: string[];
    /** Human-facing tool description (also feeds the system prompt). */
    description: string;
}

/**
 * Curated HR official-source groups. The slugs must exist as entries in
 * external_sources.json (each with a `domains` array). "hr_official" is
 * the umbrella set; the rest are thematic narrowings the model can pick.
 */
export const HR_OFFICIAL_GROUPS = [
    "hr_official",
    "hr_tax",
    "hr_labor",
    "hr_company",
    "hr_courts",
] as const;

export const SEARCH_TOOL_ROUTES: SearchToolRoute[] = [
    {
        name: "search_official_sources",
        kind: "official",
        chain: ["tavily", "exa"],
        defaults: { num_results: 6 },
        sourceGroupDefault: "hr_official",
        sourceGroupChoices: [...HR_OFFICIAL_GROUPS],
        description:
            "Search ONLY verified, official/government sources (the tax authority, the government, ministries, the official gazette, courts, and public registers). Use this for authoritative facts: tax rates, thresholds, deadlines, official forms, administrative procedures, and government guidance. Returns ranked results with URL, title, and a body excerpt. Always cite the URL.",
    },
    {
        name: "search_web",
        kind: "web",
        chain: ["parallel", "exa", "tavily"],
        defaults: { num_results: 5 },
        description:
            "General open-web search for facts, background, and explanations not necessarily found on an official site. Use when the question is not time-sensitive news and a more specific tool does not fit. Returns ranked results with URL, title, and a body excerpt. Always cite the URL.",
    },
    {
        name: "search_news",
        kind: "news",
        chain: ["you", "tavily"],
        defaults: { num_results: 6, recency_days: 30 },
        description:
            "Search current news and recent developments on a topic. Use for 'latest', 'recent', breaking events, or anything where freshness matters. Defaults to the last 30 days; pass `recency_days` to widen or narrow. Returns ranked results with URL, title, date, and a snippet. Always cite the URL.",
    },
];

export const SEARCH_TOOL_NAMES = SEARCH_TOOL_ROUTES.map((r) => r.name);

export function getSearchRoute(name: string): SearchToolRoute | undefined {
    return SEARCH_TOOL_ROUTES.find((r) => r.name === name);
}

/** True when `name` is one of our role-based search tools. */
export function isSearchToolName(name: string): boolean {
    return SEARCH_TOOL_ROUTES.some((r) => r.name === name);
}

/**
 * First provider in the route's chain that is configured (and permitted
 * by the project allowlist, when supplied). Falls back to any configured
 * + allowed provider so the tool keeps working if the chain is unusable.
 */
export function resolveRouteProvider(
    route: SearchToolRoute,
    allowed?: SearchProvider[],
): SearchProvider | null {
    const avail = getAvailableProviders();
    const permitted = (p: SearchProvider) =>
        (!allowed?.length || allowed.includes(p)) && avail[p];
    for (const p of route.chain) {
        if (permitted(p)) return p;
    }
    const order: SearchProvider[] = ["tavily", "exa", "parallel", "you"];
    for (const p of order) {
        if (permitted(p)) return p;
    }
    return null;
}

/** A route is "available" when any provider in its chain has an env key. */
function routeHasProvider(route: SearchToolRoute): boolean {
    const avail = getAvailableProviders();
    return route.chain.some((p) => avail[p]);
}

/** OpenAI-shape tool schema generated from a route (single source of truth). */
function toToolSchema(route: SearchToolRoute) {
    const properties: Record<string, unknown> = {
        query: {
            type: "string",
            description:
                "Natural-language search query. Be specific — include names, numbers, acronyms, and jurisdiction when implied.",
        },
        num_results: {
            type: "integer",
            description: "How many results to return (1-10).",
            minimum: 1,
            maximum: 10,
        },
    };
    if (route.kind === "news" || route.kind === "web") {
        properties.recency_days = {
            type: "integer",
            description:
                "Restrict results to the last N days. For breaking news use 1/7/30; omit for evergreen topics.",
            minimum: 1,
            maximum: 3650,
        };
    }
    if (route.kind === "official" && route.sourceGroupChoices?.length) {
        properties.source_group = {
            type: "string",
            enum: route.sourceGroupChoices,
            description:
                "Optional narrowing of the official-source allowlist. 'hr_official' = all official sources (default); 'hr_tax' = tax / finance / customs; 'hr_labor' = labour / pension / health; 'hr_company' = company registry / FINA / statistics; 'hr_courts' = courts / justice.",
        };
    }
    return {
        type: "function" as const,
        function: {
            name: route.name,
            description: route.description,
            parameters: {
                type: "object",
                properties,
                required: ["query"],
            },
        },
    };
}

/** Tool schemas for every route whose chain has a configured provider. */
export function getActiveSearchTools() {
    return SEARCH_TOOL_ROUTES.filter(routeHasProvider).map(toToolSchema);
}

/** True if at least one role-based search tool is currently usable. */
export function anySearchToolActive(): boolean {
    return SEARCH_TOOL_ROUTES.some(routeHasProvider);
}
