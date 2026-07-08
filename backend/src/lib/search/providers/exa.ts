/**
 * Exa.ai provider — POST https://api.exa.ai/search
 *
 * Auth via `x-api-key` header. We always request `contents.text` and
 * `contents.highlights` so the LLM gets grounded body content, not
 * just titles. `livecrawl: "preferred"` falls back to cache when the
 * fresh crawl times out.
 */

import type { SearchResponse, SearchResult, WebSearchInput } from "../types";

const ENDPOINT = "https://api.exa.ai/search";
const TIMEOUT_MS = 30_000;
const MAX_CONTENT_PER_RESULT = 15_000;

interface ExaResultRaw {
    title?: string;
    url?: string;
    publishedDate?: string | null;
    author?: string | null;
    score?: number | null;
    text?: string;
    highlights?: string[];
}

interface ExaApiResponse {
    results?: ExaResultRaw[];
    context?: string;
}

function isoDateNDaysAgo(days: number): string {
    const d = new Date(Date.now() - days * 86_400_000);
    return d.toISOString().slice(0, 10);
}

export async function exaSearch(
    input: WebSearchInput,
    apiKey: string,
): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
        query: input.query,
        numResults: Math.min(Math.max(input.num_results ?? 5, 1), 10),
        type: "auto",
        contents: {
            text: { maxCharacters: MAX_CONTENT_PER_RESULT },
            highlights: { numSentences: 3, highlightsPerUrl: 3 },
            livecrawl: "preferred",
        },
    };

    if (input.include_domains?.length) {
        body.includeDomains = input.include_domains;
    }
    if (input.exclude_domains?.length) {
        body.excludeDomains = input.exclude_domains;
    }
    if (input.recency_days) {
        body.startPublishedDate = isoDateNDaysAgo(input.recency_days);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw: ExaApiResponse;
    try {
        const res = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return {
                provider: "exa",
                query: input.query,
                results: [],
                error: `Exa HTTP ${res.status}: ${txt.slice(0, 200)}`,
            };
        }
        raw = (await res.json()) as ExaApiResponse;
    } catch (err) {
        return {
            provider: "exa",
            query: input.query,
            results: [],
            error: `Exa request failed: ${(err as Error).message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const results: SearchResult[] = (raw.results ?? []).map((r) => {
        const text = (r.text ?? "").slice(0, MAX_CONTENT_PER_RESULT);
        const highlights = r.highlights ?? [];
        // Use the first highlight as the snippet when present —
        // highlights are query-relevant excerpts, far more useful than
        // a generic body intro for citation prose.
        const snippet =
            (highlights[0] ?? text).replace(/\s+/g, " ").slice(0, 500);
        return {
            title: r.title ?? "",
            url: r.url ?? "",
            content: snippet,
            raw_content: text,
            published_date: r.publishedDate ?? null,
            author: r.author ?? null,
            score: r.score ?? null,
            source: "exa",
        };
    });

    return {
        provider: "exa",
        query: input.query,
        context: raw.context ?? null,
        results,
    };
}
