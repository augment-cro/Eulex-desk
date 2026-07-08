/**
 * Tavily provider — POST https://api.tavily.com/search
 *
 * Auth via `Authorization: Bearer <key>` header. We send all knobs
 * documented in the public REST API; unsupported ones are simply not
 * included in the body so older keys keep working.
 */

import type { SearchResponse, SearchResult, WebSearchInput } from "../types";

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 30_000;
const MAX_CONTENT_PER_RESULT = 15_000;

interface TavilyResultRaw {
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string | null;
    score?: number | null;
    published_date?: string | null;
}

interface TavilyApiResponse {
    answer?: string | null;
    results?: TavilyResultRaw[];
    error?: string;
}

function recencyDaysToTimeRange(days?: number): string | undefined {
    if (!days) return undefined;
    if (days <= 1) return "day";
    if (days <= 7) return "week";
    if (days <= 31) return "month";
    return "year";
}

export async function tavilySearch(
    input: WebSearchInput,
    apiKey: string,
): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
        query: input.query,
        max_results: Math.min(Math.max(input.num_results ?? 5, 1), 10),
        // `advanced` returns more chunked content per result; the cost
        // delta is small and the LLM benefits from richer grounding.
        search_depth: "advanced",
        include_answer: true,
        // markdown is friendlier than html for LLM context.
        include_raw_content: "markdown",
    };

    if (input.include_domains?.length) {
        body.include_domains = input.include_domains;
    }
    if (input.exclude_domains?.length) {
        body.exclude_domains = input.exclude_domains;
    }
    const timeRange = recencyDaysToTimeRange(input.recency_days);
    if (timeRange) body.time_range = timeRange;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw: TavilyApiResponse;
    try {
        const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return {
                provider: "tavily",
                query: input.query,
                results: [],
                error: `Tavily HTTP ${res.status}: ${txt.slice(0, 200)}`,
            };
        }
        raw = (await res.json()) as TavilyApiResponse;
    } catch (err) {
        return {
            provider: "tavily",
            query: input.query,
            results: [],
            error: `Tavily request failed: ${(err as Error).message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const results: SearchResult[] = (raw.results ?? []).map((r) => {
        const text = (r.raw_content || r.content || "").slice(
            0,
            MAX_CONTENT_PER_RESULT,
        );
        return {
            title: r.title ?? "",
            url: r.url ?? "",
            content: (r.content || text).slice(0, 500),
            raw_content: text,
            published_date: r.published_date ?? null,
            score: r.score ?? null,
            source: "tavily",
        };
    });

    return {
        provider: "tavily",
        query: input.query,
        answer: raw.answer ?? null,
        results,
    };
}
