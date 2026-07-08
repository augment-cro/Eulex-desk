/**
 * You.com provider — POST https://chat-api.you.com/search
 *
 * Auth via `X-API-Key` header. The unified `search` endpoint returns
 * web + news hits in one call. You.com does NOT honor structured
 * include_domains, so when the caller passes an allowlist we encode it
 * as `(query) (site:foo.com OR site:bar.com)` (max 5 domains so we
 * don't blow query length).
 */

import type { SearchResponse, SearchResult, WebSearchInput } from "../types";

const ENDPOINT = "https://chat-api.you.com/search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET_CHARS = 15_000;

interface YouHitRaw {
    url?: string;
    title?: string;
    description?: string;
    snippets?: string[];
    page_age?: string | null;
    thumbnail_url?: string | null;
}

interface YouApiResponse {
    hits?: YouHitRaw[];
    // Some deployments wrap hits as { results: { web, news } } —
    // we accept both shapes.
    results?: { web?: YouHitRaw[]; news?: YouHitRaw[] };
}

function recencyDaysToFreshness(days?: number): string | undefined {
    if (!days) return undefined;
    if (days <= 7) return "week";
    if (days <= 31) return "month";
    return "year";
}

export async function youSearch(
    input: WebSearchInput,
    apiKey: string,
): Promise<SearchResponse> {
    let query = input.query;
    if (input.include_domains?.length) {
        const sites = input.include_domains
            .slice(0, 5)
            .map((d) => `site:${d}`)
            .join(" OR ");
        query = `(${query}) (${sites})`;
    }

    const params = new URLSearchParams({
        query,
        num_web_results: String(
            Math.min(Math.max(input.num_results ?? 5, 1), 10),
        ),
    });
    const freshness = recencyDaysToFreshness(input.recency_days);
    if (freshness) params.set("freshness", freshness);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw: YouApiResponse;
    try {
        const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
            method: "GET",
            headers: { "X-API-Key": apiKey },
            signal: ctrl.signal,
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return {
                provider: "you",
                query: input.query,
                results: [],
                error: `You.com HTTP ${res.status}: ${txt.slice(0, 200)}`,
            };
        }
        raw = (await res.json()) as YouApiResponse;
    } catch (err) {
        return {
            provider: "you",
            query: input.query,
            results: [],
            error: `You.com request failed: ${(err as Error).message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const hits: YouHitRaw[] = raw.hits?.length
        ? raw.hits
        : [...(raw.results?.web ?? []), ...(raw.results?.news ?? [])];

    const exclude = new Set(input.exclude_domains ?? []);

    const results: SearchResult[] = [];
    for (const h of hits) {
        const url = h.url ?? "";
        if (!url) continue;
        // Manual exclude filter — You.com has no native excludeDomains.
        if (exclude.size) {
            const host = (() => {
                try {
                    return new URL(url).hostname;
                } catch {
                    return "";
                }
            })();
            if (host && [...exclude].some((d) => host.endsWith(d))) continue;
        }
        const snippets = h.snippets ?? [];
        const text = (snippets.length ? snippets.join("\n\n") : (h.description ?? ""))
            .slice(0, MAX_SNIPPET_CHARS);
        results.push({
            title: h.title ?? "",
            url,
            content: (h.description ?? text).slice(0, 500),
            raw_content: text,
            published_date: h.page_age ?? null,
            source: "you",
        });
    }

    return { provider: "you", query: input.query, results };
}
