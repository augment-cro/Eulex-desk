/**
 * Loader and resolver for the declarative search/research config.
 *
 * Resolution order, per request:
 *   1. per-call overrides passed by the caller (LLM tool args / REST body)
 *   2. project-specific entry under `projects[project_id]`
 *   3. global `defaults`
 *
 * The JSON file is loaded once per process (sibling to
 * external_sources.json). Restart the backend to pick up edits.
 */

import fs from "fs";
import path from "path";
import type { SearchProvider } from "./types";

export interface ProjectSearchConfig {
    /** Allowed providers (env keys still need to be present at runtime). */
    providers: SearchProvider[];
    /** Preferred provider when caller doesn't specify one. */
    preferred_provider: SearchProvider | null;
    /**
     * Curated source-keys (resolved against external_sources.json) used
     * as include_domains allowlist when no explicit per-call list given.
     */
    source_keys: string[];
    /** Optional default recency window (days). null = open. */
    recency_days: number | null;
    /** Default num_results (overridable per call). */
    num_results: number;
    /**
     * MCP tool slugs (`mcp__server__tool`) the backend treats as
     * "search-grade" — informational only for now (system prompt hints
     * may consume this in future iterations).
     */
    mcp_search_tools: string[];
}

interface SearchConfigFile {
    defaults: Partial<ProjectSearchConfig>;
    mcp_search_tool_patterns: string[];
    projects: Record<string, Partial<ProjectSearchConfig>>;
}

let cached: SearchConfigFile | null = null;

const FILE_PATH = path.join(__dirname, "search_config.json");

function load(): SearchConfigFile {
    if (cached) return cached;
    try {
        const raw = fs.readFileSync(FILE_PATH, "utf-8");
        cached = JSON.parse(raw) as SearchConfigFile;
        const projectCount = Object.keys(cached.projects ?? {}).length;
        console.log(
            `[search_config] loaded defaults + ${projectCount} project overrides from ${FILE_PATH}`,
        );
    } catch (err) {
        console.warn(
            `[search_config] failed to load (${(err as Error).message}); using empty defaults`,
        );
        cached = {
            defaults: {},
            mcp_search_tool_patterns: [],
            projects: {},
        };
    }
    return cached;
}

const HARD_DEFAULTS: ProjectSearchConfig = {
    providers: ["tavily", "exa", "parallel", "you"],
    preferred_provider: "tavily",
    source_keys: [],
    recency_days: null,
    num_results: 5,
    mcp_search_tools: [],
};

function isProvider(s: unknown): s is SearchProvider {
    return s === "tavily" || s === "exa" || s === "parallel" || s === "you";
}

function normalize(
    partial: Partial<ProjectSearchConfig> | undefined,
    base: ProjectSearchConfig,
): ProjectSearchConfig {
    if (!partial) return base;
    const providers = Array.isArray(partial.providers)
        ? partial.providers.filter(isProvider)
        : base.providers;
    const preferred = isProvider(partial.preferred_provider)
        ? partial.preferred_provider
        : base.preferred_provider;
    return {
        providers: providers.length ? providers : base.providers,
        preferred_provider: preferred,
        source_keys: Array.isArray(partial.source_keys)
            ? partial.source_keys.filter(
                  (s): s is string => typeof s === "string",
              )
            : base.source_keys,
        recency_days:
            typeof partial.recency_days === "number"
                ? partial.recency_days
                : partial.recency_days === null
                  ? null
                  : base.recency_days,
        num_results:
            typeof partial.num_results === "number"
                ? partial.num_results
                : base.num_results,
        mcp_search_tools: Array.isArray(partial.mcp_search_tools)
            ? partial.mcp_search_tools.filter(
                  (s): s is string => typeof s === "string",
              )
            : base.mcp_search_tools,
    };
}

/**
 * Resolve the effective config for a project. Pass null for the global
 * (no-project) chat. Always returns a fully-populated object.
 */
export function resolveProjectSearchConfig(
    projectId: string | null,
): ProjectSearchConfig {
    const file = load();
    const withDefaults = normalize(file.defaults, HARD_DEFAULTS);
    if (!projectId) return withDefaults;
    return normalize(file.projects[projectId], withDefaults);
}

/**
 * Tool-name patterns the backend considers "search-grade" MCP tools —
 * useful for future research orchestration and for the LLM's
 * informational system prompt. Currently only consumed via
 * resolveProjectSearchConfig().mcp_search_tools (per-project), with
 * this list as the catalogue.
 */
export function listMcpSearchToolPatterns(): string[] {
    return load().mcp_search_tool_patterns ?? [];
}

/** Path of the active config file (handy for ops + tests). */
export function getSearchConfigPath(): string {
    return FILE_PATH;
}
