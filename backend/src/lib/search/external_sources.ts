/**
 * Loads the curated `external_sources.json` once per process and exposes
 * helpers used by the web-search providers and the per-project
 * configuration to resolve source-keys / topics / legislation areas to
 * concrete domains.
 *
 * The JSON is tightly tailored to EU legal research right now (DGA,
 * DORA, GDPR, AI Act…). Per the design discussion, callers may opt out
 * of this allowlist — passing no source_keys / include_domains leaves
 * the search open to the broader web.
 */

import fs from "fs";
import path from "path";

interface SourceEntry {
    name?: string;
    description?: string;
    /** Single-domain source (most entries). */
    domain?: string;
    /** Multi-domain source (rare). */
    domains?: string[];
    use_when?: string[];
    topics?: string[];
}

interface LegislationAreaEntry {
    web_search_domains?: string[];
    celex_anchors?: string[];
    key_articles?: Record<string, string[]>;
    fetch_strategy?: string;
}

interface ExternalSourcesShape {
    description?: string;
    sources: Record<string, SourceEntry>;
    topic_mapping?: Record<string, string[]>;
    legislation_area_mapping?: Record<string, LegislationAreaEntry>;
    excluded_domains?: { domains?: string[] };
}

let cached: ExternalSourcesShape | null = null;

function load(): ExternalSourcesShape {
    if (cached) return cached;
    const filePath = path.join(__dirname, "external_sources.json");
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        cached = JSON.parse(raw) as ExternalSourcesShape;
        const count = Object.keys(cached.sources ?? {}).length;
        console.log(
            `[search] loaded ${count} external sources from ${filePath}`,
        );
    } catch (err) {
        console.warn(
            `[search] failed to load external_sources.json (${(err as Error).message}); web search will run without curated allowlist`,
        );
        cached = { sources: {} };
    }
    return cached;
}

/** Strip URL paths so we keep just the host (Tavily/Exa expect domains). */
function baseDomain(s: string): string {
    return s.split("/")[0];
}

/**
 * Resolve a list of source-keys (e.g. ["dora", "gdpr"]) to a flat list
 * of unique base domains.
 */
export function getDomainsForSources(sourceKeys: string[]): string[] {
    if (!sourceKeys?.length) return [];
    const data = load();
    const out = new Set<string>();
    for (const key of sourceKeys) {
        const src = data.sources[key];
        if (!src) continue;
        if (src.domain) out.add(baseDomain(src.domain));
        if (src.domains) for (const d of src.domains) out.add(baseDomain(d));
    }
    return Array.from(out);
}

/**
 * Resolve legislation-area IDs (e.g. ["banking", "ai_act"]) to a flat
 * list of unique base domains using `legislation_area_mapping`.
 */
export function getDomainsForLegislationAreas(areas: string[]): string[] {
    if (!areas?.length) return [];
    const data = load();
    const map = data.legislation_area_mapping ?? {};
    const out = new Set<string>();
    for (const id of areas) {
        const norm = id.toLowerCase().replace(/[\s-]/g, "_");
        for (const d of map[norm]?.web_search_domains ?? []) out.add(d);
    }
    return Array.from(out);
}

/**
 * Map free-form topics (e.g. ["GDPR", "competition"]) to source keys
 * via `topic_mapping`, then to base domains. Useful for letting the LLM
 * say "search GDPR-related sources" without knowing slug names.
 */
export function getDomainsForTopics(topics: string[]): string[] {
    if (!topics?.length) return [];
    const data = load();
    const tm = data.topic_mapping ?? {};
    const keys = new Set<string>();
    for (const topic of topics) {
        for (const k of tm[topic] ?? tm[topic.toLowerCase()] ?? []) {
            keys.add(k);
        }
    }
    return getDomainsForSources(Array.from(keys));
}

/** Every domain referenced anywhere in the curated source set. */
export function getAllDomains(): string[] {
    const data = load();
    const out = new Set<string>();
    for (const src of Object.values(data.sources)) {
        if (src.domain) out.add(baseDomain(src.domain));
        if (src.domains) for (const d of src.domains) out.add(baseDomain(d));
    }
    return Array.from(out);
}

/**
 * Globally excluded domains (e.g. EUR-Lex when we already have those
 * documents in our DB and don't want web copies polluting answers).
 */
export function getDefaultExcludedDomains(): string[] {
    const data = load();
    return (data.excluded_domains?.domains ?? []).map(baseDomain);
}

/**
 * Return the set of source keys (slugs) the LLM is allowed to mention
 * in a `source_keys` web_search argument. Used to render a compact
 * description in the tool schema so the model doesn't invent slugs.
 */
export function listSourceKeys(): string[] {
    return Object.keys(load().sources);
}
