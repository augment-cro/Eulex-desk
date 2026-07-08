/**
 * Parallel.ai Extract provider — POST https://api.parallel.ai/v1/extract
 *
 * Turns any public URL — an HTML page, a JS-heavy page, or a PDF — into
 * clean markdown. Same vendor + `x-api-key` header as the Parallel
 * *search* provider (providers/parallel.ts), so there is no new secret:
 * we reuse PARALLEL_API_KEY. Flat $0.001 / request (see lib/extract).
 *
 * Two extraction modes — Parallel has NO page-based control, only
 * character-based, so we emulate "preview then full":
 *
 *   - "excerpts" (preview, default): focused, relevant passages reranked
 *     by `objective` / `search_queries`. Cheap and small — the model's
 *     first look at a source ("is this worth reading in full?"). Capped
 *     by `excerpt_settings.max_chars_per_result` + top-level
 *     `max_chars_total`.
 *   - "full": the WHOLE document via `full_content`, which always starts
 *     from the beginning of the page. Capped by
 *     `full_content.max_chars_per_result`.
 *
 * Docs: https://docs.parallel.ai/extract/advanced-extract-settings
 */

export type ParallelExtractMode = "excerpts" | "full";

export interface ParallelExtractResult {
    url: string;
    title: string | null;
    publishDate: string | null;
    /** Resolved text for the requested mode (full_content or joined excerpts). */
    text: string;
}

export interface ParallelExtractResponse {
    results: ParallelExtractResult[];
    /** Set when the request failed or a per-URL error was the only outcome. */
    error?: string;
}

const ENDPOINT = "https://api.parallel.ai/v1/extract";
const TIMEOUT_MS = 60_000;

interface RawResult {
    url?: string;
    title?: string | null;
    publish_date?: string | null;
    excerpts?: string[] | string | null;
    full_content?: string | null;
}

interface RawError {
    url?: string;
    error_type?: string;
    http_status_code?: number | null;
    content?: string;
}

interface RawResponse {
    results?: RawResult[];
    errors?: RawError[];
}

function joinExcerpts(excerpts: RawResult["excerpts"]): string {
    if (Array.isArray(excerpts)) return excerpts.map((e) => String(e)).join("\n\n");
    if (typeof excerpts === "string") return excerpts;
    return "";
}

/**
 * Extract one or more URLs. We only ever pass a single URL from the
 * `read_url` tool today, but the endpoint accepts up to 20 and we keep
 * the array shape so a future batch caller can reuse this verbatim.
 */
export async function extractWithParallel(
    urls: string[],
    apiKey: string,
    opts: {
        mode: ParallelExtractMode;
        objective?: string;
        /** Per-result cap: excerpt length (excerpts) or full text (full). */
        maxCharsPerResult: number;
        /** Aggregate excerpt cap (excerpts mode only; ignored for full). */
        maxCharsTotal?: number;
    },
): Promise<ParallelExtractResponse> {
    const advanced: Record<string, unknown> =
        opts.mode === "full"
            ? { full_content: { max_chars_per_result: opts.maxCharsPerResult } }
            : { excerpt_settings: { max_chars_per_result: opts.maxCharsPerResult } };

    const body: Record<string, unknown> = {
        urls: urls.slice(0, 20),
        advanced_settings: advanced,
    };
    const objective = opts.objective?.trim();
    if (objective) {
        body.objective = objective.slice(0, 5000);
        // Excerpts without an objective/search_queries are "redundant with
        // full content" per Parallel's docs; seed a query so the preview is
        // actually reranked toward what the model is after.
        if (opts.mode === "excerpts") {
            body.search_queries = [objective.slice(0, 200)];
        }
    }
    if (opts.mode === "excerpts" && opts.maxCharsTotal) {
        body.max_chars_total = opts.maxCharsTotal;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let raw: RawResponse;
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
                results: [],
                error: `Parallel extract HTTP ${res.status}: ${txt.slice(0, 200)}`,
            };
        }
        raw = (await res.json()) as RawResponse;
    } catch (err) {
        return {
            results: [],
            error: `Parallel extract request failed: ${(err as Error).message}`,
        };
    } finally {
        clearTimeout(timer);
    }

    const results: ParallelExtractResult[] = (raw.results ?? []).map((r) => {
        // Full mode → prefer full_content; preview → prefer excerpts. Each
        // falls back to the other so a sparse response still yields text.
        const full = typeof r.full_content === "string" ? r.full_content : "";
        const exc = joinExcerpts(r.excerpts);
        const text =
            opts.mode === "full" ? full || exc : exc || full;
        return {
            url: r.url ?? "",
            title: r.title ?? null,
            publishDate: r.publish_date ?? null,
            text,
        };
    });

    // No usable results but Parallel reported a per-URL error → surface it.
    if (!results.some((r) => r.text.trim()) && raw.errors?.length) {
        const e = raw.errors[0];
        return {
            results: [],
            error: `Parallel extract: ${e.error_type ?? "error"}${
                e.content ? ` — ${e.content.slice(0, 200)}` : ""
            }`,
        };
    }
    return { results };
}
