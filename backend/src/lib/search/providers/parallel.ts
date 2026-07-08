/**
 * Parallel.ai provider — POST https://api.parallel.ai/v1beta/search
 *
 * Auth via `x-api-key` header. Parallel takes a single `objective`
 * plus a list of `search_queries`; we extract a small set of likely
 * keyword queries from the objective using a tiny regex-based pass
 * (mirrors the Python service we ported from).
 *
 * Parallel limits include/exclude domain lists to ~10 entries each;
 * we trim aggressively rather than 4xx-ing.
 */

import type { SearchResponse, SearchResult, WebSearchInput } from "../types";

const ENDPOINT = "https://api.parallel.ai/v1beta/search";
const TIMEOUT_MS = 45_000;
const MAX_CONTENT_PER_RESULT = 15_000;

interface ParallelResultRaw {
    url?: string;
    title?: string;
    publish_date?: string | null;
    excerpts?: string[] | string;
}

interface ParallelApiResponse {
    results?: ParallelResultRaw[];
}

/**
 * Light-weight keyword extraction used to seed `search_queries`.
 * Captures regulation numbers like "2016/679", legal acronyms
 * (GDPR/CSRD/DORA…), and the leading 200 chars as a fallback. Mirrors
 * the heuristic in the original eulex.ai Python service.
 */
function buildSearchQueries(query: string): string[] {
    const terms: string[] = [];
    const regNumbers = query.match(/\d{4}\/\d+/g);
    if (regNumbers) terms.push(...regNumbers);
    const acronyms = query.match(/\b[A-Z]{2,6}\b/g);
    if (acronyms) terms.push(...acronyms.slice(0, 3));
    const head = query.slice(0, 200).trim();
    if (head && !terms.includes(head)) terms.unshift(head);
    return terms.slice(0, 5);
}

export async function parallelSearch(
    input: WebSearchInput,
    apiKey: string,
): Promise<SearchResponse> {
    const body: Record<string, unknown> = {
        objective: input.query.slice(0, 5000),
        search_queries: buildSearchQueries(input.query),
        max_results: Math.min(Math.max(input.num_results ?? 5, 1), 10),
        mode: "agentic",
        excerpts: { max_chars_per_result: 10_000 },
    };

    const sourcePolicy: Record<string, unknown> = {};
    if (input.include_domains?.length) {
        sourcePolicy.include_domains = input.include_domains.slice(0, 10);
    }
    // include + exclude are mutually exclusive in Parallel's source_policy,
    // so don't bother sending excludes when the model has narrowed
    // the search to an allowlist.
    if (!input.include_domains?.length && input.exclude_domains?.length) {
        sourcePolicy.exclude_domains = input.exclude_domains.slice(0, 10);
    }
    if (input.recency_days) {
        const after = new Date(
            Date.now() - input.recency_days * 86_400_000,
        )
            .toISOString()
            .slice(0, 10);
        sourcePolicy.after_date = after;
    }
    if (Object.keys(sourcePolicy).length) {
        body.source_policy = sourcePolicy;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw: ParallelApiResponse;
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
                provider: "parallel",
                query: input.query,
                results: [],
                error: `Parallel HTTP ${res.status}: ${txt.slice(0, 200)}`,
            };
        }
        raw = (await res.json()) as ParallelApiResponse;
    } catch (err) {
        return {
            provider: "parallel",
            query: input.query,
            results: [],
            error: `Parallel request failed: ${(err as Error).message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const contextParts: string[] = [];
    const results: SearchResult[] = (raw.results ?? []).map((r) => {
        const url = r.url ?? "";
        const title = r.title ?? "";
        const excerpts = Array.isArray(r.excerpts)
            ? r.excerpts.map((e) => String(e)).join("\n\n")
            : typeof r.excerpts === "string"
            ? r.excerpts
            : "";
        const text = excerpts.slice(0, MAX_CONTENT_PER_RESULT);
        if (text) contextParts.push(`## ${title}\nSource: ${url}\n\n${text}`);
        return {
            title,
            url,
            content: text.slice(0, 500),
            raw_content: text,
            published_date: r.publish_date ?? null,
            source: "parallel",
        };
    });

    return {
        provider: "parallel",
        query: input.query,
        context: contextParts.length
            ? contextParts.join("\n\n---\n\n")
            : null,
        results,
    };
}
