// Display labels for MCP tool calls shown in the chat timeline.
// Pure presentation — the LLM still calls the real MCP tool names; this only
// changes what the user reads. Returns a `streaming`-namespace i18n key, or
// null when we have no friendly label (caller falls back to the raw name).

// Croatian caselaw server (sys-zakon-ai). Names are unique, so key by tool.
const HR_ZAKON: Record<string, string> = {
    hr_search: "toolLabels.hrSearch",
    hr_find_publication: "toolLabels.hrFindPublication",
    hr_get_article: "toolLabels.hrGetArticle",
    hr_get_full_document: "toolLabels.hrGetFullDocument",
    hr_search_caselaw: "toolLabels.hrSearchCaselaw",
    hr_get_decision: "toolLabels.hrGetDecision",
    hr_get_decision_citations: "toolLabels.hrGetDecisionCitations",
    hr_get_related_decisions: "toolLabels.hrGetRelatedDecisions",
};

// EULEX (EU pravo) — generic names, scoped by server to avoid collisions.
const EULEX: Record<string, string> = {
    search: "toolLabels.euSearch",
    get_section: "toolLabels.euGetSection",
    get_metadata: "toolLabels.euGetMetadata",
    get_structure: "toolLabels.euGetStructure",
    get_related: "toolLabels.euGetRelated",
    find_by_date: "toolLabels.euFindByDate",
    get_timeline: "toolLabels.euGetTimeline",
    verify: "toolLabels.euVerify",
    eu_transposition: "toolLabels.euTransposition",
    eurostat_query: "toolLabels.euEurostat",
    list_scopes: "toolLabels.euListScopes",
    about: "toolLabels.euAbout",
};

// French law (Légifrance) — unique `fr_`-prefixed names, so key by tool.
const FR_LEGIFRANCE: Record<string, string> = {
    fr_search: "toolLabels.frSearch",
    fr_search_semantic: "toolLabels.frSearch",
    fr_get_article: "toolLabels.frGetArticle",
    fr_get_article_versions: "toolLabels.frGetArticleVersions",
    fr_get_article_by_id: "toolLabels.frGetArticle",
    fr_list_codes: "toolLabels.frListCodes",
    fr_list_code_articles: "toolLabels.frListCodes",
};

/**
 * Resolve a friendly i18n key for an MCP `(server, tool)` pair, or null when we
 * have no curated label. `server` is the server's display name as shown in the
 * chat (e.g. "Hrvatska zakoni", "EU pravo - Eulex.ai").
 */
export function mcpToolLabelKey(server: string, tool: string): string | null {
    if (tool in HR_ZAKON) return HR_ZAKON[tool];
    if (tool in FR_LEGIFRANCE) return FR_LEGIFRANCE[tool];
    if (server.includes("Eulex") && tool in EULEX) return EULEX[tool];
    return null;
}
