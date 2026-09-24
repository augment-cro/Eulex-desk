/**
 * URL content extraction — the `read_url` tool's execution core.
 *
 * ONE model-driven tool that reads a single public URL — a web page OR a
 * PDF — and returns clean text the model can ground on and cite. It powers
 * two product flows:
 *
 *   1. A web search surfaces a relevant link (often a PDF). The model
 *      calls `read_url` on that URL to read the actual document before
 *      citing it — search snippets alone are not enough for a PDF.
 *   2. The user pastes a link into the composer. The model reads it and
 *      answers from its contents.
 *
 * Backed by Parallel Extract (lib/extract/parallel.ts), which converts
 * HTML, JS-heavy pages, and PDFs to markdown in one call. We reuse the
 * existing PARALLEL_API_KEY, so no new vendor/secret.
 *
 * Two-step sizing (Parallel is character-based, not page-based):
 *   - default (preview): focused excerpts reranked by the model's
 *     `objective` — a cheap first look ("is this worth reading fully?").
 *   - `full: true`: the entire document via full_content. The model is
 *     told to start with a preview and only pull the full text once it
 *     judges the source relevant.
 */

import { isExcludedDomainUrl } from "../search/external_sources";
import { extractWithParallel } from "./parallel";

export interface ReadUrlResult {
    url: string;
    title: string | null;
    text: string;
    /** true → returned the whole document; false → a focused preview. */
    full: boolean;
    truncated: boolean;
    /** Best-effort: the URL looked like a PDF (for UI labelling only). */
    isPdf: boolean;
    /** Set when extraction failed; `text` is then empty. */
    error: string | null;
}

/**
 * Flat Parallel Extract price — $0.001 / request (parallel.ai/pricing).
 * Billed per successful call, folded into the turn's external-tool USD
 * tally alongside web search (see chatTools.runToolCalls).
 */
export const READ_URL_COST_USD = 0.001;

/** Preview: focused excerpts. ~10k chars total ≈ "a few pages" of the
 *  most relevant passages — enough to judge relevance and answer most
 *  pointed questions without pulling the whole document. */
const PREVIEW_MAX_CHARS_PER_RESULT = 4_000;
const PREVIEW_MAX_CHARS_TOTAL = 10_000;
/** Full: the WHOLE document. ~300k chars ≈ ~100 pages (~80-90k tokens) —
 *  enough to deliver essentially every legal PDF / pravilnik we see in
 *  one piece. `full: true` is a deliberate "read it all" act, so we let
 *  it be large; only genuinely huge docs get truncated with a marker.
 *  Prompt caching keeps the re-send cost of a read document cheap on
 *  later turns. */
const FULL_MAX_CHARS = 300_000;

export function isExtractConfigured(): boolean {
    return !!process.env.PARALLEL_API_KEY?.trim();
}

function isHttpUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === "http:" || u.protocol === "https:";
    } catch {
        return false;
    }
}

/** Heuristic: does the URL point at a PDF? Used only for UI labelling —
 *  Parallel extracts PDFs regardless, so a wrong guess is harmless. */
export function looksLikePdfUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return /\.pdf($|[?#])/i.test(u.pathname + u.search);
    } catch {
        return /\.pdf(\b|$)/i.test(url);
    }
}

/**
 * CELEX id embedded in a EUR-Lex URL, in any of the shapes we see:
 * `?uri=CELEX:32026R1392`, `?uri=celex:32026R1392`, or a bare
 * `/CELEX:32026R1392` path segment. Used to point the model at the same
 * document in our own corpus.
 */
export function celexFromUrl(url: string): string | null {
    const m = url.match(/CELEX[:%]3?A?:?\s*(\d{5}[A-Z]{1,2}\d{3,4})/i);
    return m ? m[1].toUpperCase() : null;
}

/**
 * EUR-Lex and CURIA documents are NOT read off the web: we hold that
 * corpus first-party, so the model must retrieve them through the legal
 * source tools (searchable, citable, article-level) instead of paying an
 * extractor to scrape a bot-challenged page. The domain list is the same
 * `excluded_domains` block search already honours — one source of truth
 * in `search/external_sources.json`.
 *
 * Returns the instruction to hand the model instead of page text, or
 * null when the URL is fair game for extraction.
 */
export function corpusOwnedUrlNotice(url: string): string | null {
    if (!isExcludedDomainUrl(url)) return null;
    const celex = celexFromUrl(url);
    return (
        `Not fetched: ${url} belongs to a corpus we hold first-party, so it is never read off the web. ` +
        `Retrieve this document through the legal source tools instead` +
        (celex ? ` (CELEX ${celex})` : "") +
        `, and cite it from there. Do not retry this URL with read_url.`
    );
}

/**
 * Is this failure worth one more shot? Network blips, timeouts, 429s and
 * provider-side 5xx are transient; a 4xx (bad key, bad request) is not,
 * and retrying it only burns 20s of the user's turn.
 */
function isTransientExtractError(errorType?: string): boolean {
    if (!errorType) return false;
    // Parallel's fetch-level types (`network_error`, `fetch_error`) plus
    // our own `request_failed` (our call to the API threw or timed out).
    if (
        errorType === "network_error" ||
        errorType === "fetch_error" ||
        errorType === "timeout" ||
        errorType === "request_failed"
    ) {
        return true;
    }
    const http = errorType.match(/^http_(\d{3})$/);
    return !!http && (http[1] === "429" || http[1].startsWith("5"));
}

/**
 * OpenAI-shape tool schema for `read_url` (single source of truth, mirrors
 * the search tools in lib/search/tool_routes.ts). Registered into the
 * active toolset by runLLMStream when an extract provider is configured.
 */
export const READ_URL_TOOL = {
    type: "function" as const,
    function: {
        name: "read_url",
        description:
            "Fetch and read the full text of ONE public web page or PDF by its URL. Use it to (a) read a PDF or page a web search surfaced — search snippets are not enough, especially for PDFs — before you cite it, and (b) read a link the user pasted into the chat. Returns the page/PDF text as markdown; always cite the URL. Does NOT work for pages behind a login, paywall, or on a private/internal address. Do NOT use it for EU legislation or CJEU case law (eur-lex.europa.eu, curia.europa.eu) — those documents are held in the legal source tools and must be retrieved there. Start with a focused preview (omit `full`); only set `full: true` once the preview shows the source is relevant and you need the entire document.",
        parameters: {
            type: "object",
            properties: {
                url: {
                    type: "string",
                    description:
                        "The full public http(s) URL to read (web page or PDF).",
                },
                objective: {
                    type: "string",
                    description:
                        "What you are looking for on the page — used to focus the extracted excerpts (e.g. 'penalties for late VAT filing'). Strongly recommended for the preview.",
                },
                full: {
                    type: "boolean",
                    description:
                        "false (default) returns a focused preview (the most relevant passages for your objective). true returns the ENTIRE document text. Use the preview first; set true only when you need the whole document.",
                },
            },
            required: ["url"],
        },
    },
};

export async function readUrl(
    url: string,
    opts: { objective?: string; full?: boolean } = {},
): Promise<ReadUrlResult> {
    const full = opts.full === true;
    const isPdf = looksLikePdfUrl(url);
    const base: ReadUrlResult = {
        url,
        title: null,
        text: "",
        full,
        truncated: false,
        isPdf,
        error: null,
    };

    if (!isHttpUrl(url)) {
        return { ...base, error: "Only a public http(s) URL can be read." };
    }
    // Belt and braces: `runToolCalls` already intercepts these before the
    // tool runs, so a call reaching here means a non-chat caller. Never
    // spend an extractor request on a document we own.
    const corpusNotice = corpusOwnedUrlNotice(url);
    if (corpusNotice) {
        return { ...base, error: corpusNotice };
    }
    const apiKey = process.env.PARALLEL_API_KEY?.trim();
    if (!apiKey) {
        return {
            ...base,
            error: "URL extraction is not configured (no provider key).",
        };
    }

    const cap = full ? FULL_MAX_CHARS : PREVIEW_MAX_CHARS_PER_RESULT;
    const hardCap = full ? FULL_MAX_CHARS : PREVIEW_MAX_CHARS_TOTAL;

    // Two attempts at most: extraction failures out here are dominated by
    // transient misses (bot challenges, blips) that a second try clears.
    // The provider bills per *successful* extraction, so a failed first
    // attempt costs nothing and the flat per-call price still holds.
    const MAX_ATTEMPTS = 2;

    let lastError = "No readable content was extracted from this URL.";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const resp = await extractWithParallel([url], apiKey, {
            mode: full ? "full" : "excerpts",
            objective: opts.objective,
            maxCharsPerResult: cap,
            maxCharsTotal: full ? undefined : PREVIEW_MAX_CHARS_TOTAL,
        });

        const r = resp.results[0];
        if (!resp.error && r && r.text.trim()) {
            const truncated = r.text.length > hardCap;
            return {
                url,
                title: r.title,
                text: truncated ? r.text.slice(0, hardCap) : r.text,
                full,
                truncated,
                isPdf,
                error: null,
            };
        }

        lastError = resp.error ?? lastError;
        if (i === MAX_ATTEMPTS - 1) break;
        // Only a transient failure is worth a second identical fetch.
        // A 4xx, or a page that came back empty, would fail the same way
        // and just burn ~20s of the user's turn.
        if (!isTransientExtractError(resp.errorType)) break;
        console.warn(
            `[extract] ${url} failed (${resp.errorType}), retrying once`,
        );
    }

    return { ...base, error: lastError };
}

/**
 * Compact, citation-friendly tool-result text for the LLM. The model
 * gets the extracted body plus a header with the URL it must cite and a
 * hint to pull the full document when it only saw a preview.
 */
export function formatExtractForLLM(r: ReadUrlResult): string {
    if (r.error) {
        return `Could not read ${r.url}: ${r.error}`;
    }
    const label = `${r.isPdf ? "PDF" : "Page"}${r.full ? "" : " (preview)"}`;
    const head = `${label} content of ${r.url}${
        r.title ? ` — ${r.title}` : ""
    }:`;
    const tail = r.truncated
        ? r.full
            ? "\n\n…(document truncated at the size limit)"
            : "\n\n…(preview truncated — call read_url again with full=true for the whole document)"
        : "";
    return `${head}\n\n${r.text}${tail}`;
}
