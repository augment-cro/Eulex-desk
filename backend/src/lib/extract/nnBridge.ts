/**
 * Narodne novine → corpus bridge for `read_url`.
 *
 * When the user pastes a Narodne novine link (or a web search surfaces one)
 * the page text alone is a dead end for citations: it goes to the model as
 * prose, but nothing enters the turn's `legal_sources` registry, so the
 * document never becomes a clickable source and the provisions it names
 * ("na temelju članka 8. stavka 1. Zakona o iznimnim mjerama kontrole
 * cijena") link to whatever OTHER act happens to carry that number.
 *
 * This module recognises the NN URL, looks the publication up in the HR
 * legal corpus by its exact NN reference (`find_publication`), resolves it
 * to the corresponding regulation (`resolve`, exact-title match only) and
 * returns a typed `LegalSource` for the registry plus a note for the model
 * telling it to fetch the cited provisions from the legal tools before
 * citing them. Fail-soft everywhere: any miss returns nothing and the web
 * text is used exactly as before.
 *
 * Kept free of chatTools imports (chatTools imports this package) — the
 * caller passes the loaded MCP servers; scope filtering reuses the seams
 * module, which has no chatTools dependency either.
 */

import type { LoadedMcpServer } from "../mcp/types";
import {
    isLegalMcpServer,
    redactToolResult,
} from "../seams/scopeEnforcement";

/** Minimal shape of chatTools' `LegalSource` (kept structurally identical;
 *  chatTools re-exports the full type). */
export interface BridgedLegalSource {
    id: string;
    scope: "@hr";
    title: string;
    documentTitle: string;
    citation: string | null;
    snippet: string | null;
    externalUrl: string | null;
    articleLabel: string | null;
    fetchPath: string | null;
    celex: null;
    inForce: boolean | null;
    kind: "regulation";
}

export interface NnRef {
    year: string;
    issue: string;
    doc: string;
    /** `YYYY/NN/DOC` — the `find_publication` `nn_ref` argument. */
    nnRef: string;
}

const NN_HOST_RE = /(^|\.)narodne-novine\.nn\.hr$/i;

/**
 * NN reference embedded in a narodne-novine.nn.hr URL, in the shapes seen:
 *   /clanci/sluzbeni/2026_09_101_1212.html        (article page)
 *   /clanci/sluzbeni/full/2026_09_101_1212.html   (full-text page)
 *   /eli/sluzbeni/2026/101/1212[/…]               (ELI, optional suffix)
 * Returns null for any other URL or host.
 */
export function nnRefFromUrl(url: string): NnRef | null {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    if (!NN_HOST_RE.test(u.hostname)) return null;
    const path = u.pathname;
    let m = path.match(
        /^\/clanci\/sluzbeni\/(?:full\/)?(\d{4})_(\d{1,2})_(\d{1,4})_(\d{1,5})\.html?$/i,
    );
    if (m) {
        const [, year, , issue, doc] = m;
        return { year, issue, doc, nnRef: `${year}/${issue}/${doc}` };
    }
    m = path.match(/^\/eli\/sluzbeni\/(\d{4})\/(\d{1,4})\/(\d{1,5})(?:\/|$)/i);
    if (m) {
        const [, year, issue, doc] = m;
        return { year, issue, doc, nnRef: `${year}/${issue}/${doc}` };
    }
    return null;
}

/** The HR legal server that exposes both bridge tools, built-in first. */
export function findNnBridgeServer(
    servers: LoadedMcpServer[],
): LoadedMcpServer | null {
    const hasTools = (s: LoadedMcpServer) => {
        const names = new Set(s.toolNameMap.values());
        return names.has("find_publication") && names.has("resolve");
    };
    const legal = servers.filter((s) => isLegalMcpServer(s.row) && hasTools(s));
    return (
        legal.find((s) => (s.row.slug || "").toLowerCase() === "sys-eulex") ??
        legal.find((s) => /eulex/i.test(s.row.slug || "")) ??
        legal[0] ??
        null
    );
}

function obj(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
}
function str(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}
function parseRich(r: { text: string; structured?: unknown }): Record<
    string,
    unknown
> | null {
    const s = obj(r.structured);
    if (s) return s;
    try {
        return obj(JSON.parse(r.text));
    } catch {
        return null;
    }
}

/** Title comparison key: case/whitespace/punctuation-insensitive. */
export function normalizeTitle(t: string): string {
    return t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface NnBridgeResult {
    sources: BridgedLegalSource[];
    /** Appended to the `read_url` tool result for the model; null when the
     *  URL is not an NN document or nothing resolved. */
    note: string | null;
}

const EMPTY: NnBridgeResult = { sources: [], note: null };

/**
 * Resolve an NN URL to a corpus source. Never throws.
 *
 * `whitelist` is the active Custom Contexts scope allowlist (empty → no
 * filtering); an out-of-scope document yields no source and no note, the
 * same as an out-of-scope MCP result.
 */
export async function bridgeNarodneNovineUrl(
    url: string,
    opts: { servers: LoadedMcpServer[]; whitelist?: Set<string> },
): Promise<NnBridgeResult> {
    const ref = nnRefFromUrl(url);
    if (!ref) return EMPTY;
    const server = findNnBridgeServer(opts.servers ?? []);
    if (!server) return EMPTY;
    try {
        // 1. Exact publication lookup by NN reference.
        const pub = parseRich(
            await server.client.callToolRich("find_publication", {
                scope: "@hr",
                nn_ref: ref.nnRef,
            }),
        );
        const items = Array.isArray(pub?.items) ? pub!.items : [];
        const item = obj(items[0]);
        const title = item ? str(item.title) : null;
        if (!item || !title) {
            console.log(`[nn-bridge] ${ref.nnRef}: no publication in corpus`);
            return EMPTY;
        }
        const nnCitation = str(item.nn_reference);
        const eli =
            str(item.eli_url) ??
            str(item.url) ??
            `https://narodne-novine.nn.hr/eli/sluzbeni/${ref.year}/${ref.issue}/${ref.doc}`;

        // 2. Publication → regulation (the shape the source panel renders).
        //    Exact normalized-title match only — `resolve` is fuzzy and NN
        //    titles ("Odluka o izmjenama …") repeat across years.
        let source: BridgedLegalSource | null = null;
        const res = parseRich(
            await server.client.callToolRich("resolve", {
                query: title,
                scope: "@hr",
                top_k: 5,
            }),
        );
        const matches = Array.isArray(res?.matches) ? res!.matches : [];
        const want = normalizeTitle(title);
        for (const raw of matches) {
            const m = obj(raw);
            const uri = m ? str(m.uri) : null;
            const mt = m ? str(m.title) : null;
            if (!m || !uri || !mt) continue;
            if (!uri.startsWith("@hr/regulation/")) continue;
            if (normalizeTitle(mt) !== want) continue;
            const uuid = uri.match(UUID_RE)?.[0];
            if (!uuid) continue;
            source = {
                id: uri,
                scope: "@hr",
                title,
                documentTitle: title,
                citation: nnCitation,
                snippet: null,
                externalUrl: eli,
                articleLabel: null,
                fetchPath: `/api/v1/regulations/${uuid}`,
                celex: null,
                inForce: typeof m.in_force === "boolean" ? m.in_force : null,
                kind: "regulation",
            };
            break;
        }
        if (!source) {
            // Publication only: listed among the sources with its official
            // link, but not openable in the panel (no regulation text).
            const pubId = str(item.id);
            if (!pubId) return EMPTY;
            source = {
                id: `@hr/publication/${pubId}`,
                scope: "@hr",
                title,
                documentTitle: title,
                citation: nnCitation,
                snippet: null,
                externalUrl: eli,
                articleLabel: null,
                fetchPath: null,
                celex: null,
                inForce: null,
                kind: "regulation",
            };
        }

        // 3. Custom Contexts scope — same gate as every MCP result.
        const kept = redactToolResult({
            text: "",
            structured: null,
            whitelist: opts.whitelist ?? new Set<string>(),
            harvest: () => [source as BridgedLegalSource],
        }).keptSources;
        if (kept.length === 0) {
            console.log(`[nn-bridge] ${ref.nnRef}: ${source.id} out of scope`);
            return EMPTY;
        }
        console.log(
            `[nn-bridge] ${ref.nnRef} → ${source.id}${source.fetchPath ? "" : " (publication only)"}`,
        );
        const note =
            `Corpus match: this Narodne novine document is held in the legal source tools as "${title}"` +
            (nnCitation ? ` (${nnCitation})` : "") +
            `. Cite it by that title. The provisions it invokes or cites (for example "članak 8. stavka 1. Zakona o …") are NOT retrieved yet — ` +
            `fetch each such article from the legal source tools before citing it in the answer; a provision quoted from this page alone is not a retrieved source.`;
        return { sources: kept, note };
    } catch (err) {
        console.warn(
            `[nn-bridge] ${ref.nnRef}: lookup failed — ${err instanceof Error ? err.message : String(err)}`,
        );
        return EMPTY;
    }
}
