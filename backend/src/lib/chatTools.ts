import { createHash } from "node:crypto";
import { emptyUsage, sumUsage, attachUsage } from "./llm/usage";
import {
    downloadFile,
    generatedDocKey,
    storageKey,
    uploadFile,
} from "./storage";
import { convertedPdfKey } from "./convert";
import { createServerSupabase } from "./supabase";
import {
    applyTrackedEdits,
    preNormalize,
    type EditInput,
} from "./docxTrackedChanges";
import { buildDownloadUrl } from "./downloadTokens";
import {
    attachActiveVersionPaths,
    contentSha256,
    loadActiveVersion,
} from "./documentVersions";
import {
    streamChatWithTools,
    resolveModel,
    createStallWatchdog,
    resolveLlmStreamDeadlineMs,
    LlmStreamStallError,
    type LlmMessage,
    type OpenAIToolSchema,
    type StreamChatParams,
    type StreamChatResult,
} from "./llm";
import { runOrchestratedChat } from "./orchestration/runOrchestratedChat";
import { createQuoteMatcher, type QuoteMatcher } from "./quoteVerification";
import { resolveDefaultMainModel } from "./userSettings";
import {
    chatReadCharBudget,
    extractDocumentText,
    formatDocumentPart,
    splitTextIntoParts,
} from "./documentText";
import { generatedDocumentFilename } from "./filenameUtf8";
import {
    EMPTY_PLACEHOLDER_MAP,
    restorePlaceholders,
    stripPlaceholders,
    type PlaceholderMap,
} from "./pii/restoreArgs";
import { findMcpServerForTool } from "./mcp/servers";
import type { LoadedMcpServer } from "./mcp/types";
import {
    formatSearchResultsForLLM,
    webSearch,
    type SearchProvider,
} from "./search";
import { resolveProjectSearchConfig } from "./search/search_config";
import {
    getCapabilitiesPrompt,
    getDocCitationsPrompt,
    getMcpInstructionsPrompt,
    getPiiAddendumOverride,
    getPromptBlocks,
    getPromptPack,
    getSystemHeaderPrompt,
    getWebSearchPrompt,
    getWorkflowPacks,
} from "./seams/promptPack";
import {
    anySearchToolActive,
    getActiveSearchTools,
    getSearchRoute,
    isSearchToolName,
    resolveRouteProvider,
    type SearchKind,
} from "./search/tool_routes";
import { computeSearchCallCostUsd } from "./searchPricing";
import {
    READ_URL_COST_USD,
    READ_URL_TOOL,
    corpusOwnedUrlNotice,
    formatExtractForLLM,
    isExtractConfigured,
    readUrl,
} from "./extract";
import {
    scrubInternalIdentifiers,
    wrapUntrustedUserInput,
} from "./promptSecurity";
import {
    buildContextsSystemBlock,
    type ResolvedContext,
} from "./seams/contextsRuntime";
import {
    buildScopeSet,
    redactToolResult,
    precheckToolArgs,
    injectScopeParam,
    isLegalMcpServer,
} from "./seams/scopeEnforcement";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocStore = Map<
    string,
    { storage_path: string; file_type: string; filename: string }
>;

export type WorkflowStore = Map<string, { title: string; prompt_md: string }>;

export type DocIndex = Record<
    string,
    {
        document_id: string;
        filename: string;
        version_id?: string | null;
        version_number?: number | null;
    }
>;

export type TabularCellStore = {
    columns: { index: number; name: string }[];
    documents: { id: string; filename: string }[];
    /** key: `${colIndex}:${docId}` */
    cells: Map<string, { summary: string; flag?: string; reasoning?: string } | null>;
};

export type ToolCall = {
    id: string;
    function: { name: string; arguments: string };
};

export type ChatMessage = {
    role: string;
    content: string | null;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable brand label from an MCP server row for the
 * connector summary line (avoids showing only raw slugs when `name` is empty).
 *
 * Resolution order:
 *   1. `row.name` — when the operator has set a human-readable label
 *      (e.g. "LDH World" in mike/mcp.json or via the connector form).
 *      We accept anything that looks intentional — i.e. NOT equal to
 *      the slug and not slug-shaped (lowercase + dashes/underscores
 *      only). That way users get the brand they typed verbatim.
 *   2. URL-host title-case fallback — strip a leading "mcp.", "api.",
 *      "rpc.", or "connector." subdomain (these are placement details,
 *      not brand) and title-case the first label so "eulex.ai" → "Eulex.ai".
 *      Used when the row has no name or a slug-shaped placeholder name.
 *   3. `row.name` even if slug-shaped, then `row.slug`, then "MCP".
 */
export function mcpBrandLabel(row: {
    url?: string | null;
    name?: string | null;
    slug?: string | null;
}): string {
    const trimmedName = row.name?.trim();
    const trimmedSlug = row.slug?.trim();
    // A "human" name is anything the operator typed that isn't just a
    // copy of the slug. The slug-shape check catches forms that auto-fill
    // name=slug (e.g. "legal-data-hunter").
    const nameLooksHuman =
        !!trimmedName &&
        trimmedName !== trimmedSlug &&
        !/^[a-z0-9_-]+$/.test(trimmedName);

    if (nameLooksHuman) return trimmedName;

    const fromUrl = (() => {
        try {
            if (!row.url) return null;
            const host = new URL(row.url).hostname;
            if (!host || /^[\d.:]+$/.test(host)) return null; // IP — bail
            const stripped = host.replace(
                /^(mcp|api|rpc|connector)\./i,
                "",
            );
            const [first, ...rest] = stripped.split(".");
            if (!first) return null;
            const titled = first[0].toUpperCase() + first.slice(1);
            return [titled, ...rest].join(".");
        } catch {
            return null;
        }
    })();

    return fromUrl || trimmedName || trimmedSlug || "MCP";
}

/**
 * Map the user's currently-enabled MCP connectors to GENERIC legal-jurisdiction
 * and domain labels for the source-aware block. Returns ONLY generic names
 * (e.g. "Croatian law", "EU law", "tax practice") — never connector slugs,
 * brand names, or hostnames, which CONFIDENTIALITY forbids surfacing. Built-in /
 * known connectors are matched by slug+name substring so a newly-enabled
 * jurisdiction (e.g. a French-law connector) or domain source (tax, accounting)
 * is recognised automatically; general web-search connectors are skipped; any
 * unrecognised connector contributes a neutral catch-all so the model still
 * knows an additional source is live. National jurisdictions that are EU Member
 * States carry an explicit "(EU Member State …)" marker — the layered EU +
 * national research block keys off it.
 */
export function deriveActiveJurisdictions(
    mcpServers: { row?: { slug?: string | null; name?: string | null } }[],
): string[] {
    const labels = new Set<string>();
    let hasOther = false;
    for (const s of mcpServers ?? []) {
        const slug = (s.row?.slug || "").toLowerCase();
        const name = (s.row?.name || "").toLowerCase();
        const hay = `${slug} ${name}`;
        if (/tavily|web search|^search$/.test(hay) || slug === "tavily") continue;
        // National and sub-national branches must run BEFORE the EU branch:
        // the built-in French/Slovenian/German slugs are eulex-prefixed
        // (sys-eulex-fr, sys-eulex-si, sys-eulex-de) and the /eulex/ EU
        // pattern would otherwise swallow them and mislabel the session as
        // EU-only.
        if (/sggz|zagreb/.test(hay)) labels.add("City of Zagreb local ordinances (Službeni glasnik Grada Zagreba — sub-national layer within Croatian law)");
        else if (/zakon|narodne|hrvat|croat/.test(hay)) labels.add("Croatian law (EU Member State — EU law applies within it)");
        else if (/legifrance|france|french|francus|eulex-fr/.test(hay)) labels.add("French law (EU Member State — EU law applies within it)");
        else if (/sloven|eulex-si/.test(hay)) labels.add("Slovenian law (EU Member State — EU law applies within it)");
        else if (/njema|german|deutsch|eulex-de/.test(hay)) labels.add("German law (EU Member State — EU law applies within it)");
        else if (/ris-?at|austria|österreich|osterreich/.test(hay)) labels.add("Austrian law (EU Member State — EU law applies within it)");
        else if (/legal-it|italij|italian|\bitaly\b/.test(hay)) labels.add("Italian law (EU Member State — EU law applies within it)");
        else if (/uk-?legal|legislation\.gov\.uk|united kingdom/.test(hay)) labels.add("UK law");
        else if (/eulex|eur-?lex/.test(hay)) labels.add("EU law (EUR-Lex / CJEU scope)");
        else if (/porez|\btax\b|\bvat\b|\bpdv\b/.test(hay)) labels.add("tax — official tax practice, rulings and guidance");
        else if (/ra[čc]unovod|accounting|ifrs|hsfi|audit/.test(hay)) labels.add("accounting and financial reporting standards");
        else if (/hanfa|hnb\b|financial regul|supervis/.test(hay)) labels.add("financial regulation and supervisory practice");
        else hasOther = true;
    }
    const out = [...labels];
    if (hasOther)
        out.push(
            "other enabled source(s) — infer the jurisdiction or domain from the tool description at call time",
        );
    return out;
}

/**
 * MCP grounding / jurisdiction / research-procedure addenda for the STATIC
 * (cached) system prompt, assembled from the governance prompt-pack blocks
 * (or the short generic fallback — see lib/seams/promptPack.ts):
 *
 *  - `grounding` — appended whenever >=1 connector is live; its
 *    {{GROUNDING_POINT_1}} placeholder is filled with the eulex or generic
 *    branch depending on whether an EU-law connector is live.
 *  - `jurisdictions` — appended when deriveActiveJurisdictions finds >=1
 *    label; {{ACTIVE_JURISDICTIONS}} is filled with the labels joined by '; '.
 *  - `layered_research` — only when an EU source AND a Member-State national
 *    source are both live.
 *  - `topic_routing` — only when more than one jurisdiction/domain is live.
 *  - `mcp_instructions` — when >=1 live server ships initialize-time
 *    `instructions`, those notes are appended per server so the model gets
 *    each source's own tool-usage guidance (tool selection, identifiers,
 *    query language).
 *
 * SECURITY: never enumerate connector slugs or hostnames in the system
 * prompt — jurisdiction labels stay generic. Deliberate exception: each
 * instructions note is prefixed with the connector's DISPLAY name (the
 * same `[Name]` its tool descriptions already carry) so the model can tie
 * a note to its tools; the wrapper block keeps the notes confidential and
 * non-overriding. An empty pack block inserts nothing at its position.
 */
export function buildMcpPromptAddenda(
    mcpServers: {
        row: { slug?: string | null; name?: string | null };
        instructions?: string;
    }[],
): string {
    const blocks = getPromptBlocks();
    let out = "";

    const eulexAvailable = mcpServers.some((s) =>
        (s.row.slug || "").toLowerCase().includes("eulex"),
    );
    if (blocks.grounding) {
        const point1 = eulexAvailable
            ? blocks.grounding_point1_eulex
            : blocks.grounding_point1_generic;
        out += blocks.grounding.replace("{{GROUNDING_POINT_1}}", () => point1);
    }

    const activeJurisdictions = deriveActiveJurisdictions(mcpServers);
    if (activeJurisdictions.length > 0 && blocks.jurisdictions) {
        out += blocks.jurisdictions.replace(
            "{{ACTIVE_JURISDICTIONS}}",
            () => activeJurisdictions.join("; "),
        );
    }

    const hasMemberStateNational = activeJurisdictions.some((l) =>
        l.includes("EU Member State"),
    );
    if (eulexAvailable && hasMemberStateNational && blocks.layered_research) {
        out += blocks.layered_research;
    }

    if (activeJurisdictions.length > 1 && blocks.topic_routing) {
        out += blocks.topic_routing;
    }

    // Servers' own initialize-time `instructions` — per-server tool-usage
    // guidance (tool selection, identifier formats, query language). Each
    // note is prefixed with the connector's display name, matching the
    // `[Name]` prefix its tool descriptions already carry, so the model can
    // associate a note with the tools it governs. Third-party text: the
    // wrapper block scopes it to tool usage and keeps it non-overriding.
    const serverNotes: string[] = [];
    for (const s of mcpServers) {
        const note = s.instructions?.trim();
        if (!note) continue;
        const capped =
            note.length > MCP_INSTRUCTIONS_MAX_CHARS
                ? `${note.slice(0, MCP_INSTRUCTIONS_MAX_CHARS)}\n[… truncated]`
                : note;
        serverNotes.push(`[${s.row.name || "source"}]\n${capped}`);
    }
    if (serverNotes.length > 0) {
        out += getMcpInstructionsPrompt().replace(
            "{{MCP_SERVER_INSTRUCTIONS}}",
            () => serverNotes.join("\n\n"),
        );
    }
    return out;
}

/** Per-server cap on injected MCP `instructions` (defensive: a runaway
 *  third-party server must not flood the cached system-prompt prefix). */
const MCP_INSTRUCTIONS_MAX_CHARS = 4000;

// The legal reasoning & method and legal-source-citation sections of the
// base system prompt come from the governance prompt pack (or the short
// generic fallback) — see buildCoreSystemPrompt below and
// lib/seams/promptPack.ts. No legal-methodology content lives here.

/**
 * Assemble the base (static, cacheable) system prompt: the generic core
 * sections plus the governance prompt-pack blocks (or the short generic
 * fallback) at their fixed positions. Byte-identical to the pre-seam
 * literal when the pack carries the original content. Empty pack blocks
 * insert nothing at their position.
 */
export function buildCoreSystemPrompt(): string {
    const blocks = getPromptBlocks();
    // The capabilities section cross-references the method section by its
    // heading; derive it from the pack block's first line so the reference
    // always names whatever the active method section is called.
    const methodHeading =
        blocks.method.split("\n")[0]?.replace(/:$/, "") || "the legal method section";
    return [
        getSystemHeaderPrompt(),
        ...(blocks.method ? [blocks.method] : []),
        getDocCitationsPrompt(),
        ...(blocks.citations_legal ? [blocks.citations_legal] : []),
        getCapabilitiesPrompt().replace(
            "{{METHOD_SECTION_HEADING}}",
            () => methodHeading,
        ),
    ].join("\n\n");
}

export const PROJECT_EXTRA_TOOLS = [
    {
        type: "function",
        function: {
            name: "list_documents",
            description:
                "List all documents available in the project. Returns each document's ID, filename, and file type. Call this to discover what documents are available before deciding which ones to read.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "fetch_documents",
            description:
                "Read the full text content of multiple documents in a single call. Use this instead of calling read_document repeatedly when you need to read several documents at once.",
            parameters: {
                type: "object",
                properties: {
                    doc_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                            "Array of document IDs to read (e.g. ['doc-0', 'doc-2'])",
                    },
                },
                required: ["doc_ids"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "replicate_document",
            description:
                "Make byte-for-byte copies of an existing project document as new project documents. Use when the user wants standalone copies to edit (e.g. 'use this NDA as a template', 'give me three drafts I can adapt') without modifying the original. Pass `count` to create multiple copies in a single call rather than calling the tool repeatedly. Returns the new doc_id slugs so you can immediately call edit_document / read_document on them.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "ID of the source document to copy (e.g. 'doc-0').",
                    },
                    count: {
                        type: "integer",
                        description:
                            "How many copies to create. Defaults to 1. Maximum 20.",
                        minimum: 1,
                        maximum: 20,
                    },
                    new_filename: {
                        type: "string",
                        description:
                            "Optional base filename. With count > 1, copies are suffixed (e.g. 'Foo (1).docx', 'Foo (2).docx'). Extension is forced to match the source.",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
];

export const TABULAR_TOOLS = [
    {
        type: "function",
        function: {
            name: "read_table_cells",
            description:
                "Read the extracted cell content from the tabular review. Each cell contains the value extracted for a specific column from a specific document. Pass col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or all rows.",
            parameters: {
                type: "object",
                properties: {
                    col_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based column indices to read (e.g. [0, 2]). Omit to read all columns.",
                    },
                    row_indices: {
                        type: "array",
                        items: { type: "integer" },
                        description:
                            "0-based document (row) indices to read (e.g. [0, 1]). Omit to read all rows.",
                    },
                },
            },
        },
    },
];

export const WORKFLOW_TOOLS = [
    {
        type: "function",
        function: {
            name: "list_workflows",
            description:
                "List all workflows available to the user. Returns each workflow's ID and title. Call this when the user asks to run a workflow, apply a template, or you need to discover what workflows exist.",
            parameters: { type: "object", properties: {} },
        },
    },
    {
        type: "function",
        function: {
            name: "read_workflow",
            description:
                "Read the full instructions (prompt) of a workflow by its ID. Call this after list_workflows to load a specific workflow's prompt, then follow those instructions.",
            parameters: {
                type: "object",
                properties: {
                    workflow_id: {
                        type: "string",
                        description: "The workflow ID to read",
                    },
                },
                required: ["workflow_id"],
            },
        },
    },
];

export const TOOLS = [
    {
        type: "function",
        function: {
            name: "read_document",
            description:
                "Read the full text content of a document attached by the user. Always call this before answering questions about, summarising, or citing from a document. A very long document is returned in parts; the result then says which part you have and how to request the next one.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to read (e.g. 'doc-0', 'doc-1')",
                    },
                    part: {
                        type: "integer",
                        minimum: 1,
                        description:
                            "Only for long documents returned in parts: the 1-based part to read. Omit on the first read.",
                    },
                },
                required: ["doc_id"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "find_in_document",
            description:
                "Search for specific strings inside a document — a Ctrl+F equivalent. Returns each match with surrounding context so you can locate and quote the exact text without reading the whole document. Matching is case-insensitive and whitespace-tolerant. Use this for targeted lookups (e.g. finding a clause title, party name, or a specific phrase) rather than reading the whole document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description:
                            "The document ID to search (e.g. 'doc-0').",
                    },
                    query: {
                        type: "string",
                        description:
                            "The string to search for. Matching is case-insensitive and collapses runs of whitespace, so 'Section 4.2' matches 'section   4.2'.",
                    },
                    max_results: {
                        type: "integer",
                        description:
                            "Maximum number of matches to return (default 20). Use a smaller value for common terms.",
                    },
                    context_chars: {
                        type: "integer",
                        description:
                            "Characters of surrounding context to include on each side of a match (default 80).",
                    },
                },
                required: ["doc_id", "query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "generate_docx",
            strict: true,
            description:
                "Generate a Word (.docx) document from structured content. Use this when the user asks you to draft, create, or produce a legal document. Returns a download URL for the generated file. IMPORTANT: You MUST provide a non-empty sections array with at least one section containing content.",
            parameters: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        description: "Document title (used as filename and heading)",
                    },
                    landscape: {
                        type: "boolean",
                        description: "Set to true for landscape page orientation. Default is portrait.",
                    },
                    sections: {
                        type: "array",
                        description: "List of document sections. Each section may contain a heading, prose content, or a table. MUST contain at least one section with content.",
                        items: {
                            type: "object",
                            properties: {
                                heading: { type: "string", description: "Optional section heading" },
                                level: { type: "integer", description: "Heading level: 1, 2, or 3" },
                                content: { type: "string", description: "Prose text content (paragraphs separated by double newlines)" },
                                pageBreak: { type: "boolean", description: "Set to true to start this section on a new page. Use for contract signature pages." },
                                table: {
                                    type: "object",
                                    description: "Optional table to render in this section",
                                    properties: {
                                        headers: {
                                            type: "array",
                                            items: { type: "string" },
                                            description: "Column header labels",
                                        },
                                        rows: {
                                            type: "array",
                                            items: {
                                                type: "array",
                                                items: { type: "string" },
                                            },
                                            description: "Array of rows, each row is an array of cell strings matching the headers order",
                                        },
                                    },
                                    required: ["headers", "rows"],
                                    additionalProperties: false,
                                },
                            },
                            additionalProperties: false,
                        },
                    },
                },
                required: ["title", "sections"],
                additionalProperties: false,
            },
        },
    },
    {
        type: "function",
        function: {
            name: "edit_document",
            description:
                "Propose edits to a user-attached .docx as tracked changes. Each edit is a precise, minimal substitution of specific words/characters, NOT a whole-line or paragraph replacement. Use read_document first. Anchor each edit with short before/after context so it can be located unambiguously. Returns per-edit annotations the UI will render as Accept/Reject cards and a download link to the edited document.",
            parameters: {
                type: "object",
                properties: {
                    doc_id: {
                        type: "string",
                        description: "Document slug (e.g. 'doc-0').",
                    },
                    edits: {
                        type: "array",
                        description: "List of precise substitutions.",
                        items: {
                            type: "object",
                            properties: {
                                find: {
                                    type: "string",
                                    description:
                                        "Exact substring to replace (keep it as short as possible — ideally just the words/chars being changed).",
                                },
                                replace: {
                                    type: "string",
                                    description: "Replacement text. Empty string = pure deletion.",
                                },
                                context_before: {
                                    type: "string",
                                    description: "~40 chars immediately preceding `find`, used to disambiguate.",
                                },
                                context_after: {
                                    type: "string",
                                    description: "~40 chars immediately following `find`.",
                                },
                                reason: {
                                    type: "string",
                                    description: "Short explanation shown to the user on the card.",
                                },
                            },
                            required: ["find", "replace", "context_before", "context_after"],
                        },
                    },
                },
                required: ["doc_id", "edits"],
            },
        },
    },
];

/**
 * Web search tools live in ./search/tool_routes.ts. The model is given
 * three intent-named tools (search_official_sources / search_web /
 * search_news), each routed to a provider internally — see
 * getActiveSearchTools() and the runToolCalls handler below.
 */

type ParsedCitation =
    | {
          kind: "doc";
          ref: number;
          doc_id: string;
          page: number | string;
          quote: string;
      }
    | { kind: "source"; ref: number; source_id: string; quote: string };

function normalizeCitation(raw: unknown): ParsedCitation | null {
    if (!raw || typeof raw !== "object") return null;
    const c = raw as Record<string, unknown>;
    if (typeof c.ref !== "number") return null;
    if (typeof c.quote !== "string" || !c.quote) return null;
    // Legal-source citation variant (EU/HR/FR): `source_id` instead of
    // `doc_id`/`page`. Resolved against the per-turn `legal_sources` registry.
    if (typeof c.source_id === "string" && c.source_id) {
        return { kind: "source", ref: c.ref, source_id: c.source_id, quote: c.quote };
    }
    // Document citation variant (uploaded/generated docs).
    if (typeof c.doc_id !== "string") return null;
    let page: number | string;
    if (typeof c.page === "number") {
        page = c.page;
    } else if (typeof c.page === "string" && /^\d+\s*-\s*\d+$/.test(c.page)) {
        page = c.page;
    } else {
        const n = parseInt(String(c.page ?? ""), 10);
        if (!Number.isFinite(n)) return null;
        page = n;
    }
    return { kind: "doc", ref: c.ref, doc_id: c.doc_id, page, quote: c.quote };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveDoc(rawId: string, docIndex: DocIndex) {
    return docIndex[rawId];
}

/**
 * Resolve whatever identifier the model passed (`doc-N` slug, filename, or
 * document UUID) back to a chat-local doc label. Generated docs surface in
 * tool results with both `doc_id` (slug) and `document_id` (UUID), so the
 * model often picks the wrong one — without this fallback `read_document`
 * silently returns "not found" and the model gives up and re-generates.
 */
export function resolveDocLabel(
    rawId: string,
    docStore: DocStore,
    docIndex?: DocIndex,
): string | null {
    // 1. Exact slug (doc-N) — the canonical handle.
    if (docStore.has(rawId)) return rawId;
    // 2. Document UUID — globally unique, so safe to resolve unconditionally.
    if (docIndex) {
        for (const [label, info] of Object.entries(docIndex)) {
            if (info.document_id === rawId) return label;
        }
    }
    // 3. Filename — NOT unique (replicate_document copies, duplicate uploads).
    // Only resolve when exactly one doc matches; refuse to guess otherwise so
    // the model can't silently read/edit the wrong document.
    const byName: string[] = [];
    for (const [label, info] of docStore.entries()) {
        if (info.filename === rawId) byName.push(label);
    }
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        console.warn(
            `[resolveDocLabel] ambiguous filename "${rawId}" matches ${byName.length} docs (${byName.join(", ")}); refusing to guess — pass a doc-N slug or document_id`,
        );
    }
    return null;
}

/**
 * Append a tool-activity summary to the most recent assistant message so
 * the model can see what it just did (read / create / edit / workflow
 * applied) in the prior turn — otherwise it only sees its own prose and
 * forgets which docs it touched, which leads to e.g. re-generating a doc
 * that already exists.
 *
 * Doc references use the *current-turn* `doc_id` slug (looked up by
 * matching the event's stored `document_id` against this turn's freshly
 * built `docIndex`), since slugs are reassigned every turn and the old
 * slug from the prior turn would be meaningless. Falls back to filename
 * only if the doc is no longer in the index (deleted, scope changed).
 */
export async function enrichWithPriorEvents(
    messages: ChatMessage[],
    chatId: string | null | undefined,
    db: ReturnType<typeof createServerSupabase>,
    docIndex: DocIndex,
): Promise<ChatMessage[]> {
    if (!chatId) return messages;
    const { data: rows } = await db
        .from("chat_messages")
        .select("content, created_at")
        .eq("chat_id", chatId)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1);

    const lastRow = rows?.[0] as { content?: unknown } | undefined;
    const content = lastRow?.content;
    if (!Array.isArray(content)) return messages;

    const slugByDocumentId = new Map<string, string>();
    for (const [slug, info] of Object.entries(docIndex)) {
        if (info.document_id) slugByDocumentId.set(info.document_id, slug);
    }
    const refFor = (documentId: unknown, filename: unknown) => {
        const slug =
            typeof documentId === "string"
                ? slugByDocumentId.get(documentId)
                : undefined;
        return slug ? `${slug} ("${filename}")` : `"${filename}"`;
    };

    const lines: string[] = [];
    for (const ev of content as Record<string, unknown>[]) {
        if (ev?.type === "doc_created") {
            lines.push(
                `- generate_docx → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_edited") {
            lines.push(
                `- edit_document → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_read") {
            lines.push(
                `- read_document → ${refFor(ev.document_id, ev.filename)}`,
            );
        } else if (ev?.type === "doc_replicated") {
            // The model needs to know what each copy resolved to so it
            // can call edit_document / read_document on them. Emit one
            // line per copy, all attributed back to the same source.
            const srcLabel =
                typeof ev.filename === "string" ? `"${ev.filename}"` : "";
            const copies = Array.isArray(ev.copies)
                ? (ev.copies as {
                      new_filename?: unknown;
                      document_id?: unknown;
                  }[])
                : [];
            for (const c of copies) {
                const ref = refFor(c.document_id, c.new_filename);
                lines.push(
                    srcLabel
                        ? `- replicate_document → ${ref} (copy of ${srcLabel})`
                        : `- replicate_document → ${ref}`,
                );
            }
        } else if (ev?.type === "workflow_applied") {
            lines.push(`- applied workflow: "${ev.title}"`);
        }
    }
    if (lines.length === 0) return messages;
    const summary = `\n\n[Tool activity in your previous turn]\n${lines.join("\n")}`;

    // Find the index of the last assistant message and attach the
    // summary there only.
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
        }
    }
    if (lastAssistantIdx < 0) return messages;
    const enriched = messages.slice();
    const target = enriched[lastAssistantIdx];
    enriched[lastAssistantIdx] = {
        ...target,
        content: (target.content ?? "") + summary,
    };
    return enriched;
}

/**
 * Sentinel separating the static system prompt (cacheable) from the
 * per-turn dynamic block — the reference-time line and the AVAILABLE
 * DOCUMENTS list (not cacheable). `buildMessages`
 * emits it right before that block; `runLLMStream` splits on it and
 * forwards the trailing block to the LLM adapter as `systemDynamicSuffix`
 * so the large static prompt keeps hitting the Anthropic prompt cache even
 * when doc-N slugs are reassigned. Plain token (no surrounding newlines)
 * so the static + suffix concatenation is byte-identical to the old single
 * string for non-caching providers.
 */
const SYSTEM_DYNAMIC_DOC_MARKER = "<<<__MAX_DYNAMIC_DOC_CONTEXT__>>>";

export function buildMessages(
    messages: ChatMessage[],
    docAvailability: { doc_id: string; filename: string; folder_path?: string }[],
    systemPromptExtra?: string,
    docIndex?: DocIndex,
    // Per-request volatile system context (e.g. the reference-time line,
    // hour-truncated but still changing over a session's lifetime).
    // Emitted AFTER the dynamic marker so it rides in the uncached
    // `systemDynamicSuffix` instead of busting the cache_control'd static
    // prefix. Keep this byte-stable between consecutive turns wherever
    // possible — it renders before `messages`, so any change here also
    // invalidates the rolling conversation-history breakpoint.
    systemDynamicExtra?: string,
) {
    const formatted: unknown[] = [];
    let systemContent = buildCoreSystemPrompt();

    if (systemPromptExtra) {
        systemContent += `\n\n${systemPromptExtra.trim()}`;
    }

    if (systemDynamicExtra || docAvailability.length) {
        // Marker goes between the `\n\n` separator and the dynamic content
        // so the static slice keeps its trailing newlines and
        // `static + suffix` reconstructs the full prompt byte-for-byte for
        // non-caching providers (see runLLMStream split).
        systemContent += `\n\n${SYSTEM_DYNAMIC_DOC_MARKER}`;
    }
    if (systemDynamicExtra) {
        systemContent += `${systemDynamicExtra.trim()}\n`;
        if (docAvailability.length) systemContent += "\n";
    }
    if (docAvailability.length) {
        systemContent += `---\nAVAILABLE DOCUMENTS:\n`;
        for (const doc of docAvailability) {
            const label = doc.folder_path ? `${doc.folder_path} / ${doc.filename}` : doc.filename;
            systemContent += `- ${doc.doc_id}: ${label}\n`;
        }
        systemContent +=
            "\nYou do NOT retain document content between conversation turns. You MUST call read_document (or fetch_documents) at the start of every response that involves a document's content, even if you have read it in a previous turn. Failure to do so will result in hallucinated or stale content.\n---\n";
    }
    formatted.push({ role: "system", content: systemContent });

    // Map document_id (UUID) → current-turn doc_id slug, so when we
    // inline a user attachment we hand the model the same handle it
    // would use to call read_document / fetch_documents.
    const slugByDocumentId = new Map<string, string>();
    if (docIndex) {
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id) slugByDocumentId.set(info.document_id, slug);
        }
    }

    for (const msg of messages) {
        let content = msg.content ?? "";
        if (msg.role === "user") {
            // SECURITY: wrap raw user content in <user_input>…</user_input>
            // tags so the model treats it as DATA (see UNTRUSTED USER INPUT
            // rule in SYSTEM_PROMPT). Trusted server-side annotations
            // (workflow header, attached-doc manifest) are appended OUTSIDE
            // the wrapper so the model still reads them as operator-side
            // context. wrapUntrustedUserInput also defangs any nested
            // closing tag the attacker might try to splice in.
            const wrapped = wrapUntrustedUserInput(content);
            const annotations: string[] = [];
            if (msg.workflow) {
                annotations.push(
                    `[Workflow: ${msg.workflow.title} (id: ${msg.workflow.id})]`,
                );
            }
            if (msg.files?.length) {
                const lines = msg.files.map((f) => {
                    const slug = f.document_id
                        ? slugByDocumentId.get(f.document_id)
                        : undefined;
                    return slug
                        ? `- ${slug}: ${f.filename}`
                        : `- ${f.filename}`;
                });
                annotations.push(
                    `[The user attached the following document(s) to this message:\n${lines.join("\n")}]`,
                );
            }
            content = annotations.length
                ? `${annotations.join("\n\n")}\n\n${wrapped}`
                : wrapped;
        }
        formatted.push({ role: msg.role, content });
    }
    return formatted;
}

export async function generateDocx(
    title: string,
    sections: unknown[],
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
    options?: {
        landscape?: boolean;
        projectId?: string | null;
        /**
         * Title the filename is built from when it must differ from the
         * in-document heading — in PII mode the heading carries restored
         * real values, the filename never does (it is shown to the model
         * again in later turns).
         */
        filenameTitle?: string;
    },
) {
    try {
        // Safeguard: ensure sections is actually an array
        if (!Array.isArray(sections)) {
            console.error(`[generateDocx] sections is not an array! type=${typeof sections}, value=${JSON.stringify(sections).slice(0, 500)}`);
            sections = [];
        }
        const filename = generatedDocumentFilename(
            options?.filenameTitle ?? title,
            "docx",
        );
        console.log(`[generateDocx] Processing ${sections.length} sections for filename="${filename}"`);
        const {
            Document, Paragraph, HeadingLevel, Packer,
            Table, TableRow, TableCell, WidthType, BorderStyle,
            TextRun, AlignmentType, PageOrientation, PageBreak,
        } = await import("docx");

        const FONT = "Times New Roman";
        const SIZE = 22; // 11pt in half-points

        type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
        const children: DocChild[] = [];
        children.push(
            new Paragraph({
                heading: HeadingLevel.TITLE,
                spacing: { after: 200 },
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: title.toUpperCase(), color: "000000", font: FONT, size: SIZE, bold: true })],
            }),
        );

        const cellBorder = {
            top:    { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            left:   { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
            right:  { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
        };

        const headingLevels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
            HeadingLevel.HEADING_4,
        ];
        const counters = [0, 0, 0, 0];

        for (const section of sections as {
            heading?: string;
            content?: string;
            level?: number;
            pageBreak?: boolean;
            table?: { headers: string[]; rows: string[][] };
        }[]) {
            if (section.pageBreak) {
                children.push(
                    new Paragraph({ children: [new PageBreak()] }),
                );
            }
            if (section.heading) {
                const idx = Math.min((section.level ?? 1) - 1, 3);
                counters[idx]++;
                for (let i = idx + 1; i < 4; i++) counters[i] = 0;
                // Backfill any skipped ancestor levels so a forbidden H1→H3
                // jump renders "1.1.1" instead of "1.0.1". The prompt tells
                // the model not to skip levels, but we must not depend on it.
                for (let i = 0; i < idx; i++) if (counters[i] === 0) counters[i] = 1;
                const prefix = counters.slice(0, idx + 1).join(".");
                const headingText = `${prefix}. ${idx === 0 ? section.heading.toUpperCase() : section.heading}`;
                children.push(
                    new Paragraph({
                        heading: headingLevels[idx],
                        spacing: { after: 160 },
                        children: [new TextRun({ text: headingText, color: "000000", font: FONT, size: SIZE, bold: true })],
                    }),
                );
            }
            if (section.table) {
                const { headers, rows } = section.table;
                const colCount = headers.length;
                const tableRows: InstanceType<typeof TableRow>[] = [];
                // Header row
                tableRows.push(
                    new TableRow({
                        tableHeader: true,
                        children: headers.map(
                            (h) =>
                                new TableCell({
                                    borders: cellBorder,
                                    shading: { fill: "F2F2F2" },
                                    children: [
                                        new Paragraph({
                                            children: [new TextRun({ text: h, bold: true, font: FONT, size: SIZE })],
                                            alignment: AlignmentType.LEFT,
                                        }),
                                    ],
                                }),
                        ),
                    }),
                );
                // Data rows — normalize each row to exactly colCount cells.
                // LLMs occasionally emit malformed rows (extra fragments from
                // stray delimiters, or short rows); padding/truncating here
                // keeps the rendered table aligned to the headers.
                for (const rawRow of rows) {
                    const row = Array.isArray(rawRow) ? rawRow : [];
                    const normalized: string[] = [];
                    for (let i = 0; i < colCount; i++) {
                        normalized.push(
                            typeof row[i] === "string" ? row[i] : "",
                        );
                    }
                    if (row.length !== colCount) {
                        console.warn(
                            `[generate_docx] row length ${row.length} != headers ${colCount}; normalized`,
                        );
                    }
                    tableRows.push(
                        new TableRow({
                            children: normalized.map(
                                (cell) =>
                                    new TableCell({
                                        borders: cellBorder,
                                        children: [
                                            new Paragraph({
                                                children: [new TextRun({ text: cell, font: FONT, size: SIZE })],
                                            }),
                                        ],
                                    }),
                            ),
                        }),
                    );
                }
                children.push(
                    new Table({
                        width: { size: 100, type: WidthType.PERCENTAGE },
                        rows: tableRows,
                    }),
                );
                children.push(new Paragraph({ text: "" }));
            }
            if (section.content) {
                for (const line of section.content.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
                    if (bulletMatch) {
                        children.push(
                            new Paragraph({
                                bullet: { level: 0 },
                                spacing: { after: 120 },
                                children: [new TextRun({ text: bulletMatch[1], font: FONT, size: SIZE })],
                            }),
                        );
                    } else {
                        children.push(
                            new Paragraph({
                                spacing: { after: 120 },
                                children: [new TextRun({ text: trimmed, font: FONT, size: SIZE })],
                            }),
                        );
                    }
                }
            }
        }

        const pageSetup = options?.landscape
            ? { page: { size: { orientation: PageOrientation.LANDSCAPE } } }
            : {};

        const doc = new Document({ sections: [{ properties: pageSetup, children }] });
        const buf = await Packer.toBuffer(doc);
        const docId = crypto.randomUUID().replace(/-/g, "");
        const key = generatedDocKey(userId, docId, filename);

        await uploadFile(
            key,
            buf.buffer as ArrayBuffer,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        const downloadUrl = buildDownloadUrl(key, filename);

        // Persist to DB so generated docs are first-class documents:
        // openable in the DocPanel and editable via edit_document. In
        // project chats we attach to the project so it appears in the
        // sidebar; in the general chat we leave project_id null and it
        // stays a standalone document.
        const { data: docRow, error: docErr } = await db
            .from("documents")
            .insert({
                project_id: options?.projectId ?? null,
                user_id: userId,
                filename,
                file_type: "docx",
                size_bytes: buf.byteLength,
                status: "ready",
            })
            .select("id")
            .single();
        if (docErr || !docRow) {
            return {
                error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
            };
        }
        const documentId = docRow.id as string;

        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: documentId,
                storage_path: key,
                source: "generated",
                version_number: 1,
                display_name: filename,
                size_bytes: buf.byteLength,
                content_sha256: contentSha256(buf),
            })
            .select("id")
            .single();
        if (verErr || !versionRow) {
            return {
                error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
            };
        }
        const versionId = versionRow.id as string;

        await db
            .from("documents")
            .update({ current_version_id: versionId })
            .eq("id", documentId);

        return {
            filename,
            download_url: downloadUrl,
            document_id: documentId,
            version_id: versionId,
            version_number: 1,
            storage_path: key,
            message: `Document '${filename}' has been generated successfully.`,
        };
    } catch (e) {
        return { error: String(e) };
    }
}

// ---------------------------------------------------------------------------
// Document version helpers (DOCX tracked-change editing)
// ---------------------------------------------------------------------------

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
    documentId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
    const active = await loadActiveVersion(documentId, db);
    if (!active) return null;
    const raw = await downloadFile(active.storage_path);
    if (!raw) return null;
    return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

/**
 * Ensure the document has a document_versions row for the current upload.
 * Called before writing the first 'assistant_edit' row so the history is
 * complete. Idempotent.
 */
export async function runEditDocument(params: {
    documentId: string;
    userId: string;
    edits: EditInput[];
    db: ReturnType<typeof createServerSupabase>;
    /**
     * If provided, append these edits to the existing turn-scoped version
     * (overwrites the file at storagePath and reuses the document_versions
     * row) instead of creating a new version. Used to collapse multiple
     * edit_document tool calls within a single assistant turn into one
     * version.
     */
    reuseVersion?: {
        versionId: string;
        versionNumber: number;
        storagePath: string;
    };
}): Promise<
    | {
          ok: true;
          version_id: string;
          version_number: number;
          storage_path: string;
          download_url: string;
          annotations: EditAnnotation[];
          errors: { index: number; reason: string }[];
      }
    | { ok: false; error: string }
> {
    const { documentId, userId, edits, db, reuseVersion } = params;

    const { data: doc } = await db
        .from("documents")
        .select("id, filename")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false, error: "Document not found." };

    const current = await loadCurrentVersionBytes(documentId, db);
    if (!current) return { ok: false, error: "Could not load document bytes." };

    const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(
        current.bytes,
        edits,
        { author: "Eulex Desk" },
    );

    if (changes.length === 0) {
        return {
            ok: false,
            error:
                errors[0]?.reason ??
                "No edits could be applied. Refine context_before/context_after and retry.",
        };
    }

    const ab = editedBytes.buffer.slice(
        editedBytes.byteOffset,
        editedBytes.byteOffset + editedBytes.byteLength,
    ) as ArrayBuffer;

    let versionRowId: string;
    let newPath: string;
    let nextVersionNumber: number;

    if (reuseVersion) {
        // Overwrite the existing turn version's file in place. The version
        // row, version_number, and current_version_id all already point here.
        newPath = reuseVersion.storagePath;
        versionRowId = reuseVersion.versionId;
        nextVersionNumber = reuseVersion.versionNumber;

        // Clear the hash before the bytes change; the update below sets it
        // again. Storage and Postgres cannot be written atomically, so a
        // failure between the two leaves the version unhashed — reported by
        // the export manifest as unverifiable — rather than hashed against
        // content it no longer holds.
        await db
            .from("document_versions")
            .update({ content_sha256: null })
            .eq("id", versionRowId);

        await uploadFile(
            newPath,
            ab,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        await db
            .from("document_versions")
            .update({
                content_sha256: contentSha256(editedBytes),
                size_bytes: editedBytes.byteLength,
            })
            .eq("id", versionRowId);
    } else {
        const versionId = crypto.randomUUID().replace(/-/g, "");
        newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
        await uploadFile(
            newPath,
            ab,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );

        // Per-document sequential number for the new assistant_edit
        // version. The counter spans upload + user_upload + assistant_edit
        // so the original upload is V1 and the first assistant edit is V2.
        const { data: maxRow } = await db
            .from("document_versions")
            .select("version_number")
            .eq("document_id", documentId)
            .in("source", ["upload", "user_upload", "assistant_edit"])
            .order("version_number", { ascending: false, nullsFirst: false })
            .limit(1)
            .maybeSingle();
        nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

        // Inherit the display name from the most recent prior version so
        // user-applied renames carry forward through further edits. Falls
        // back to the parent document's filename when no prior version has
        // a display name (e.g. the first assistant edit of a pre-existing
        // doc). We intentionally do NOT append "[Edited Vn]" — the version
        // number is surfaced separately as a tag in the UI.
        const { data: prevRow } = await db
            .from("document_versions")
            .select("display_name, created_at")
            .eq("document_id", documentId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        const inheritedDisplayName =
            (prevRow?.display_name as string | null) ??
            (doc.filename as string | null) ??
            null;

        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: documentId,
                storage_path: newPath,
                source: "assistant_edit",
                version_number: nextVersionNumber,
                display_name: inheritedDisplayName,
                size_bytes: editedBytes.byteLength,
                content_sha256: contentSha256(editedBytes),
            })
            .select("id")
            .single();
        if (verErr || !versionRow) {
            return { ok: false, error: "Failed to record document version." };
        }
        versionRowId = versionRow.id as string;
    }

    // Insert one row per change
    const editRows = changes.map((c) => ({
        document_id: documentId,
        version_id: versionRowId,
        change_id: c.id,
        del_w_id: c.delId ?? null,
        ins_w_id: c.insId ?? null,
        deleted_text: c.deletedText,
        inserted_text: c.insertedText,
        context_before: c.contextBefore ?? "",
        context_after: c.contextAfter ?? "",
        status: "pending" as const,
    }));
    const { data: insertedEdits, error: editsErr } = await db
        .from("document_edits")
        .insert(editRows)
        .select("id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after");

    if (editsErr || !insertedEdits) {
        return { ok: false, error: "Failed to record edits." };
    }

    await db
        .from("documents")
        .update({ current_version_id: versionRowId })
        .eq("id", documentId);

    const annotations: EditAnnotation[] = insertedEdits.map((r: { id: string; change_id: string; deleted_text: string; inserted_text: string; context_before: string | null; context_after: string | null }) => {
        const src = changes.find((c) => c.id === r.change_id);
        return {
            kind: "edit",
            edit_id: r.id,
            document_id: documentId,
            version_id: versionRowId,
            version_number: nextVersionNumber,
            change_id: r.change_id,
            del_w_id: src?.delId,
            ins_w_id: src?.insId,
            deleted_text: r.deleted_text ?? "",
            inserted_text: r.inserted_text ?? "",
            context_before: r.context_before ?? "",
            context_after: r.context_after ?? "",
            reason: src?.reason,
            status: "pending",
        };
    });

    // Persistent, non-expiring permalink. The backend streams fresh bytes
    // on each request, so this URL stays valid as long as the file exists.
    const permalink = buildDownloadUrl(newPath, doc.filename as string);

    return {
        ok: true,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        storage_path: newPath,
        download_url: permalink,
        annotations,
        errors,
    };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

/**
 * PII Shield context threaded through `readDocumentContent` and
 * `runToolCalls`. When provided AND `mode != "off"` AND the sidecar
 * is configured, every extracted document text is funnelled through
 * the analyzer before it reaches the LLM. The (chat_id, mode, lang)
 * tuple is enough to resolve / create the right `pii_sessions` row
 * idempotently. See backend/src/lib/pii/* for the wire helpers.
 */
export interface PiiToolContext {
    userId: string;
    chatId: string;
    mode: import("./pii").EffectiveMode;
    language: "hr" | "en";
}

async function readDocumentContent(
    docLabel: string,
    docStore: DocStore,
    write: (s: string) => void,
    docIndex?: DocIndex,
    db?: ReturnType<typeof createServerSupabase>,
    opts?: {
        emitEvents?: boolean;
        geminiApiKey?: string | null;
        pii?: PiiToolContext | null;
    },
): Promise<string> {
    const emitEvents = opts?.emitEvents ?? true;
    console.log(`[read_document] called with docLabel="${docLabel}"`);
    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        console.log(
            `[read_document] MISS — docLabel "${docLabel}" not in docStore. Known labels:`,
            Array.from(docStore.keys()),
        );
        return "Document not found.";
    }
    console.log(
        `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
    );

    const documentId = docIndex?.[docLabel]?.document_id;
    const documentVersionId = docIndex?.[docLabel]?.version_id ?? null;
    const emitDocRead = () => {
        if (!emitEvents) return;
        write(
            `data: ${JSON.stringify({
                type: "doc_read",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    };
    if (emitEvents)
        write(
            `data: ${JSON.stringify({
                type: "doc_read_start",
                filename: docInfo.filename,
                document_id: documentId,
            })}\n\n`,
        );
    try {
        // Prefer the current tracked-changes version (if any) so read_document
        // reflects accepted/pending edits rather than the original upload.
        let raw: ArrayBuffer | null = null;
        let sourcePath = docInfo.storage_path;
        if (documentId && db) {
            const current = await loadCurrentVersionBytes(documentId, db);
            if (current) {
                raw = current.bytes.buffer.slice(
                    current.bytes.byteOffset,
                    current.bytes.byteOffset + current.bytes.byteLength,
                ) as ArrayBuffer;
                sourcePath = current.storage_path;
                console.log(
                    `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
                );
            } else {
                console.log(
                    `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
                );
            }
        }
        if (!raw) {
            raw = await downloadFile(docInfo.storage_path);
            if (raw) {
                console.log(
                    `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
                );
            }
        }
        if (!raw) {
            console.log(
                `[read_document] FAILED to download any bytes for docLabel="${docLabel}" (tried path="${sourcePath}")`,
            );
            emitDocRead();
            return "Document could not be read.";
        }
        // Log the first 8 bytes so we can identify real file format regardless
        // of the declared file_type. Valid .docx starts with "PK\x03\x04"
        // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
        // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
        {
            const head = Buffer.from(raw).subarray(0, 8);
            const hex = head.toString("hex");
            const ascii = head
                .toString("binary")
                .replace(/[^\x20-\x7e]/g, ".");
            console.log(
                `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
            );
        }
        let text = await extractDocumentText({
            fileType: docInfo.file_type,
            bytes: raw,
            flavor: "plain",
            geminiApiKey: opts?.geminiApiKey ?? null,
            storagePath: sourcePath,
        });
        // Length only — never document content: this line lands in Cloud
        // Logging before any PII anonymization has run.
        console.log(
            `[read_document] DONE filename="${docInfo.filename}" file_type="${docInfo.file_type}" finalTextLength=${text.length}`,
        );

        // -------- PII Shield interception (plan §1.1) -------------------
        // When the chat is in an active PII mode, intercept the extracted
        // text before it leaves this function. The sidecar persists the
        // mapping in `pii_mappings`; we discard the session id locally
        // because the next /chat turn will re-resolve it from chat_id.
        text = await maybeAnonymize({
            text,
            documentId,
            documentVersionId,
            filename: docInfo.filename,
            pii: opts?.pii ?? null,
        });

        emitDocRead();
        return text;
    } catch (err) {
        console.log(
            `[read_document] THREW for docLabel="${docLabel}" filename="${docInfo.filename}":`,
            err,
        );
        if (emitEvents)
            write(`data: ${JSON.stringify({ type: "doc_read", filename: docInfo.filename })}\n\n`);
        return "Document could not be read.";
    }
}

// Returned by maybeAnonymize when the PII sidecar is down AND the chat is
// in a fail-closed mode (strict / strict_legal — see pii/gate failsClosed).
// It is NOT readable document text — callers
// that gate on "did the read succeed?" must treat it the same as the
// "Document could not be read." sentinel, otherwise find_in_document would
// search the sentinel string and the read cache would store it.
const PII_WITHHELD_STRICT =
    "[PII_SHIELD_UNAVAILABLE — document withheld in strict mode]";

/**
 * Thrown by `runLLMStream` when the PII sidecar is unreachable while the
 * chat is in a fail-closed mode (strict / strict_legal) and a user-typed
 * turn would otherwise reach the provider raw (#45). Route handlers
 * translate it into a `{ type: "error", code: "PII_SHIELD_UNAVAILABLE" }`
 * SSE event so the frontend shows the dedicated localized banner instead
 * of the generic stream-error one.
 */
export class PiiShieldUnavailableError extends Error {
    readonly code = "PII_SHIELD_UNAVAILABLE";
    constructor() {
        super("PII Shield unavailable — turn aborted (fail-closed mode)");
        this.name = "PiiShieldUnavailableError";
    }
}

/**
 * What read_document hands the model: the whole text when it fits the
 * turn's budget, otherwise the requested part (default 1) framed with how
 * many parts exist and how to continue. Sentinels pass through untouched.
 */
export function documentPartForModel(
    text: string,
    docLabel: string,
    requestedPart: unknown,
    budget: number,
): string {
    if (isUnreadableDocText(text) || text.length <= budget) return text;
    const parts = splitTextIntoParts(text, budget);
    const asked = Math.floor(Number(requestedPart));
    const part = Number.isFinite(asked)
        ? Math.min(Math.max(asked, 1), parts.length)
        : 1;
    return formatDocumentPart({
        docLabel,
        parts,
        part,
        totalChars: text.length,
    });
}

/** Tool result when placeholders could not be restored — nothing was written. */
const PII_RESTORE_FAILED =
    "ERROR: the anonymized values in this request could not be restored (PII Shield unavailable), so the document was NOT written. Tell the user to try again shortly.";

/**
 * Restore PII placeholders in the arguments of a tool that writes into the
 * user's files (generate_docx, edit_document). Identity map outside an
 * active PII mode or when the arguments hold no placeholders; null when
 * they do and the shield cannot resolve them — the caller must not write.
 */
async function restoreDocToolPii(
    args: unknown,
    pii: PiiToolContext | null | undefined,
): Promise<PlaceholderMap | null> {
    if (!pii || pii.mode === "off") return EMPTY_PLACEHOLDER_MAP;
    const piiMod = await import("./pii");
    const map = await restorePlaceholders(args, pii.chatId, {
        getSessionId: piiMod.getChatSessionId,
        deanonymizeJson: (sessionId, data) =>
            piiMod.piiClient.deanonymizeJson(sessionId, data),
    });
    if (!map) {
        console.warn(
            `[pii] could not restore placeholders for a document tool (chat=${pii.chatId}) — refusing to write`,
        );
    }
    return map;
}

/** True when `text` is one of our non-content sentinels (read failed or PII-withheld). */
function isUnreadableDocText(text: string | null | undefined): boolean {
    return (
        !text ||
        text === "Document could not be read." ||
        text === "Document not found." ||
        text === PII_WITHHELD_STRICT
    );
}

async function maybeAnonymize(args: {
    text: string;
    documentId: string | undefined;
    /**
     * The document_versions.id for the version being read (from
     * `docIndex[label].version_id`). This is the correct key for the
     * sidecar's per-version analysis cache and the `document_version_id`
     * passed to `anonymize` — NOT the documents.id in `documentId`.
     */
    documentVersionId: string | null;
    filename: string;
    pii: PiiToolContext | null;
}): Promise<string> {
    if (!args.pii || args.pii.mode === "off") return args.text;
    if (!args.text || args.text === "Document could not be read.") return args.text;

    const {
        piiActive,
        failsClosed,
        piiClient,
        getChatSessionId,
        getDocumentAnalysisCache,
    } = await import("./pii");

    if (!piiActive(args.pii.mode)) return args.text;

    // Cache-hit: when the chat already has a session + the doc has an
    // analysis row, the sidecar's processed_text_cache is the source
    // of truth and we don't even need to re-encode.
    try {
        const sessionId = await getChatSessionId(args.pii.chatId);
        if (sessionId && args.documentVersionId) {
            const cache = await getDocumentAnalysisCache(sessionId, args.documentVersionId);
            if (cache && cache.processedText) {
                console.log(
                    `[read_document][pii] cache hit filename="${args.filename}" session=${sessionId}`,
                );
                return cache.processedText;
            }
        }
    } catch (err) {
        console.warn(
            "[read_document][pii] cache lookup failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }

    const result = await piiClient.anonymize({
        text: args.text,
        userId: args.pii.userId,
        mode: args.pii.mode,
        language: args.pii.language,
        chatId: args.pii.chatId,
        documentVersionId: args.documentVersionId,
        source: "document",
    });
    if (!result.ok) {
        // Fail open in standard, fail closed in strict AND strict_legal —
        // both promise the user their data never reaches the model raw
        // (#48). The chat handler is responsible for translating an
        // empty/redacted text into a user-facing message; here we just
        // emit the original text in standard mode (the user opted out of
        // strict guarantees).
        console.warn(
            `[read_document][pii] /anonymize failed for filename="${args.filename}":`,
            result.error,
        );
        if (failsClosed(args.pii.mode)) {
            return PII_WITHHELD_STRICT;
        }
        console.warn(
            "[pii] fail-open: standard mode — document text forwarded to the LLM unanonymized (sidecar unavailable)",
        );
        return args.text;
    }
    console.log(
        `[read_document][pii] anonymized filename="${args.filename}" entities=${result.data.entities.length} session=${result.data.session_id}`,
    );
    return result.data.anonymized_text;
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by `findInDocumentContent` so matches
 * are tolerant of case + whitespace variance but can still return the
 * exact original excerpt.
 */
function normalizeWithMap(text: string): { norm: string; origIdx: number[] } {
    // `preNormalize` maps smart quotes/dashes, NBSP and ZWSP to their plain
    // ASCII equivalents — the SAME canonicalization the edit matcher
    // (`applyTrackedEdits` → `normalizeWs`) applies. Without it, search found
    // text the model then copied verbatim into `edit_document`'s `find`, but
    // the edit locator (which DOES run preNormalize) saw a different char
    // form → "Uređivanje nije uspjelo" even though the find succeeded. Legal
    // .docx pasted from Word is full of these chars. preNormalize is 1:1
    // length-preserving, so the origIdx mapping below stays exact.
    const s = preNormalize(text);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch.toLowerCase());
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
    return preNormalize(q).trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Ctrl+F helper. Returns a JSON-serializable result with up to `maxResults`
 * hits, each containing the original-text excerpt plus surrounding context.
 */
async function findInDocumentContent(params: {
    docLabel: string;
    query: string;
    maxResults?: number;
    contextChars?: number;
    docStore: DocStore;
    write: (s: string) => void;
    docIndex?: DocIndex;
    db?: ReturnType<typeof createServerSupabase>;
    geminiApiKey?: string | null;
    pii?: PiiToolContext | null;
}): Promise<string> {
    const {
        docLabel,
        query,
        maxResults = 20,
        contextChars = 80,
        docStore,
        write,
        docIndex,
        db,
        geminiApiKey,
        pii,
    } = params;

    if (!query || !query.trim()) {
        return JSON.stringify({ ok: false, error: "Empty query." });
    }

    const docInfo = docStore.get(docLabel);
    if (!docInfo) {
        return JSON.stringify({
            ok: false,
            error: `Document '${docLabel}' not found.`,
        });
    }

    // Announce the search to the UI, then reuse readDocumentContent for its
    // fallbacks — but suppress its own doc_read events so the user only sees
    // the doc_find block (not a competing doc_read block for the same op).
    write(
        `data: ${JSON.stringify({
            type: "doc_find_start",
            filename: docInfo.filename,
            query,
        })}\n\n`,
    );

    const text = await readDocumentContent(
        docLabel,
        docStore,
        write,
        docIndex,
        db,
        { emitEvents: false, geminiApiKey, pii: pii ?? null },
    );
    if (isUnreadableDocText(text)) {
        write(
            `data: ${JSON.stringify({
                type: "doc_find",
                filename: docInfo.filename,
                query,
                total_matches: 0,
            })}\n\n`,
        );
        // Distinguish a genuine read failure from a strict-mode PII withhold
        // so the model doesn't conclude "0 matches → text absent" when the
        // document was deliberately blocked.
        return JSON.stringify({
            ok: false,
            filename: docInfo.filename,
            error:
                text === PII_WITHHELD_STRICT
                    ? "Document withheld (PII Shield strict mode, sidecar unavailable)."
                    : "Document could not be read.",
        });
    }

    const { norm, origIdx } = normalizeWithMap(text);
    const needle = normalizeQuery(query);
    if (!needle) {
        return JSON.stringify({ ok: false, error: "Empty query after normalization." });
    }

    type Hit = {
        index: number;
        excerpt: string;
        context: string;
    };
    const hits: Hit[] = [];
    let from = 0;
    while (from <= norm.length - needle.length && hits.length < maxResults) {
        const pos = norm.indexOf(needle, from);
        if (pos < 0) break;
        const endNormPos = pos + needle.length;
        const origStart = origIdx[pos] ?? 0;
        const origEnd =
            endNormPos - 1 < origIdx.length
                ? origIdx[endNormPos - 1] + 1
                : text.length;
        const ctxStart = Math.max(0, origStart - contextChars);
        const ctxEnd = Math.min(text.length, origEnd + contextChars);
        hits.push({
            index: hits.length,
            excerpt: text.slice(origStart, origEnd),
            context:
                (ctxStart > 0 ? "…" : "") +
                text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
                (ctxEnd < text.length ? "…" : ""),
        });
        from = pos + Math.max(1, needle.length);
    }

    // Count total occurrences beyond the cap so the model knows whether to narrow the query.
    let totalMatches = hits.length;
    if (hits.length >= maxResults) {
        let probe = from;
        while (probe <= norm.length - needle.length) {
            const pos = norm.indexOf(needle, probe);
            if (pos < 0) break;
            totalMatches++;
            probe = pos + Math.max(1, needle.length);
        }
    }

    write(
        `data: ${JSON.stringify({
            type: "doc_find",
            filename: docInfo.filename,
            query,
            total_matches: totalMatches,
        })}\n\n`,
    );

    return JSON.stringify({
        ok: true,
        filename: docInfo.filename,
        query,
        total_matches: totalMatches,
        returned: hits.length,
        truncated: totalMatches > hits.length,
        hits,
    });
}

export type DocEditedResult = {
    filename: string;
    document_id: string;
    version_id: string;
    version_number: number | null;
    download_url: string;
    annotations: EditAnnotation[];
};

export type TurnEditState = Map<
    string,
    { versionId: string; versionNumber: number; storagePath: string }
>;

export type DocCreatedResult = {
    filename: string;
    download_url: string;
    document_id?: string;
    version_id?: string;
    version_number?: number | null;
};

export type DocReplicatedResult = {
    /** Filename of the source document being copied. */
    filename: string;
    /** How many copies were produced in this single tool call. */
    count: number;
    /** One entry per new copy. */
    copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }[];
};

/**
 * One MCP tool call worth of observability — surfaced to the chat UI so the
 * user can see what was sent and what came back. `args` and `output` are
 * already capped in size before this event is emitted/persisted.
 */
export type McpToolResultEvent = {
    type: "mcp_tool_result";
    server: string;
    tool: string;
    ok: boolean;
    args: string;
    output: string;
};

// ---------------------------------------------------------------------------
// Legal sources (EU / HR / FR) harvested from MCP tool results
// ---------------------------------------------------------------------------

/**
 * Unified citation shape for the three legal MCP servers. HR/FR tools return
 * `sources: EulexSource[]`; EU tools return `SearchResult[]` / `ArticleContent`
 * with no stable id (so we mint one). The frontend renders these as clickable
 * pills + a right-side document panel — see `LegalSourcePanel`.
 */
export interface LegalSource {
    /** Stable id a citation references. HR/FR/SI/DE: the source's own `id`.
     *  EU: synthesized "@eu/celex/{celex}#{article}". */
    id: string;
    scope: "@eu" | "@hr" | "@fr" | "@si" | "@de";
    title: string;
    citation?: string | null;
    /** Cited passage / segment text harvested from the tool output (best
     *  effort — falls back to the LLM quote in the panel when absent). */
    snippet?: string | null;
    /** Public canonical URL: eur-lex / narodne-novine / legifrance /
     *  pisrs.si / gesetze-im-internet.de. */
    externalUrl?: string | null;
    articleLabel?: string | null;
    /** In-app fetch path for the full document (Phase 2 proxy). */
    fetchPath?: string | null;
    /** EU only — drives the /documents/{celex} proxy. */
    celex?: string | null;
    inForce?: boolean | null;
    /** Source class: statute/regulation (default) vs court decision. */
    kind?: "regulation" | "caselaw";
    /** Caselaw only — the court's case number ("Revr 123/2019"). */
    caseNumber?: string | null;
    /** Caselaw only — ECLI identifier parsed from the citation. */
    ecli?: string | null;
}

/**
 * One per-turn legal-source registry event. Mirrors `WebSearchEvent`: a
 * structured payload streamed to the client and persisted in
 * `chat_messages.content`, separate from the `mcp_tool_result` activity dot.
 */
export type LegalSourcesEvent = {
    type: "legal_sources";
    sources: LegalSource[];
};

function lsObj(v: unknown): Record<string, unknown> | null {
    return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
}
function lsStr(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Scan every array property of a tool payload for `{segment_id|id, text|
 * content}` rows so HR/FR sources (which carry only a `segment_id`) can be
 * paired with their passage text for in-panel highlighting.
 */
function lsBuildSegmentText(payload: Record<string, unknown>): Map<string, string> {
    const map = new Map<string, string>();
    for (const val of Object.values(payload)) {
        if (!Array.isArray(val)) continue;
        for (const item of val) {
            const o = lsObj(item);
            if (!o) continue;
            const sid = lsStr(o.segment_id) ?? lsStr(o.id);
            const txt = lsStr(o.text) ?? lsStr(o.content) ?? lsStr(o.snippet);
            if (sid && txt) map.set(sid, txt);
        }
    }
    return map;
}

/** European Case Law Identifier embedded in a decision citation/title. */
const LS_ECLI_RE = /ECLI:[A-Z]{2}:[A-Z0-9]+:\d{4}:[A-Z0-9.]+/;

/** National-scope `EulexSource` → `LegalSource`. Scope comes from the source
 *  itself; all eulex_endpoint MCPs (HR/FR/SI/DE) emit this same shape, with a
 *  per-country external link key (legifrance / pisrs / gii). */
const LS_EULEX_SCOPES = ["@hr", "@fr", "@si", "@de"] as const;
function lsFromEulex(
    raw: Record<string, unknown>,
    segText: Map<string, string>,
): LegalSource | null {
    const id = lsStr(raw.id);
    const scope = lsStr(raw.scope);
    if (!id || !(LS_EULEX_SCOPES as readonly string[]).includes(scope ?? "")) {
        return null;
    }
    const doc = lsObj(raw.document) ?? {};
    const article = lsObj(raw.article) ?? {};
    const match = lsObj(raw.match) ?? {};
    const links = lsObj(raw.links) ?? {};
    const segId = lsStr(match.segment_id) ?? lsStr(article.segment_id);
    // Court decisions (sudska praksa) arrive in the same EulexSource shape as
    // laws but carry no articles — tag them so the frontend can auto-link
    // case-number references and label the source correctly.
    const isCaselaw =
        lsStr(doc.type) === "court_decision" || id.includes("/decision/");
    const ecli = isCaselaw
        ? ((lsStr(doc.citation) ?? "").match(LS_ECLI_RE)?.[0] ??
          (lsStr(raw.title) ?? "").match(LS_ECLI_RE)?.[0] ??
          null)
        : null;
    return {
        id,
        scope: scope as (typeof LS_EULEX_SCOPES)[number],
        title: lsStr(raw.title) ?? lsStr(doc.title) ?? id,
        citation: lsStr(doc.citation),
        snippet: segId ? (segText.get(segId) ?? null) : null,
        externalUrl:
            lsStr(raw.external_url) ??
            lsStr(links.legifrance) ??
            lsStr(links.pisrs) ??
            lsStr(links.gii),
        articleLabel: lsStr(article.label) ?? lsStr(doc.article_number),
        fetchPath: lsStr(links.backend_fetch),
        celex: null,
        inForce: typeof raw.in_force === "boolean" ? raw.in_force : null,
        kind: isCaselaw ? "caselaw" : "regulation",
        // For decisions, `document.title` is the decision_number.
        caseNumber: isCaselaw ? lsStr(doc.title) : null,
        ecli,
    };
}

/** EU `SearchResult` / `ArticleContent` (has `celex_id`) → `LegalSource`. */
function lsFromEu(raw: Record<string, unknown>): LegalSource | null {
    const celex = lsStr(raw.celex_id);
    if (!celex) return null;
    const article =
        lsStr(raw.article) ?? lsStr(raw.article_number) ?? lsStr(raw.section_name);
    return {
        id: `@eu/celex/${celex}${article ? `#${article}` : ""}`,
        scope: "@eu",
        title: lsStr(raw.title) ?? celex,
        citation: lsStr(raw.eulex_citation),
        snippet: lsStr(raw.text),
        externalUrl:
            lsStr(raw.source_url) ??
            `https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:${celex}`,
        articleLabel: article,
        fetchPath: `/api/v1/documents/${celex}`,
        celex,
        inForce: typeof raw.in_force === "boolean" ? raw.in_force : null,
        kind: "regulation",
    };
}

/**
 * Pull typed legal sources out of one MCP tool result. Prefers the SDK's
 * `structuredContent` (no truncation/regex); falls back to JSON-parsing the
 * untruncated text. Never throws — many tools return prose, not JSON.
 *
 * MUST be called on the UNtruncated tool output, before `truncateForPreview`:
 * a 10-result `search` easily exceeds the 4 KB preview cap, which would drop
 * the tail sources mid-JSON.
 */
export function harvestLegalSources(payload: {
    text: string;
    structured?: unknown;
}): LegalSource[] {
    let root: unknown = payload.structured;
    if (root === undefined || root === null) {
        try {
            root = JSON.parse(payload.text);
        } catch {
            return [];
        }
    }
    const out: LegalSource[] = [];
    try {
        const obj = lsObj(root);
        if (!obj) return out;
        if (Array.isArray(obj.sources)) {
            const segText = lsBuildSegmentText(obj);
            for (const s of obj.sources) {
                const o = lsObj(s);
                const ls = o ? lsFromEulex(o, segText) : null;
                if (ls) out.push(ls);
            }
        }
        if (Array.isArray(obj.results)) {
            for (const r of obj.results) {
                const o = lsObj(r);
                const ls = o ? lsFromEu(o) : null;
                if (ls) out.push(ls);
            }
        }
        if (lsStr(obj.celex_id)) {
            const ls = lsFromEu(obj);
            if (ls) out.push(ls);
        }
    } catch {
        /* defensive — return whatever we parsed */
    }
    return out;
}

/** First legal source in `events` whose id matches `sourceId`, with fuzzy
 *  fallbacks so an EU citation written as a bare CELEX still resolves to the
 *  minted "@eu/celex/…" id. Returns null when nothing matches (fail-soft). */
export function resolveLegalSource(
    sourceId: string,
    events?: ({ type?: string } & Record<string, unknown>)[],
): LegalSource | null {
    if (!sourceId || !Array.isArray(events)) return null;
    const registry: LegalSource[] = [];
    for (const ev of events) {
        if (ev?.type === "legal_sources" && Array.isArray(ev.sources)) {
            registry.push(...(ev.sources as LegalSource[]));
        }
    }
    if (registry.length === 0) return null;
    // 1. Exact id.
    const exact = registry.find((s) => s.id === sourceId);
    if (exact) return exact;
    // 2. EU CELEX inclusion (model often cites the bare CELEX it can see).
    const byCelex = registry.find(
        (s) => s.celex && sourceId.includes(s.celex),
    );
    if (byCelex) return byCelex;
    // 3. Alphanumeric-normalized compare (punctuation/case drift).
    const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const target = norm(sourceId);
    return registry.find((s) => norm(s.id) === target) ?? null;
}

/**
 * Result of one `web_search` tool call — surfaced to the UI so the
 * client can render a "Sources" panel with clickable links per turn,
 * separate from the MCP grounding panel. `snippet` is the per-result
 * `content` field already capped at 500 chars by the providers.
 */
/**
 * Public web-search event emitted to clients and persisted into
 * chat_messages.content. We deliberately type `provider` as the literal
 * "eulex" rather than the upstream SearchProvider union: the actual
 * upstream identity (Tavily / Exa / Parallel / You) is a server-side
 * detail that must never leak into the UI. Billing keeps the real
 * provider name inside lib/searchPricing.ts at the call site.
 */
export type WebSearchEvent = {
    type: "web_search_result";
    provider: "eulex";
    /**
     * Which role-based search tool produced this — lets the UI label the
     * block (official / web / news) without ever learning the upstream
     * provider vendor (still masked as "eulex" above).
     */
    kind: SearchKind;
    query: string;
    results: {
        title: string;
        url: string;
        snippet: string;
        published_date: string | null;
    }[];
    error: string | null;
};

/**
 * Public `read_url` event — emitted to clients and persisted into
 * chat_messages.content so the read shows up in history like a search.
 * Carries only a short snippet of the extracted text; the full body went
 * to the model as a tool result, not to the wire.
 */
export type WebExtractEvent = {
    type: "web_extract_result";
    url: string;
    title: string | null;
    /** Short preview of the extracted text (≤500 chars) or the error. */
    snippet: string;
    /** Heuristic flag so the UI can badge PDFs. */
    is_pdf: boolean;
    /** true → the whole document was read; false → a focused preview. */
    full: boolean;
    error: string | null;
};

/**
 * Cap previewed args/output to keep `chat_messages.content` from bloating.
 * The model still receives the full untruncated tool output — this only
 * affects what is shown to and persisted for the user.
 */
const MCP_PREVIEW_MAX = 4096;

function truncateForPreview(s: string): string {
    if (s.length <= MCP_PREVIEW_MAX) return s;
    return s.slice(0, MCP_PREVIEW_MAX) + "\n…(truncated)";
}

export async function runToolCalls(
    toolCalls: ToolCall[],
    docStore: DocStore,
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
    write: (s: string) => void,
    workflowStore?: WorkflowStore,
    tabularStore?: TabularCellStore,
    docIndex?: DocIndex,
    turnEditState?: TurnEditState,
    projectId?: string | null,
    mcpServers?: LoadedMcpServer[],
    /**
     * Optional Word add-in context — attached only to the wire form of
     * `doc_edited` events (see below). Persisted assistant content
     * stays client-agnostic so chat history shared with web users
     * doesn't leak Word-specific fields.
     */
    client?: "web" | "word",
    editMode?: "track" | "comments",
    /**
     * User-resolved API keys (already merged with env fallbacks). Only the
     * Gemini key is consumed today — by `read_document` / `fetch_documents`
     * to drive Gemini-based PDF OCR via `extractPdfWithGemini`. When
     * undefined we still work, falling back to `process.env.GEMINI_API_KEY`
     * inside the OCR helper.
     */
    apiKeys?: import("./llm").UserApiKeys,
    /**
     * PII Shield context — when set AND mode != "off", document tools
     * route through the sidecar and MCP tools are gated by
     * `toolPolicy.ts` (deanonymize | passthrough | block).
     */
    piiContext?: PiiToolContext | null,
    /**
     * Opaque scope allowlist from the active contexts' resolve responses
     * (seams/scopeEnforcement). When non-empty, MCP tool calls get (a) a
     * pre-call arg check refusing out-of-scope single-document fetches,
     * (b) L2 redaction stripping out-of-scope legal material from results
     * before the model / harvest / UI, and (c) an env-gated L1 scope
     * param. Empty/undefined → no-op.
     */
    scopeWhitelist?: Set<string>,
    /**
     * Turn-scoped document-text sink (tracker #22). When provided it is used
     * AS the within-batch read cache, so it accumulates the extracted text of
     * every document the model actually read this turn — the exact text
     * (PII-anonymized when active) that citation quotes are verified against
     * in `mapCitationsToAnnotations`. Undefined → per-batch cache as before.
     */
    docTextSink?: Map<string, string>,
    /**
     * The model this turn runs on. Sizes what one read_document /
     * fetch_documents result may return (lib/documentText
     * `chatReadCharBudget`); longer documents are served in parts.
     */
    model?: string,
): Promise<{
    toolResults: unknown[];
    docsRead: { filename: string; document_id?: string }[];
    docsFound: { filename: string; query: string; total_matches: number }[];
    docsCreated: DocCreatedResult[];
    docsReplicated: DocReplicatedResult[];
    workflowsApplied: { workflow_id: string; title: string }[];
    docsEdited: DocEditedResult[];
    mcpResults: McpToolResultEvent[];
    /** Typed legal sources (EU/HR/FR) harvested from MCP results this batch. */
    legalSources: LegalSource[];
    webSearches: WebSearchEvent[];
    webExtracts: WebExtractEvent[];
    /**
     * Accumulated USD cost of every external web-tool call in this batch —
     * web_search (lib/searchPricing) AND read_url URL/PDF extraction
     * (lib/extract). Folded into the LLM turn's `cost_usd` by the chat
     * handler as a single external-tool charge.
     */
    webSearchCostUsd: number;
}> {
    const toolResults: unknown[] = [];
    const docsRead: { filename: string; document_id?: string }[] = [];
    const docsFound: {
        filename: string;
        query: string;
        total_matches: number;
    }[] = [];
    const docsCreated: DocCreatedResult[] = [];
    const docsReplicated: DocReplicatedResult[] = [];
    const workflowsApplied: { workflow_id: string; title: string }[] = [];
    const docsEdited: DocEditedResult[] = [];
    const mcpResults: McpToolResultEvent[] = [];
    // Typed legal sources harvested across every MCP call this batch, deduped
    // by stable id (the same article is often cited from multiple tools).
    const legalSources: LegalSource[] = [];
    const legalSourceIds = new Set<string>();
    const webSearches: WebSearchEvent[] = [];
    const webExtracts: WebExtractEvent[] = [];
    // Per-batch running total — bumped inside the web_search branch with
    // the upstream provider's real per-call cost. We persist this to
    // llm_usage so adminmax sees the right number, even though the
    // public WebSearchEvent has the provider name stripped.
    let webSearchCostUsd = 0;

    // Per-project search configuration is declarative — sourced from
    // backend/src/lib/search/search_config.json (resolveProjectSearchConfig).
    // Computed once per runToolCalls invocation since the model may emit
    // several web_search calls in the same tool batch.
    const projectSearchConfig = resolveProjectSearchConfig(
        projectId ?? null,
    );

    // Within-turn document text cache.
    // Keyed by the resolved doc label (e.g. "doc-0"). Populated on the first
    // read_document call for a given label; cleared when edit_document mutates
    // that label's storage path so a follow-up read sees the updated bytes.
    // When the caller passes `docTextSink` it doubles as the cache, so the
    // text survives across tool batches for citation verification.
    const docTextCache = docTextSink ?? new Map<string, string>();
    const readBudget = chatReadCharBudget(model);

    for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
            args = JSON.parse(tc.function.arguments || "{}");
        } catch (parseErr) {
            console.error(`[runToolCalls] JSON.parse FAILED for tool="${tc.function.name}" id="${tc.id}": ${parseErr}`);
            console.error(`[runToolCalls] raw arguments (first 1000 chars): ${String(tc.function.arguments).slice(0, 1000)}`);
        }

        if (tc.function.name.startsWith("mcp__") && mcpServers?.length) {
            const match = findMcpServerForTool(tc.function.name, mcpServers);
            if (!match) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: `MCP tool '${tc.function.name}' not available (server may have been removed mid-request).`,
                });
                continue;
            }
            const { server, originalName } = match;

            // -------- PII tool gate (plan §1.1 — toolPolicy) ----------
            // Determine the policy BEFORE the call. In strict mode a
            // "block" policy short-circuits with a tool-result that
            // tells the LLM the tool was refused, so it can re-plan
            // without the PII leak.
            let argsForTool: Record<string, unknown> = args;
            if (piiContext && piiContext.mode !== "off") {
                const piiMod = await import("./pii");
                const policy = piiMod.getMcpServerPolicy(server.row.slug);
                if (piiContext.mode === "strict" && policy === "block") {
                    const refusal = `MCP tool '${originalName}' is blocked by your PII Shield strict-mode policy (server '${server.row.name}'). Re-ask without sensitive data or switch to standard mode.`;
                    write(
                        `data: ${JSON.stringify({
                            type: "mcp_tool_result",
                            server: server.row.name,
                            tool: originalName,
                            ok: false,
                            args: truncateForPreview(JSON.stringify(args)),
                            output: truncateForPreview(refusal),
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: refusal,
                    });
                    continue;
                }
                if (policy === "deanonymize") {
                    // Internal tool — restore PII in args before call.
                    const sessionId = await (
                        await import("./pii")
                    ).getChatSessionId(piiContext.chatId);
                    if (sessionId) {
                        const restored =
                            await piiMod.piiClient.deanonymizeJson(sessionId, args);
                        if (restored.ok && restored.data && typeof restored.data === "object") {
                            argsForTool = restored.data as Record<string, unknown>;
                        }
                    }
                }
                // "passthrough": leave placeholders in args (external
                // tool sees masked PII — exactly what we want).
            }

            // Custom Contexts: the pre-call arg check and the L1 scope
            // param apply to LEGAL research servers only — Drive/Notion
            // connectors legitimately pass UUID-shaped document ids that
            // have nothing to do with the provider's identifier space. L2
            // redaction below still runs for every server (the harvester's
            // shapes are legal-specific, so it is a no-op for non-legal
            // payloads — belt and braces).
            const legalServer = isLegalMcpServer(server.row);
            const precheck = legalServer
                ? precheckToolArgs(
                      argsForTool,
                      scopeWhitelist ?? new Set<string>(),
                  )
                : { ok: true as const };
            if (!precheck.ok) {
                const refusal =
                    `[Refused: ${precheck.refusedId} is outside the active context. ` +
                    "Tell the user this document is out of scope and offer to search outside the context.]";
                write(
                    `data: ${JSON.stringify({
                        type: "mcp_tool_call",
                        server: server.row.name,
                        tool: originalName,
                    })}\n\n`,
                );
                const refusalPreview: McpToolResultEvent = {
                    type: "mcp_tool_result",
                    server: server.row.name,
                    tool: originalName,
                    ok: false,
                    args: truncateForPreview(JSON.stringify(args)),
                    output: truncateForPreview(refusal),
                };
                write(`data: ${JSON.stringify(refusalPreview)}\n\n`);
                // Persist the refused-call chip like the success path does —
                // the chat handler's `for (const r of mcpResults)` loop is
                // what survives a reload.
                mcpResults.push(refusalPreview);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: refusal,
                });
                continue;
            }

            // Custom Contexts L1 (opportunistic): pass the scope whitelist to
            // the server as a hard pre-filter param. EULEX_SCOPE_PARAM holds
            // the param name once eulex confirms it (dependency E1); unset in
            // prod until then. A lenient server ignoring it is harmless — L2
            // redaction stays the guarantee (R7). Legal servers only.
            const scopeParamName = process.env.EULEX_SCOPE_PARAM?.trim() || undefined;
            if (legalServer) {
                argsForTool = injectScopeParam(
                    argsForTool,
                    scopeWhitelist ?? new Set<string>(),
                    scopeParamName,
                );
            }

            write(
                `data: ${JSON.stringify({
                    type: "mcp_tool_call",
                    server: server.row.name,
                    tool: originalName,
                })}\n\n`,
            );
            const { text: content, structured } =
                await server.client.callToolRich(originalName, argsForTool);
            // Custom Contexts L2: strip out-of-scope legal material from the
            // result BEFORE the harvest. From here on, only the redacted
            // payloads exist: the model, the harvest, and the legal_sources
            // UI event all read the same (in-scope) material. With no active
            // context the whitelist is empty and the inputs pass through
            // unchanged — behaviour identical to today.
            const redacted = redactToolResult({
                text: content,
                structured,
                whitelist: scopeWhitelist ?? new Set<string>(),
                harvest: harvestLegalSources,
            });
            const scopedContent = redacted.text;
            // Typed legal sources come straight from the redaction pass
            // (kept = in-scope harvest of the UNtruncated result, before the
            // preview cap below, so citations past 4 KB aren't lost). The
            // legal_sources UI event therefore can never carry an
            // out-of-scope id, and the payload is harvested exactly once.
            for (const ls of redacted.keptSources) {
                if (legalSourceIds.has(ls.id)) continue;
                legalSourceIds.add(ls.id);
                legalSources.push(ls);
            }
            // The model gets the untruncated content; the user-facing preview
            // is capped to keep chat_messages.content from bloating.
            const ok = !scopedContent.startsWith(`MCP tool '${originalName}' `);
            const preview: McpToolResultEvent = {
                type: "mcp_tool_result",
                server: server.row.name,
                tool: originalName,
                ok,
                args: truncateForPreview(JSON.stringify(args)),
                output: truncateForPreview(scopedContent),
            };
            write(`data: ${JSON.stringify(preview)}\n\n`);
            mcpResults.push(preview);
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: scopedContent,
            });
            continue;
        }

        if (tc.function.name === "read_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            let content: string;
            const cached = docTextCache.get(docId);
            if (cached !== undefined) {
                console.log(
                    `[read_document] within-turn cache HIT for docLabel="${docId}" (${cached.length} chars)`,
                );
                content = cached;
                // Still emit doc_read_start / doc_read events so the UI spinner
                // behaves consistently, but skip the expensive storage round-trip.
                const filename = docStore.get(docId)?.filename;
                const documentId = docIndex?.[docId]?.document_id;
                write(
                    `data: ${JSON.stringify({ type: "doc_read_start", filename, document_id: documentId })}\n\n`,
                );
                write(
                    `data: ${JSON.stringify({ type: "doc_read", filename, document_id: documentId })}\n\n`,
                );
            } else {
                content = await readDocumentContent(
                    docId,
                    docStore,
                    write,
                    docIndex,
                    db,
                    {
                        geminiApiKey: apiKeys?.gemini ?? null,
                        pii: piiContext ?? null,
                    },
                );
                // Cache only successful reads (not error strings or a
                // strict-mode PII withhold).
                if (!isUnreadableDocText(content)) {
                    docTextCache.set(docId, content);
                }
            }
            const filename = docStore.get(docId)?.filename;
            const documentId = docIndex?.[docId]?.document_id;
            if (filename) docsRead.push({ filename, document_id: documentId });
            // The cache keeps the FULL text (citation verification and
            // find_in_document need all of it); only what the model gets
            // back is sized.
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: documentPartForModel(content, docId, args.part, readBudget),
            });

        } else if (tc.function.name === "find_in_document") {
            const rawDocId = args.doc_id as string;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const query = (args.query as string) ?? "";
            const maxResults = typeof args.max_results === "number" ? args.max_results : undefined;
            const contextChars = typeof args.context_chars === "number" ? args.context_chars : undefined;
            const content = await findInDocumentContent({
                docLabel: docId,
                query,
                maxResults,
                contextChars,
                docStore,
                write,
                docIndex,
                db,
                geminiApiKey: apiKeys?.gemini ?? null,
                pii: piiContext ?? null,
            });
            const filename = docStore.get(docId)?.filename;
            if (filename) {
                let totalMatches = 0;
                try {
                    const parsed = JSON.parse(content) as {
                        total_matches?: number;
                    };
                    totalMatches = parsed.total_matches ?? 0;
                } catch {
                    /* ignore — still record the find attempt */
                }
                docsFound.push({
                    filename,
                    query,
                    total_matches: totalMatches,
                });
            }
            toolResults.push({ role: "tool", tool_call_id: tc.id, content });

        } else if (tc.function.name === "list_documents") {
            const list = Array.from(docStore.entries()).map(
                ([doc_id, info]) => ({
                    doc_id,
                    filename: info.filename,
                    file_type: info.file_type,
                }),
            );
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(list),
            });

        } else if (tc.function.name === "fetch_documents") {
            const rawDocIds = (args.doc_ids as string[]) ?? [];
            const docIds = rawDocIds.map(
                (id) => resolveDocLabel(id, docStore, docIndex) ?? id,
            );
            const parts: string[] = [];
            let returnedChars = 0;
            for (const docId of docIds) {
                let content: string;
                const cached = docTextCache.get(docId);
                if (cached !== undefined) {
                    console.log(
                        `[fetch_documents] within-turn cache HIT for docLabel="${docId}" (${cached.length} chars)`,
                    );
                    content = cached;
                    const filename = docStore.get(docId)?.filename;
                    const documentId = docIndex?.[docId]?.document_id;
                    write(
                        `data: ${JSON.stringify({ type: "doc_read_start", filename, document_id: documentId })}\n\n`,
                    );
                    write(
                        `data: ${JSON.stringify({ type: "doc_read", filename, document_id: documentId })}\n\n`,
                    );
                } else {
                    content = await readDocumentContent(
                        docId,
                        docStore,
                        write,
                        docIndex,
                        db,
                        {
                            geminiApiKey: apiKeys?.gemini ?? null,
                            pii: piiContext ?? null,
                        },
                    );
                    if (!isUnreadableDocText(content)) {
                        docTextCache.set(docId, content);
                    }
                }
                const filename = docStore.get(docId)?.filename ?? docId;
                if (
                    !isUnreadableDocText(content) &&
                    returnedChars + content.length > readBudget
                ) {
                    // Too long to return alongside the others — point the
                    // model at read_document, which serves it in parts.
                    parts.push(
                        `--- ${filename} (${docId}) ---\n[Not included: this document is ${content.length} characters long, more than this fetch_documents call can still return. Read it on its own with read_document {"doc_id": "${docId}"} — long documents are returned in parts.]`,
                    );
                } else {
                    returnedChars += content.length;
                    parts.push(`--- ${filename} (${docId}) ---\n${content}`);
                }
                if (docStore.get(docId)) {
                    const documentId = docIndex?.[docId]?.document_id;
                    docsRead.push({ filename, document_id: documentId });
                }
            }
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: parts.join("\n\n"),
            });

        } else if (tc.function.name === "list_workflows") {
            const list = workflowStore
                ? Array.from(workflowStore.entries()).map(([id, w]) => ({ id, title: w.title }))
                : [];
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(list) });

        } else if (tc.function.name === "read_workflow") {
            const wfId = args.workflow_id as string;
            const wf = workflowStore?.get(wfId);
            if (wf) {
                write(`data: ${JSON.stringify({ type: "workflow_applied", workflow_id: wfId, title: wf.title })}\n\n`);
                workflowsApplied.push({ workflow_id: wfId, title: wf.title });
            }
            // Built-in workflow packs come from the governance prompt pack;
            // without a pack the built-ins simply don't exist — say so
            // clearly instead of a bare "not found".
            const wfMissingMsg =
                !wf && wfId.startsWith("builtin-") && getPromptPack() === null
                    ? "Workflow packs are unavailable — no prompt-pack service is configured. Ask the user to pick one of their own workflows instead."
                    : `Workflow '${wfId}' not found.`;
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: wf ? wf.prompt_md : wfMissingMsg,
            });

        } else if (tc.function.name === "read_table_cells" && tabularStore) {
            const colIndices = args.col_indices as number[] | undefined;
            const rowIndices = args.row_indices as number[] | undefined;

            const filteredCols = colIndices?.length
                ? tabularStore.columns.filter((_, i) => colIndices.includes(i))
                : tabularStore.columns;
            const filteredDocs = rowIndices?.length
                ? tabularStore.documents.filter((_, i) => rowIndices.includes(i))
                : tabularStore.documents;

            const label = `${filteredCols.length} ${filteredCols.length === 1 ? "column" : "columns"} × ${filteredDocs.length} ${filteredDocs.length === 1 ? "row" : "rows"}`;
            write(`data: ${JSON.stringify({ type: "doc_read_start", filename: label })}\n\n`);

            const lines: string[] = [];
            for (const col of filteredCols) {
                const colPos = tabularStore.columns.findIndex((c) => c.index === col.index);
                for (const doc of filteredDocs) {
                    const rowPos = tabularStore.documents.findIndex((d) => d.id === doc.id);
                    const cell = tabularStore.cells.get(`${col.index}:${doc.id}`);
                    lines.push(`[COL:${colPos} "${col.name}" | ROW:${rowPos} "${doc.filename}"]`);
                    if (cell?.summary) {
                        lines.push(`Summary: ${cell.summary}`);
                        if (cell.flag) lines.push(`Flag: ${cell.flag}`);
                        if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
                    } else {
                        lines.push(`(not yet generated)`);
                    }
                    lines.push("");
                }
            }

            write(`data: ${JSON.stringify({ type: "doc_read", filename: label })}\n\n`);
            docsRead.push({ filename: label });
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: lines.join("\n") || "No cells found.",
            });

        } else if (tc.function.name === "edit_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            const editsRaw = args.edits as unknown[] | undefined;
            const docId =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const docInfo = docStore.get(docId);
            const indexed = docIndex?.[docId];

            const emitEditError = (
                filename: string,
                documentId: string,
                error: string,
            ) => {
                // Surface the failure as a failed "Edited" block in the UI
                // (start → done-with-error) so it matches the shape the
                // success/late-failure paths already use.
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename,
                    })}\n\n`,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited",
                        filename,
                        document_id: documentId,
                        version_id: "",
                        download_url: "",
                        annotations: [],
                        error,
                    })}\n\n`,
                );
            };

            if (!docInfo || !indexed) {
                const err = `Document '${docId}' not found in this chat's attachments.`;
                emitEditError(docId, indexed?.document_id ?? "", err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (
                !Array.isArray(editsRaw) ||
                editsRaw.length === 0
            ) {
                const err = "edits array is required and must not be empty.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else if (docInfo.file_type !== "docx") {
                const err = "edit_document only supports .docx files.";
                emitEditError(docInfo.filename, indexed.document_id, err);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: err }),
                });
            } else {
                write(
                    `data: ${JSON.stringify({
                        type: "doc_edited_start",
                        filename: docInfo.filename,
                    })}\n\n`,
                );
                const edits: EditInput[] = (editsRaw as Record<string, unknown>[]).map(
                    (e) => ({
                        find: String(e.find ?? ""),
                        replace: String(e.replace ?? ""),
                        context_before: String(e.context_before ?? ""),
                        context_after: String(e.context_after ?? ""),
                        reason: e.reason ? String(e.reason) : undefined,
                    }),
                );
                const reuseVersion = turnEditState?.get(indexed.document_id);
                // PII mode: find/context/replace carry placeholders; the
                // real document carries the real values. Restore before
                // anchoring, mask anything that goes back to the model.
                const piiMap = await restoreDocToolPii(edits, piiContext);
                let result: Awaited<ReturnType<typeof runEditDocument>>;
                try {
                    result = piiMap
                        ? await runEditDocument({
                              documentId: indexed.document_id,
                              userId,
                              edits: piiMap.restore(edits),
                              db,
                              reuseVersion,
                          })
                        : ({ ok: false, error: PII_RESTORE_FAILED } as Awaited<
                              ReturnType<typeof runEditDocument>
                          >);
                } catch (editErr) {
                    // runEditDocument can throw (e.g. an unguarded GCS
                    // upload). Without this the exception unwound to
                    // claude.ts's `break`, leaving doc_edited_start with no
                    // terminal event → the "Uređivanje…" chip spun forever
                    // and a half-message was persisted as success (issue #96).
                    // Emit the terminal error event and feed the model an
                    // error tool_result so the turn wraps up cleanly.
                    console.error(
                        "[runToolCalls] edit_document threw:",
                        editErr,
                    );
                    const msg =
                        editErr instanceof Error
                            ? editErr.message
                            : "Document edit failed";
                    result = { ok: false, error: msg } as Awaited<
                        ReturnType<typeof runEditDocument>
                    >;
                }

                if (result.ok) {
                    turnEditState?.set(indexed.document_id, {
                        versionId: result.version_id,
                        versionNumber: result.version_number,
                        storagePath: result.storage_path,
                    });
                    // Keep the chat-local doc label pointed at the latest
                    // edited version so any follow-up read_document call in
                    // the same assistant turn reads and cites the same bytes.
                    if (docIndex[docId]) {
                        docIndex[docId] = {
                            ...docIndex[docId],
                            version_id: result.version_id,
                            version_number: result.version_number,
                        };
                    }
                    const currentDocStore = docStore.get(docId);
                    if (currentDocStore) {
                        docStore.set(docId, {
                            ...currentDocStore,
                            storage_path: result.storage_path,
                        });
                    }
                    // Invalidate the within-turn text cache so a follow-up
                    // read_document sees the freshly-edited bytes, not the
                    // pre-edit snapshot.
                    docTextCache.delete(docId);
                    const payload: DocEditedResult = {
                        filename: docInfo.filename,
                        document_id: indexed.document_id,
                        version_id: result.version_id,
                        version_number: result.version_number,
                        download_url: result.download_url,
                        annotations: result.annotations,
                    };
                    docsEdited.push(payload);
                    // We attach `client` and `edit_mode` here (and only
                    // here, on the wire — not in the persisted event so
                    // history stays client-agnostic) so the Word add-in
                    // can pick the right Apply primitive without an
                    // extra round-trip. Web clients ignore them.
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            ...payload,
                            client: client ?? "web",
                            edit_mode: editMode ?? "track",
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: true,
                            doc_id: docId,
                            document_id: indexed.document_id,
                            version_id: result.version_id,
                            version_number: result.version_number,
                            applied: result.annotations.length,
                            errors: (piiMap ?? EMPTY_PLACEHOLDER_MAP).mask(
                                result.errors,
                            ),
                        }),
                    });
                } else {
                    write(
                        `data: ${JSON.stringify({
                            type: "doc_edited",
                            filename: docInfo.filename,
                            document_id: indexed.document_id,
                            version_id: "",
                            download_url: "",
                            annotations: [],
                            error: result.error,
                        })}\n\n`,
                    );
                    toolResults.push({
                        role: "tool",
                        tool_call_id: tc.id,
                        content: JSON.stringify({
                            ok: false,
                            error: (piiMap ?? EMPTY_PLACEHOLDER_MAP).mask(
                                result.error,
                            ),
                        }),
                    });
                }
            }

        } else if (tc.function.name === "replicate_document" && docIndex) {
            const rawDocId = args.doc_id as string;
            // Placeholders never become part of a filename (PII mode).
            const requestedFilename =
                typeof args.new_filename === "string" &&
                stripPlaceholders(args.new_filename).trim()
                    ? stripPlaceholders(args.new_filename).trim()
                    : null;
            const requestedCount =
                typeof args.count === "number" && Number.isFinite(args.count)
                    ? Math.max(1, Math.min(20, Math.floor(args.count)))
                    : 1;
            const sourceLabel =
                resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
            const sourceInfo = docStore.get(sourceLabel);
            const sourceIndexed = docIndex[sourceLabel];
            const sourceFilename = sourceInfo?.filename ?? rawDocId;

            write(
                `data: ${JSON.stringify({
                    type: "doc_replicate_start",
                    filename: sourceFilename,
                    count: requestedCount,
                })}\n\n`,
            );

            const fail = (error: string) => {
                write(
                    `data: ${JSON.stringify({
                        type: "doc_replicated",
                        filename: sourceFilename,
                        count: requestedCount,
                        copies: [],
                        error,
                    })}\n\n`,
                );
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({ ok: false, error }),
                });
            };

            if (!sourceInfo || !sourceIndexed) {
                fail(`Document '${rawDocId}' not found in this project.`);
            } else if (!projectId) {
                fail("replicate_document is only available in project chats.");
            } else {
                try {
                    // Pull the active version once — every copy gets the
                    // same starting bytes (with any accepted tracked
                    // changes rolled in), no point re-fetching per copy.
                    const active = await loadActiveVersion(
                        sourceIndexed.document_id,
                        db,
                    );
                    const sourcePath =
                        active?.storage_path ?? sourceInfo.storage_path;
                    const sourcePdfPath = active?.pdf_storage_path ?? null;
                    const raw = await downloadFile(sourcePath);
                    const pdfBytes = sourcePdfPath
                        ? await downloadFile(sourcePdfPath)
                        : null;
                    if (!raw) {
                        fail(
                            "Could not read the source document's bytes from storage.",
                        );
                    } else {
                        // Build N filenames. With count=1 keep the
                        // pre-existing "(copy)" suffix; with count>1 use
                        // numbered "(1)", "(2)" suffixes.
                        const srcExt =
                            sourceInfo.filename.match(/\.[^./\\]+$/)?.[0] ?? "";
                        const baseStem = (() => {
                            if (requestedFilename) {
                                return requestedFilename.replace(
                                    /\.[^./\\]+$/,
                                    "",
                                );
                            }
                            return sourceInfo.filename.replace(
                                /\.[^./\\]+$/,
                                "",
                            );
                        })();
                        const filenames: string[] = [];
                        for (let n = 1; n <= requestedCount; n++) {
                            const suffix =
                                requestedCount === 1
                                    ? requestedFilename
                                        ? ""
                                        : " (copy)"
                                    : ` (${n})`;
                            filenames.push(`${baseStem}${suffix}${srcExt}`);
                        }

                        // Bulk insert N documents in one round-trip.
                        const docRows = filenames.map((fn) => ({
                            project_id: projectId,
                            user_id: userId,
                            filename: fn,
                            file_type: sourceInfo.file_type,
                            size_bytes: raw.byteLength,
                            status: "ready",
                        }));
                        const { data: insertedDocs, error: docErr } = await db
                            .from("documents")
                            .insert(docRows)
                            .select("id, filename");
                        if (docErr || !insertedDocs || insertedDocs.length === 0) {
                            fail(
                                `Failed to record replicated documents: ${docErr?.message ?? "unknown"}`,
                            );
                        } else {
                            // Preserve the request order so each row pairs
                            // with the right filename. Supabase returns
                            // inserted rows in the same order as the
                            // payload.
                            const newDocs = insertedDocs as {
                                id: string;
                                filename: string;
                            }[];
                            const contentType =
                                sourceInfo.file_type === "pdf"
                                    ? "application/pdf"
                                    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

                            // Parallel uploads: the doc bytes (and PDF
                            // rendition if any) for every new copy.
                            const uploadJobs: Promise<unknown>[] = [];
                            const newKeys: string[] = [];
                            const newPdfKeys: (string | null)[] = [];
                            for (const d of newDocs) {
                                const key = storageKey(
                                    userId,
                                    d.id,
                                    d.filename,
                                );
                                newKeys.push(key);
                                uploadJobs.push(
                                    uploadFile(key, raw, contentType),
                                );
                                if (pdfBytes) {
                                    const pdfKey = convertedPdfKey(
                                        userId,
                                        d.id,
                                    );
                                    newPdfKeys.push(pdfKey);
                                    uploadJobs.push(
                                        uploadFile(
                                            pdfKey,
                                            pdfBytes,
                                            "application/pdf",
                                        ),
                                    );
                                } else {
                                    newPdfKeys.push(null);
                                }
                            }
                            await Promise.all(uploadJobs);

                            // Bulk insert N versions in one round-trip.
                            // Every copy ships the same source bytes, so
                            // hash once and share the digest.
                            const rawSha256 = contentSha256(raw);
                            const versionRows = newDocs.map((d, idx) => ({
                                document_id: d.id,
                                storage_path: newKeys[idx],
                                pdf_storage_path: newPdfKeys[idx],
                                source: "upload",
                                version_number: 1,
                                display_name: d.filename,
                                size_bytes: raw.byteLength,
                                content_sha256: rawSha256,
                            }));
                            const { data: insertedVersions, error: verErr } =
                                await db
                                    .from("document_versions")
                                    .insert(versionRows)
                                    .select("id, document_id");
                            if (
                                verErr ||
                                !insertedVersions ||
                                insertedVersions.length !== newDocs.length
                            ) {
                                fail(
                                    `Failed to record replicated document versions: ${verErr?.message ?? "unknown"}`,
                                );
                            } else {
                                const versionByDocId = new Map<string, string>();
                                for (const v of insertedVersions as {
                                    id: string;
                                    document_id: string;
                                }[]) {
                                    versionByDocId.set(v.document_id, v.id);
                                }

                                // current_version_id has to be a per-row
                                // value, so a single UPDATE statement
                                // can't cover all N. Fan out in parallel
                                // instead of sequential awaits.
                                await Promise.all(
                                    newDocs.map((d) =>
                                        db
                                            .from("documents")
                                            .update({
                                                current_version_id:
                                                    versionByDocId.get(d.id),
                                            })
                                            .eq("id", d.id),
                                    ),
                                );

                                // Register every copy under a fresh doc-N
                                // slug so the model can edit/read any of
                                // them in the same turn.
                                const existingLabels = new Set(
                                    Object.keys(docIndex),
                                );
                                let nextLabelIdx = 0;
                                const copies: {
                                    new_filename: string;
                                    document_id: string;
                                    version_id: string;
                                }[] = [];
                                const toolPayloadCopies: {
                                    doc_id: string;
                                    document_id: string;
                                    version_id: string;
                                    filename: string;
                                    download_url: string;
                                }[] = [];
                                for (let idx = 0; idx < newDocs.length; idx++) {
                                    const d = newDocs[idx];
                                    const newKey = newKeys[idx];
                                    const versionId = versionByDocId.get(d.id);
                                    if (!versionId) continue;
                                    while (
                                        existingLabels.has(
                                            `doc-${nextLabelIdx}`,
                                        )
                                    )
                                        nextLabelIdx++;
                                    const slug = `doc-${nextLabelIdx}`;
                                    existingLabels.add(slug);
                                    docIndex[slug] = {
                                        document_id: d.id,
                                        filename: d.filename,
                                    };
                                    docStore.set(slug, {
                                        storage_path: newKey,
                                        file_type: sourceInfo.file_type,
                                        filename: d.filename,
                                    });
                                    copies.push({
                                        new_filename: d.filename,
                                        document_id: d.id,
                                        version_id: versionId,
                                    });
                                    toolPayloadCopies.push({
                                        doc_id: slug,
                                        document_id: d.id,
                                        version_id: versionId,
                                        filename: d.filename,
                                        download_url: buildDownloadUrl(
                                            newKey,
                                            d.filename,
                                        ),
                                    });
                                }

                                write(
                                    `data: ${JSON.stringify({
                                        type: "doc_replicated",
                                        filename: sourceFilename,
                                        count: copies.length,
                                        copies,
                                    })}\n\n`,
                                );
                                docsReplicated.push({
                                    filename: sourceFilename,
                                    count: copies.length,
                                    copies,
                                });
                                toolResults.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: JSON.stringify({
                                        ok: true,
                                        count: copies.length,
                                        copies: toolPayloadCopies,
                                    }),
                                });
                            }
                        }
                    }
                } catch (e) {
                    fail(`replicate_document failed: ${String(e)}`);
                }
            }

        } else if (tc.function.name === "generate_docx") {
            // Fallback to "document" if title is missing - model sometimes omits required fields
            const title = (args.title as string) || "document";
            const landscape = !!(args.landscape);
            console.log(`[generate_docx] title="${title}" landscape=${landscape} args.landscape=${args.landscape}`);
            console.log(`[generate_docx] sections type=${typeof args.sections}, isArray=${Array.isArray(args.sections)}, length=${Array.isArray(args.sections) ? args.sections.length : 'N/A'}`);
            if (Array.isArray(args.sections) && args.sections.length > 0) {
                console.log(`[generate_docx] first section keys: ${JSON.stringify(Object.keys(args.sections[0]))}`);
                console.log(`[generate_docx] first section preview: ${JSON.stringify(args.sections[0]).slice(0, 500)}`);
            } else {
                console.warn(`[generate_docx] WARNING: sections is empty or not an array! raw args keys: ${JSON.stringify(Object.keys(args))}`);
                console.warn(`[generate_docx] full args dump: ${JSON.stringify(args).slice(0, 2000)}`);
            }
            // Diacritics diagnostic: check if Croatian characters survive the pipeline
            if (Array.isArray(args.sections)) {
                const allContent = (args.sections as { content?: string }[])
                    .map(s => s.content ?? "")
                    .join(" ");
                const diacritics = ['č', 'ć', 'š', 'ž', 'đ', 'Č', 'Ć', 'Š', 'Ž', 'Đ'];
                const found = diacritics.filter(d => allContent.includes(d));
                const newlines = (allContent.match(/\n/g) || []).length;
                console.log(`[generate_docx] DIACRITICS CHECK: found=[${found.join(',')}] (${found.length}/10), contentLength=${allContent.length}, newlineCount=${newlines}`);
                if (found.length === 0 && allContent.length > 100) {
                    console.warn(`[generate_docx] ⚠️ NO DIACRITICS in ${allContent.length} chars of Croatian text! Model likely stripped them.`);
                    // Log a sample to see what the model actually sent
                    const sample = allContent.slice(0, 300);
                    console.warn(`[generate_docx] content sample: ${JSON.stringify(sample)}`);
                }
            }
            // ---- Fix 3: Guard against empty sections ----
            // If the model sends an empty or missing sections array, do NOT
            // create an empty document. Instead, return an error to the model
            // so it retries with actual content.
            const rawSections = args.sections;
            if (!Array.isArray(rawSections) || rawSections.length === 0) {
                console.warn(`[generate_docx] BLOCKED: sections is empty or not an array. Asking model to retry.`);
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: "ERROR: The sections array is empty or missing. A document cannot be generated without content. You MUST call generate_docx again and provide a sections array with at least one section containing heading and content fields. Each section needs a heading (string), level (1, 2, or 3), and content (string with the prose text). Do NOT send an empty sections array.",
                });
                continue;
            }
            // PII mode: the model wrote placeholders; the file gets the
            // real values. The filename is built from the title WITHOUT
            // placeholders — it is shown to the model again in later turns.
            const piiMap = await restoreDocToolPii(
                { title, sections: rawSections },
                piiContext,
            );
            if (!piiMap) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: PII_RESTORE_FAILED,
                });
                continue;
            }
            const restored = piiMap.restore({ title, sections: rawSections });
            const filenameTitle = stripPlaceholders(title);
            const previewFilename = generatedDocumentFilename(filenameTitle, "docx");
            write(`data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`);
            const result = await generateDocx(
                restored.title,
                restored.sections as unknown[],
                userId,
                db,
                { landscape, projectId: projectId ?? null, filenameTitle },
            );
            let newDocLabel: string | null = null;
            if ("filename" in result && "download_url" in result) {
                const dlFilename = result.filename as string;
                const dlUrl = result.download_url as string;
                const documentId = (result as { document_id?: string }).document_id;
                const versionId = (result as { version_id?: string }).version_id;
                const versionNumber = (result as { version_number?: number }).version_number ?? null;
                const storagePath = (result as { storage_path?: string }).storage_path;

                // Register the generated doc in the chat context so
                // edit_document (and read_document / find_in_document)
                // can act on it within the same assistant turn. New label
                // is the next free `doc-N` index. Subsequent turns pick
                // it up via the normal attachment/project doc query.
                if (documentId && storagePath && docIndex) {
                    const existingLabels = new Set(Object.keys(docIndex));
                    let i = 0;
                    while (existingLabels.has(`doc-${i}`)) i++;
                    newDocLabel = `doc-${i}`;
                    docIndex[newDocLabel] = {
                        document_id: documentId,
                        filename: dlFilename,
                    };
                    docStore.set(newDocLabel, {
                        storage_path: storagePath,
                        file_type: "docx",
                        filename: dlFilename,
                    });
                }

                write(
                    `data: ${JSON.stringify({
                        type: "doc_created",
                        filename: dlFilename,
                        download_url: dlUrl,
                        document_id: documentId,
                        version_id: versionId,
                        version_number: versionNumber,
                    })}\n\n`,
                );
                docsCreated.push({
                    filename: dlFilename,
                    download_url: dlUrl,
                    document_id: documentId,
                    version_id: versionId,
                    version_number: versionNumber,
                });
            } else {
                write(`data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`);
            }
            // Surface the chat-local doc label in the tool result so the
            // model can pass it as `doc_id` to edit_document / read_document
            // / find_in_document in the same turn. Without this the model
            // only sees the DB UUID, which isn't valid as a doc_id anchor.
            const toolResultPayload = newDocLabel
                ? { ...(result as Record<string, unknown>), doc_id: newDocLabel }
                : result;
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: JSON.stringify(toolResultPayload),
            });
        } else if (tc.function.name === "read_url") {
            // Model-driven URL reader: fetch a public web page or PDF and
            // hand the text back for grounding. Covers reading a PDF a
            // search surfaced and reading a link the user pasted. Backed by
            // Parallel Extract (flat $0.001/call), folded into the same
            // external-tool USD tally as web search. Default returns a
            // focused preview; the model re-calls with full=true for the
            // whole document once it judges the source worth reading.
            const url = typeof args.url === "string" ? args.url.trim() : "";
            const objective =
                typeof args.objective === "string" ? args.objective : undefined;
            const full = args.full === true;
            if (!url) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: "read_url requires a 'url' argument.",
                });
                continue;
            }
            // EUR-Lex / CURIA and friends: we hold that corpus ourselves,
            // so the model is routed to the legal source tools instead of
            // scraping a public copy. Intercepted BEFORE the started
            // event so the user never sees a link-read that we then have
            // to fail — nothing is fetched and nothing is billed.
            const corpusNotice = corpusOwnedUrlNotice(url);
            if (corpusNotice) {
                toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: corpusNotice,
                });
                continue;
            }
            write(
                `data: ${JSON.stringify({
                    type: "web_extract_started",
                    url,
                    full,
                })}\n\n`,
            );
            const result = await readUrl(url, { objective, full });
            // Bill the flat per-call cost only when we actually hit the
            // provider and got content back (a malformed URL or a hard
            // provider failure shouldn't be charged).
            if (!result.error) {
                webSearchCostUsd += READ_URL_COST_USD;
            }
            const event: WebExtractEvent = {
                type: "web_extract_result",
                url: result.url,
                title: result.title,
                snippet: (result.text || result.error || "").slice(0, 500),
                is_pdf: result.isPdf,
                full: result.full,
                error: result.error,
            };
            write(`data: ${JSON.stringify(event)}\n\n`);
            webExtracts.push(event);
            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: formatExtractForLLM(result),
            });
        } else if (isSearchToolName(tc.function.name)) {
            // Role-based search tools (search_official_sources / search_web
            // / search_news). The tool NAME picks the provider via its
            // route chain — we never expose the vendor enum to the model.
            const route = getSearchRoute(tc.function.name)!;
            const kind: SearchKind = route.kind;

            const query = typeof args.query === "string" ? args.query : "";
            const numResults =
                typeof args.num_results === "number"
                    ? args.num_results
                    : undefined;
            const recencyDays =
                typeof args.recency_days === "number"
                    ? args.recency_days
                    : undefined;
            // Validate `source_group` against the route's whitelist so the
            // model can only narrow to a curated official-source group.
            const rawSourceGroup =
                typeof args.source_group === "string"
                    ? args.source_group
                    : undefined;
            const sourceGroup =
                rawSourceGroup &&
                route.sourceGroupChoices?.includes(rawSourceGroup)
                    ? rawSourceGroup
                    : undefined;

            // Provider: first usable entry in the route's chain (honoring
            // the project's provider allowlist), graceful fallback inside.
            const provider =
                resolveRouteProvider(route, projectSearchConfig.providers) ??
                undefined;

            // source_keys priority for the official tool:
            //   model-chosen group → project config → route default.
            // Web/news inherit the project allowlist (may be empty = open).
            const effectiveSourceKeys =
                kind === "official"
                    ? sourceGroup
                        ? [sourceGroup]
                        : projectSearchConfig.source_keys.length
                          ? projectSearchConfig.source_keys
                          : route.sourceGroupDefault
                            ? [route.sourceGroupDefault]
                            : undefined
                    : projectSearchConfig.source_keys.length
                      ? projectSearchConfig.source_keys
                      : undefined;

            const effectiveNumResults =
                numResults ?? route.defaults.num_results ??
                projectSearchConfig.num_results;
            const effectiveRecency =
                recencyDays ??
                route.defaults.recency_days ??
                projectSearchConfig.recency_days ??
                undefined;

            // Tell the client a search is starting so the UI can render the
            // "Searching…" affordance immediately, before the (potentially
            // 30s) provider round-trip finishes. Wire-format provider is
            // hard-coded to "eulex" — we never surface the upstream
            // Tavily/Exa/Parallel identity. `kind` lets the UI label the
            // block (official / web / news). Internal billing below still
            // keys off the real provider returned by webSearch().
            write(
                `data: ${JSON.stringify({
                    type: "web_search_started",
                    query,
                    provider: "eulex",
                    kind,
                })}\n\n`,
            );

            const resp = await webSearch({
                query,
                provider,
                num_results: effectiveNumResults,
                recency_days: effectiveRecency,
                source_keys: effectiveSourceKeys,
                allowed_providers: projectSearchConfig.providers,
            });

            // Bill on the real upstream provider before we strip its name
            // out of the public event.
            if (resp.provider) {
                webSearchCostUsd += computeSearchCallCostUsd(
                    resp.provider as SearchProvider,
                    Array.isArray(resp.results) ? resp.results.length : 0,
                );
            }

            const event: WebSearchEvent = {
                type: "web_search_result",
                provider: "eulex",
                kind,
                query: resp.query,
                results: resp.results.map((r) => ({
                    title: r.title,
                    url: r.url,
                    snippet: r.content,
                    published_date: r.published_date ?? null,
                })),
                error: resp.error ?? null,
            };
            write(`data: ${JSON.stringify(event)}\n\n`);
            webSearches.push(event);

            toolResults.push({
                role: "tool",
                tool_call_id: tc.id,
                content: formatSearchResultsForLLM(resp),
            });
        }
    }

    return {
        toolResults,
        docsRead,
        docsFound,
        docsCreated,
        docsReplicated,
        workflowsApplied,
        docsEdited,
        mcpResults,
        legalSources,
        webSearches,
        webExtracts,
        // Round to numeric(12,6) precision, same as llm_usage.cost_usd.
        webSearchCostUsd: Math.round(webSearchCostUsd * 1e6) / 1e6,
    };
}

// ---------------------------------------------------------------------------
// Citation parsing
// ---------------------------------------------------------------------------

const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
const CITATIONS_OPEN_TAG = "<CITATIONS>";

function parseCitations(text: string): ParsedCitation[] {
    const match = text.match(CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        const raw = JSON.parse(match[1]);
        if (!Array.isArray(raw)) return [];
        return raw
            .map(normalizeCitation)
            .filter((c): c is ParsedCitation => c !== null);
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// LLM streaming loop
// ---------------------------------------------------------------------------

export type EditAnnotation = {
    kind: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before: string;
    context_after: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
};

type AssistantEvent =
    | { type: "reasoning"; text: string }
    | { type: "doc_read"; filename: string; document_id?: string }
    | {
          type: "doc_find";
          filename: string;
          query: string;
          total_matches: number;
      }
    | {
          type: "doc_created";
          filename: string;
          download_url: string;
          document_id?: string;
          version_id?: string;
          version_number?: number | null;
      }
    | { type: "doc_download"; filename: string; download_url: string }
    | {
          type: "doc_replicated";
          /** Source document being copied. */
          filename: string;
          count: number;
          copies: {
              new_filename: string;
              document_id: string;
              version_id: string;
          }[];
      }
    | { type: "workflow_applied"; workflow_id: string; title: string }
    | {
          type: "doc_edited";
          filename: string;
          document_id: string;
          version_id: string;
          /** Per-document monotonic Vn; null if backend couldn't determine it. */
          version_number: number | null;
          download_url: string;
          annotations: EditAnnotation[];
      }
    | { type: "content"; text: string }
    | McpToolResultEvent
    | LegalSourcesEvent
    | WebSearchEvent
    | WebExtractEvent;

export async function runLLMStream(params: {
    apiMessages: unknown[];
    docStore: DocStore;
    docIndex: DocIndex;
    userId: string;
    db: ReturnType<typeof createServerSupabase>;
    write: (s: string) => void;
    extraTools?: unknown[];
    workflowStore?: WorkflowStore;
    tabularStore?: TabularCellStore;
    buildCitations?: (fullText: string) => unknown[];
    model?: string;
    /**
     * User-selected reasoning intensity for this turn. Forwarded to
     * Claude (`output_config.effort`), GPT-5 (`reasoning_effort`), and
     * Gemini (`thinkingConfig.thinkingLevel`). Mistral / LocalLLM
     * silently ignore it. Defaults to "high" to preserve the legacy
     * behavior we shipped before the picker existed.
     */
    reasoningEffort?: import("./llm").ReasoningEffort;
    apiKeys?: import("./llm").UserApiKeys;
    /**
     * If set, generate_docx will attach created docs to this project so
     * they appear in the project sidebar. Leave null for general chats —
     * generated docs still get persisted, but as standalone documents.
     */
    projectId?: string | null;
    /**
     * MCP servers loaded for this user (already connected, with tool lists
     * fetched). Their tools are merged into the per-request tool set under
     * the `mcp__<slug>__` prefix. Leave undefined when no MCP support is
     * wired in or the user has none configured.
     */
    mcpServers?: LoadedMcpServer[];
    /**
     * Where this chat originates. The Word add-in renders edit annotations
     * itself via Office.js (the user's open document is the source of
     * truth, not the cloud .docx version), so we tighten the model's
     * `find` strategy when client === "word" — see the addendum below.
     * Defaults to "web".
     */
    client?: "web" | "word";
    /**
     * User's chosen application mode for assistant edits. Only meaningful
     * when `client === "word"`; we feed it into the prompt so `reason`
     * fields read naturally on the Apply card, and echo it back in the
     * `doc_edited` SSE event so the client picks the matching primitive
     * (`applyTrackedChangeWithComment` vs `insertCommentAtRange`).
     */
    editMode?: "track" | "comments";
    /**
     * PII Shield context. When supplied AND the user's mode is not
     * "off", document reads + MCP tool args/results pass through the
     * sidecar (anonymize on input, deanonymize on output). The chat
     * handler is responsible for resolving the user's mode + locale
     * and supplying the chat id; once attached we re-use it through
     * the whole tool loop.
     */
    piiContext?: PiiToolContext | null;
    /**
     * Whether the caller's tier may use the `generate_docx` ("Word export
     * of research") tool — Plus and up. When explicitly `false` we drop it
     * from the tool list so the model never offers it; `undefined` keeps
     * it (backward-compatible for callers that don't gate).
     */
    canExportDocx?: boolean;
    /**
     * User-facing web-search toggle (the globe icon in the composer).
     * When `false` the role-based search tools are dropped from the
     * toolset so the model can't search. `undefined`/`true` keeps them
     * (subject to provider keys being configured). Default: enabled.
     */
    webSearchEnabled?: boolean;
    /**
     * Contexts active for this turn, resolved by the configured context
     * provider (sorted by id — see seams/contextsRuntime.loadContextsForTurn).
     * When non-empty, their instruction blocks are appended to the STATIC
     * (cached) system prompt and legal retrieval is hard-scoped to their
     * opaque scope allowlists (L2 redaction + pre-call check in
     * runToolCalls). Undefined/empty → behaviour identical to today.
     */
    activeContexts?: ResolvedContext[];
    /**
     * Aborts the turn when the client disconnects. Forwarded to the provider
     * adapter (SDK request signal + between-iteration checks) so a Stop /
     * tab-close stops token spend and further tool calls (issue #92).
     */
    abortSignal?: AbortSignal;
    /**
     * The SAME per-turn AbortController whose `signal` is passed above
     * (tracker #25). When provided, runLLMStream arms an idle stall
     * watchdog (`LLM_STREAM_DEADLINE_MS`, default 240 s): if the provider
     * stream stays silent for the whole deadline, the watchdog fires this
     * controller's abort() — the EXISTING cancellation path, so token
     * spend and tool calls stop exactly like on a client Stop — and
     * runLLMStream rejects with LlmStreamStallError so the route emits
     * its terminal `{type:"error"}` SSE event and ends the response.
     * The deadline is idle-based: every chunk/event re-arms it, so long
     * legitimate generations never trip it. Undefined → no watchdog
     * (non-interactive callers like tabular manage their own bounds).
     */
    turnAbort?: AbortController;
}): Promise<{
    fullText: string;
    events: AssistantEvent[];
    /**
     * Token usage summed across the whole tool-use loop, plus the model
     * actually selected for this turn. Caller persists this to
     * llm_usage and computes USD via lib/llmPricing. Sol also returns
     * a receipt for every API call, including cache writes and reads.
     */
    usage?: import("./llm").LlmUsage;
    selectedModel: string;
    /**
     * Total USD billed by the search providers across all web_search
     * tool calls fired during this turn. Caller folds this into the
     * `cost_usd` it persists to llm_usage (the row stays a single line
     * — we don't split LLM vs search costs in the schema). Always
     * present even when no search ran (then it's 0).
     */
    webSearchCostUsd: number;
    /**
     * Extracted text of every document the model read this turn, keyed by
     * doc label ("doc-N"). Pass to `extractAnnotations` so the persisted
     * `citation_data` annotations carry the same `verification` field the
     * streamed `citations` event does (tracker #22). PII-anonymized when
     * PII was active — matching what the model saw AND what its quotes
     * contain (persisted assistant text keeps placeholders).
     */
    docTexts: Map<string, string>;
}> {
    const { apiMessages, docStore, docIndex, userId, db, extraTools, workflowStore, tabularStore, buildCitations, model, reasoningEffort, apiKeys, projectId, mcpServers, client, editMode, piiContext, canExportDocx, webSearchEnabled, activeContexts, abortSignal, turnAbort } = params;
    // Stall watchdog (#25) — created right before the stream call below;
    // declared here so the `write` wrapper can re-arm it. Every SSE event
    // this stream emits (tool progress from runToolCalls included) counts
    // as liveness, so a long sequential tool batch keeps the deadline
    // fresh per completed tool while a single hung upstream still trips it.
    let stallWatchdog: import("./llm").StallWatchdog | null = null;
    const write = (s: string) => {
        stallWatchdog?.touch();
        params.write(s);
    };
    // Opaque scope allowlist — unioned once per stream from the resolve
    // responses; empty when no context is active, which turns every scope
    // hook below into a no-op.
    const scopeWhitelist = buildScopeSet(
        (activeContexts ?? []).map((c) => c.scope_allowlist),
    );
    const editModeForClient = editMode ?? "track";
    const isWordClient = client === "word";
    // Search-provider USD running tally for this turn. The model may
    // issue web_search across multiple tool batches inside one stream,
    // so we sum across every runTools callback invocation.
    let totalWebSearchCostUsd = 0;
    // Turn-scoped extracted-text store (tracker #22): doc label → the text
    // the model read. Doubles as the read cache inside runToolCalls and
    // feeds deterministic citation-quote verification after the stream.
    const docTexts = new Map<string, string>();
    const mcpTools = (mcpServers ?? []).flatMap((s) => s.tools);
    // Web search is a server-side capability gated two ways: (1) the user's
    // composer toggle (globe icon) must be on, and (2) at least one
    // provider env key must be configured. Either off → no search tools in
    // the toolset, so the model can't advertise or call one.
    const webSearchTools =
        webSearchEnabled !== false && anySearchToolActive()
            ? getActiveSearchTools()
            : [];
    // `read_url` is offered whenever an extract provider key is configured.
    // It is NOT gated on the web-search toggle: reading a link the user
    // pasted (or a PDF the model already found) is a direct request, not
    // autonomous searching, so the globe toggle shouldn't suppress it.
    const readUrlTools = isExtractConfigured() ? [READ_URL_TOOL] : [];
    // Word export (generate_docx) is a Plus+ entitlement. Drop it from the
    // tool list when the caller explicitly gates it off so the model never
    // advertises it; undefined leaves the full set (backward-compatible).
    const baseTools =
        canExportDocx === false
            ? TOOLS.filter((t) => t.function.name !== "generate_docx")
            : TOOLS;
    const activeTools = [
        ...baseTools,
        ...WORKFLOW_TOOLS,
        ...webSearchTools,
        ...readUrlTools,
        ...(extraTools ?? []),
        ...mcpTools,
    ];

    // Extract system prompt; pass remaining turns to the adapter as
    // plain user/assistant messages.
    const rawMsgs = apiMessages as { role: string; content: string | null }[];
    let systemPrompt =
        rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";

    // Split off the per-turn AVAILABLE DOCUMENTS block (emitted by
    // buildMessages behind SYSTEM_DYNAMIC_DOC_MARKER) so it travels as a
    // separate, UNcached system block. Capability addenda below are
    // appended to the STATIC `systemPrompt`, keeping the whole static
    // prefix stable across turns of a conversation → prompt-cache hits.
    let systemDynamicSuffix = "";
    const dynIdx = systemPrompt.indexOf(SYSTEM_DYNAMIC_DOC_MARKER);
    if (dynIdx >= 0) {
        systemDynamicSuffix = systemPrompt.slice(
            dynIdx + SYSTEM_DYNAMIC_DOC_MARKER.length,
        );
        systemPrompt = systemPrompt.slice(0, dynIdx);
    }

    // When the user has live MCP connectors, the grounding / jurisdiction /
    // research-procedure addenda come from the governance prompt pack (or the
    // short generic fallback) and are appended at the exact positions the
    // former literals occupied. Injected per request (rather than into the
    // base prompt) so users without MCP don't pay the prompt-token cost or
    // get told about tools they can't use.
    if (mcpServers && mcpServers.length > 0) {
        systemPrompt += buildMcpPromptAddenda(mcpServers);
    }

    // Web search addendum — only when the user toggle is on AND at least
    // one provider is configured, so the role-based search tools are in
    // the active toolset for this turn.
    if (webSearchTools.length > 0) {
        // SECURITY: do NOT enumerate the underlying provider vendors
        // (Tavily/Exa/Parallel/You.com). The model only ever sees the
        // role-based tool names; vendor identity is confidential infra
        // metadata and must not leak into answers.
        const webSearchPrompt = getWebSearchPrompt();
        systemPrompt += webSearchPrompt;
    }

    // read_url addendum — present whenever the URL reader is active (not
    // gated on the web-search toggle). Teaches the two product flows
    // (read a PDF/page a search surfaced; read a link the user pasted)
    // and the preview→full two-step so the model doesn't pull whole
    // documents into context before judging relevance.
    if (readUrlTools.length > 0) {
        const readUrlPrompt = `\n\n---\nREAD URL / PDF — the \`read_url\` tool is LIVE. It fetches the full text of ONE public web page or PDF by its URL.\n\nUSE IT WHEN:\n- A web search returns a relevant result whose snippet is not enough — ESPECIALLY a PDF (a \`.pdf\` link). The search gives you the URL; call \`read_url\` on it to read the actual document before you cite it. Do NOT cite a PDF from its search snippet alone.\n- The user pastes or names a URL in their message and the answer depends on what's on that page — read it before answering.\n\nDO NOT USE IT FOR: EU legislation and CJEU case law (eur-lex.europa.eu, curia.europa.eu). We hold that corpus ourselves — always retrieve those documents through the legal source tools (by CELEX id or search), never by reading the public web page. Such a call is refused and returns no text.\n\nHOW (two steps, to stay efficient):\n1. PREVIEW first: call \`read_url\` with the \`url\` and an \`objective\` (what you need from it). You get the most relevant passages — enough to judge whether the source is on point and to answer focused questions.\n2. FULL only if needed: if the preview shows the document is relevant and you need more than the excerpts (e.g. to read a whole PDF end-to-end), call \`read_url\` again with \`full: true\` for the entire text.\n\nGround your answer on the returned text and cite the URL inline (e.g. "Prema [naslovu](URL), …"). If \`read_url\` returns an error (login wall, not found, nothing extracted), tell the user plainly and do not invent the contents.\n---\n`;
        systemPrompt += readUrlPrompt;
    }

    // Word add-in addendum. The Word client renders one Apply card per
    // annotation we emit on the `doc_edited` SSE event and applies it
    // locally with Office.js' `Word.body.search()` + tracked changes —
    // the user's open .docx is the surface they care about, not the
    // server-side new version. To make those Apply clicks succeed,
    // `find` must be reachable by Office.js' search primitive, which has
    // hard limits Microsoft Q&A spells out: ≤200 chars, single
    // paragraph, no cross-paragraph regex. Passing `editMode` shapes the
    // language of `reason` so the Apply card reads naturally for the
    // user's chosen mode. We KEEP `edit_document` as the only edit tool
    // (do not invent inline `mike-edit` blocks) — single source of truth
    // means the same model output is consumed identically by web and
    // Word, and the server still writes a backup .docx version to GCS.
    // PII Shield addendum — when the chat is in an active PII mode the
    // sidecar replaces sensitive values in every document read with
    // `⟦PII:ENTITY_TYPE_N⟧` placeholders BEFORE the text reaches the
    // model. Without explicit instructions, models silently rephrase the
    // placeholders away ("the party", "the user"), which destroys the
    // client-side de-anonymisation pipeline — the answer arrives with no
    // tokens for `usePiiRenderedText` to swap back. This addendum tells
    // the model to copy placeholders verbatim and forbids hallucinating
    // real values. Bilingual on purpose: the rule is too important to
    // be lost in translation.
    if (piiContext && piiContext.mode !== "off") {
        const packAddendum = getPiiAddendumOverride(piiContext.language);
        if (packAddendum !== null) {
            systemPrompt += packAddendum;
        } else {
            const { piiSystemPromptAddendum } = await import("./pii");
            systemPrompt += piiSystemPromptAddendum({
                mode: piiContext.mode,
                locale: piiContext.language,
            });
        }
    }

    if (isWordClient) {
        systemPrompt += `\n\n---\nWORD ADD-IN MODE — the user is composing inside Microsoft Word.\n\nThe \`edit_document\` tool stays your only edit primitive. The Word client receives every annotation you produce on the \`doc_edited\` event and renders an "Apply in Word" card per annotation, applied via \`Word.body.search()\` + tracked changes against the user's open .docx.\n\nCRITICAL - HOW TO EDIT:\n- When the user asks to change, replace, rename, reword, insert, or delete ANYTHING in the open document, you MUST make EVERY change by CALLING the edit_document tool (one call, all edits batched). Describing a change in prose is NOT editing - prose with no edit_document call produces zero Apply cards and leaves the document completely untouched. Never narrate edits instead of calling the tool, and never say you "will" change something without calling edit_document in the same turn.\n- Everything you produce is a PROPOSAL, not an applied edit. Nothing enters the document until the user clicks Apply (or Apply all) on the cards. NEVER tell the user a change is "applied", "done", "replaced", "updated", "renamed", or "successful" - it is not, until they click. Phrase your prose as proposals, e.g. "I've prepared 3 tracked-change suggestions - click Apply (or Apply all) to insert them," then briefly say what each one does.\n- Every find value MUST be copied verbatim from the text returned by read_document / find_in_document (exact characters, punctuation and casing) - never paraphrased or rebuilt from memory.\n\nTo keep those Apply clicks succeed-rate high:\n\n1. Each \`find\` MUST be unambiguously locatable inside the open Word document via \`Word.body.search()\`. That means:\n   - keep it ≤ 200 characters,\n   - keep it inside a single paragraph (Office.js search does NOT match across paragraph marks),\n   - prefer the shortest snippet that still uniquely identifies the location (often just the words / characters that actually change, not the whole sentence).\n2. Always populate \`context_before\` (~40 chars right before \`find\`) and \`context_after\` (~40 chars right after) so the Apply card shows the surrounding paragraph and the user can audit which spot will be edited. Without these, two identical \`find\` strings in the document collapse onto the same range.\n3. Your edits run against the user's LIVE document state. If you previously read it via \`read_document\`, treat that snapshot as potentially stale — re-read with \`find_in_document\` for any clause whose location is critical (e.g. cross-references that may have shifted from earlier accepted edits in this session).\n4. The user's chosen application mode is "${editModeForClient}". Phrase the \`reason\` field accordingly:\n   - "track" → terse imperative explaining WHY the change is needed (e.g. "Aligns with EU Late Payment Directive 30-day cap").\n   - "comments" → suggestion language so it reads naturally inside a Word comment (e.g. "Suggest replacing 10% with 5% — EU Late Payment Directive caps payment terms at 30 days, not 7.").\n5. Batch related edits in a SINGLE \`edit_document\` call rather than one tool call per change — Microsoft's Office.js guidance is "minimize context.sync() calls"; the client batches all annotations from one tool call into one \`Word.run()\`, so fewer / larger calls means fewer document-layout recalcs for the user.\n6. Do NOT add download links, "I've also written a new version" prose, or any other reference to the server-side .docx copy — the user does not care about it; it's a backup. Speak as if the only output is the Apply cards.\n7. read_document / find_in_document reflect a SERVER-SIDE working copy of the attachment, which can DIVERGE from the user's live open document: your own earlier edit_document calls mutate that server copy, but the user's live document only changes when THEY click Apply. So NEVER conclude from a read that a requested change is "already present", "already applied", or "already done", and never tell the user the document already contains the target text. When the user asks for a change, always (re)issue it through edit_document so they get fresh Apply cards.\n---\n`;
    }

    // Custom Contexts: appended LAST among the static (cached) addenda so the
    // scope/abstain rules take precedence over the earlier capability addenda
    // (notably WEB SEARCH — the block's own conflict rule and the model's
    // recency bias both favor later instructions). Stays in the cacheable
    // prefix (stable across turns per the global-toggle model). Empty when no
    // context is active.
    if (activeContexts && activeContexts.length > 0) {
        systemPrompt += buildContextsSystemBlock(activeContexts);
    }

    console.log(
        "[runLLMStream] system prompt:\n" +
            "─".repeat(80) +
            "\n" +
            systemPrompt +
            (systemDynamicSuffix
                ? "\n[dynamic doc block ↓]\n" + systemDynamicSuffix
                : "") +
            "\n" +
            "─".repeat(80),
    );
    const chatMessages: LlmMessage[] = rawMsgs
        .filter((m) => m.role !== "system")
        .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content ?? "",
        }));

    // -------- PII Shield: user-typed turns (#45) -----------------------
    // When the chat is in an active PII mode, the OUTGOING copy of every
    // user-role message is anonymized through the sidecar before it
    // reaches the provider — the STORED message stays raw (the user sees
    // their own text; assistant output persists placeholders and the
    // client deanonymizes at render time). Prior user turns are re-sent
    // on every call, so the whole history window passes through here; the
    // per-request cache collapses duplicate texts into one sidecar call
    // and the shield's HMAC coreference keeps repeated /anonymize calls
    // deterministic across requests (same value → same placeholder).
    // Sequential on purpose: the first call may create the chat session
    // and coreference counters are session-scoped.
    if (piiContext && piiContext.mode !== "off") {
        const { piiActive, failsClosed, piiClient } = await import("./pii");
        if (piiActive(piiContext.mode)) {
            const anonCache = new Map<string, string>();
            for (const msg of chatMessages) {
                if (msg.role !== "user" || !msg.content) continue;
                const cached = anonCache.get(msg.content);
                if (cached !== undefined) {
                    msg.content = cached;
                    continue;
                }
                const result = await piiClient.anonymize({
                    text: msg.content,
                    userId,
                    mode: piiContext.mode,
                    language: piiContext.language,
                    chatId: piiContext.chatId,
                    source: "user_input",
                });
                if (!result.ok) {
                    // Same failure semantics as maybeAnonymize (#48): fail
                    // closed in strict/strict_legal — abort the turn; the
                    // route handler turns this into a localized SSE error
                    // event. Standard fails open with a tagged warn.
                    console.warn(
                        "[pii] /anonymize failed for user turn:",
                        result.error,
                    );
                    if (failsClosed(piiContext.mode)) {
                        throw new PiiShieldUnavailableError();
                    }
                    console.warn(
                        "[pii] fail-open: standard mode — user turn forwarded to the LLM unanonymized (sidecar unavailable)",
                    );
                    anonCache.set(msg.content, msg.content);
                    continue;
                }
                anonCache.set(msg.content, result.data.anonymized_text);
                msg.content = result.data.anonymized_text;
            }
        }
    }

    const events: AssistantEvent[] = [];
    // One assistant turn produces at most one document_versions row per
    // edited doc. `runToolCalls` fires once per tool-call batch; the model
    // may emit multiple batches in a single turn, so this map persists
    // across batches to let subsequent edit_document calls overwrite the
    // turn's existing version instead of creating a new one.
    const turnEditState: TurnEditState = new Map();
    let fullText = "";
    let iterText = "";
    let iterVisibleText = "";
    let iterReasoning = "";
    let visibleTailBuffer = "";
    let citationsOpenSeen = false;

    // SECURITY: every chunk that leaves the server gets run through the
    // identifier scrubber so internal MCP slugs / API key prefixes /
    // Cloud-Run hostnames cannot reach the user even if the model is
    // tricked into emitting them. We also keep a small tail buffer to
    // ensure a token boundary doesn't split a scrub pattern in half.
    const SCRUB_TAIL_KEEP = 64;
    const tailKeep = Math.max(SCRUB_TAIL_KEEP, CITATIONS_OPEN_TAG.length - 1);

    const streamVisibleContent = (delta: string) => {
        if (!delta) return;
        if (citationsOpenSeen) return;

        const combined = visibleTailBuffer + delta;
        const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
        if (markerIdx >= 0) {
            const visibleRaw = combined.slice(0, markerIdx);
            const visible = scrubInternalIdentifiers(visibleRaw);
            if (visible) {
                iterVisibleText += visible;
                write(
                    `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
                );
            }
            visibleTailBuffer = "";
            citationsOpenSeen = true;
            return;
        }

        const keep = Math.min(tailKeep, combined.length);
        const visibleRaw = combined.slice(0, combined.length - keep);
        visibleTailBuffer = combined.slice(combined.length - keep);
        const visible = scrubInternalIdentifiers(visibleRaw);
        if (visible) {
            iterVisibleText += visible;
            write(
                `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
            );
        }
    };

    // Longest suffix of `s` that is a (non-empty) prefix of the citations
    // open tag — i.e. how much of a possibly-split "<CITATIONS>" the tail
    // might be carrying. Capped at len-1 (a full match is handled inline by
    // streamVisibleContent).
    const partialMarkerHoldLen = (s: string): number => {
        const max = Math.min(s.length, CITATIONS_OPEN_TAG.length - 1);
        for (let n = max; n > 0; n--) {
            if (CITATIONS_OPEN_TAG.startsWith(s.slice(s.length - n))) return n;
        }
        return 0;
    };

    const flushVisibleTail = (isFinal = false) => {
        if (citationsOpenSeen || !visibleTailBuffer) {
            visibleTailBuffer = "";
            return;
        }
        // Mid-stream this flush only happens at a tool-call boundary
        // (stop_reason=tool_use), where the model's text block is already
        // complete — no scrub pattern (sys-… slug, *.run.app host, key
        // prefix) can straddle it, so the whole buffer is safe to scrub and
        // emit now. Holding the entire tail here (the old behavior) moved
        // the last ≤64 chars of the pre-tool prose into the NEXT segment,
        // splitting the answer mid-word across the collapsed steps box
        // (issue #150). The only thing still worth holding is a partial
        // <CITATIONS> prefix, in case the model stopped mid-tag right
        // before calling a tool; on the final flush emit everything.
        const holdLen = isFinal
            ? 0
            : partialMarkerHoldLen(visibleTailBuffer);
        const emitPart = visibleTailBuffer.slice(
            0,
            visibleTailBuffer.length - holdLen,
        );
        const hold = holdLen > 0 ? visibleTailBuffer.slice(-holdLen) : "";
        if (emitPart) {
            const visible = scrubInternalIdentifiers(emitPart);
            iterVisibleText += visible;
            write(
                `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
            );
        }
        visibleTailBuffer = hold;
    };

    const flushText = (isFinal = false) => {
        // A held partial-marker fragment can outlive its text segment, so
        // flush even when iterText is empty but the buffer still has bytes.
        if (!iterText && !visibleTailBuffer) return;
        fullText += iterText;
        flushVisibleTail(isFinal);
        if (iterVisibleText) {
            events.push({ type: "content", text: iterVisibleText });
        }
        iterText = "";
        iterVisibleText = "";
        // NOTE: neither visibleTailBuffer NOR citationsOpenSeen is reset here.
        //   • visibleTailBuffer keeps any held partial-marker fragment so a
        //     <CITATIONS> tag split across a tool-call boundary reconnects in
        //     the next segment.
        //   • citationsOpenSeen is LATCHED for the whole turn: the citations
        //     block is emitted once, at the very end, so once we've seen the
        //     open tag we must keep suppressing visible output even across a
        //     tool call that lands mid-JSON. Resetting it per segment (the old
        //     behavior) leaked the JSON tail when a tool call split the block.
    };

    // When the client doesn't pin a model (the Word add-in deliberately
    // ships without a picker), derive a sensible default from the user's
    // configured API keys instead of falling back to the canonical
    // localllm-main — that one always routes through the OpenAI client
    // and crashes the stream when no OPENAI_API_KEY / VLLM_BASE_URL is
    // wired up server-side.
    const orchestrationEnabled = process.env.EULEX_ORCHESTRATION === "1" ||
        process.env.EULEX_ORCHESTRATION === "true";
    const writerModel = process.env.EULEX_WRITER_MODEL || "gpt-5.6-sol";
    const selectedModel = orchestrationEnabled ? writerModel :
        resolveModel(model, resolveDefaultMainModel(apiKeys ?? {}));
    let turnUsage = emptyUsage();

    // Jednomodelni parametri se grade JEDNOM: bez orkestracijskog flaga idu
    // doslovno u streamChatWithTools (ponašanje identično kao prije); s
    // flagom ih runOrchestratedChat koristi kao bazu za obje faze I kao
    // degradacijski put (docs/mcp-orchestration-plan.md).
    const streamParams: StreamChatParams = {
        model: selectedModel,
        promptCacheKey: `max:${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`,
        onUsage: (delta) => { turnUsage = sumUsage(turnUsage, delta); },
        systemPrompt,
        systemDynamicSuffix: systemDynamicSuffix || undefined,
        messages: chatMessages,
        tools: activeTools as OpenAIToolSchema[],
        // Runaway-loop backstop only — NOT a research budget. Deep layered
        // research (EU + national + domain sources in parallel batches) can
        // legitimately need well over 10 tool round-trips; cutting the loop
        // mid-research used to truncate answers. The prompt's RESEARCH
        // EFFORT SCALING rules govern how much the model actually searches.
        maxIterations: 50,
        apiKeys,
        enableThinking: true,
        reasoningEffort,
        abortSignal,
        // Forward the composer globe state. Without this the Claude
        // adapter falls back to the CLAUDE_NATIVE_WEB_SEARCH env default —
        // and since turning the globe OFF also empties webSearchTools
        // (hasCustomSearch=false), the native web-search tool would attach
        // exactly when the user disabled search (issue #97).
        enableWebSearch: webSearchEnabled,
        callbacks: {
            onContentDelta: (delta) => {
                iterText += delta;
                streamVisibleContent(delta);
            },
            onReasoningDelta: (delta) => {
                iterReasoning += delta;
                write(
                    `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
                );
            },
            onReasoningBlockEnd: () => {
                if (!iterReasoning) return;
                events.push({ type: "reasoning", text: iterReasoning });
                write(
                    `data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`,
                );
                iterReasoning = "";
            },
            // Fires after Claude's turn ends with stop_reason=tool_use, before
            // the tool actually runs. Flushes any buffered assistant text so
            // it's emitted in chronological order, then signals the client so
            // it can open a fresh PreResponseWrapper (shows "Working…") while
            // the tool executes — avoids the dead gap between message_stop
            // and the first tool-specific event.
            onToolCallStart: (call) => {
                flushText();
                // `web_search` ships its own `web_search_started` event
                // (emitted from runToolCalls below) which renders a
                // properly branded "Searching the web…" affordance.
                // Surfacing the raw tool name here would leak the
                // internal identifier — keep that out of the UI.
                if (call.name === "web_search") return;
                // For MCP tools, emit a friendly display name (server + tool)
                // alongside the raw prefixed name. The UI renders display_name
                // when present so users don't see `mcp__<slug>__<tool>`.
                let display_name: string | undefined;
                if (call.name.startsWith("mcp__") && mcpServers?.length) {
                    const match = findMcpServerForTool(call.name, mcpServers);
                    if (match) {
                        display_name = `${match.server.row.name} · ${match.originalName}`;
                    }
                }
                write(
                    `data: ${JSON.stringify({
                        type: "tool_call_start",
                        name: call.name,
                        ...(display_name ? { display_name } : {}),
                    })}\n\n`,
                );
            },
        },
        runTools: async (calls) => {
            // Emit any text the model produced before this tool turn so the
            // UI sees it before the tool results stream in.
            flushText();

            const toolCalls: ToolCall[] = calls.map((c) => ({
                id: c.id,
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                },
            }));
            const {
                toolResults,
                docsRead,
                docsFound,
                docsCreated,
                docsReplicated,
                workflowsApplied,
                docsEdited,
                mcpResults,
                legalSources,
                webSearches,
                webExtracts,
                webSearchCostUsd: batchSearchCostUsd,
            } = await runToolCalls(
                    toolCalls,
                    docStore,
                    userId,
                    db,
                    write,
                    workflowStore,
                    tabularStore,
                    docIndex,
                    turnEditState,
                    projectId,
                    mcpServers,
                    client,
                    editModeForClient,
                    params.apiKeys,
                    params.piiContext ?? null,
                    scopeWhitelist,
                    docTexts,
                    selectedModel,
                );
            // Accumulate across every tool batch in this turn so the
            // chat handler can fold the total into `recordLlmUsage`.
            totalWebSearchCostUsd += batchSearchCostUsd;
            for (const r of docsRead) {
                events.push({
                    type: "doc_read",
                    filename: r.filename,
                    document_id: r.document_id,
                });
            }
            for (const f of docsFound) {
                events.push({
                    type: "doc_find",
                    filename: f.filename,
                    query: f.query,
                    total_matches: f.total_matches,
                });
            }
            for (const dl of docsCreated) {
                events.push({
                    type: "doc_created",
                    filename: dl.filename,
                    download_url: dl.download_url,
                    document_id: dl.document_id,
                    version_id: dl.version_id,
                    version_number: dl.version_number ?? null,
                });
            }
            for (const r of docsReplicated) {
                events.push({
                    type: "doc_replicated",
                    filename: r.filename,
                    count: r.count,
                    copies: r.copies,
                });
            }
            for (const wf of workflowsApplied) {
                events.push({
                    type: "workflow_applied",
                    workflow_id: wf.workflow_id,
                    title: wf.title,
                });
            }
            for (const e of docsEdited) {
                events.push({
                    type: "doc_edited",
                    filename: e.filename,
                    document_id: e.document_id,
                    version_id: e.version_id,
                    version_number: e.version_number,
                    download_url: e.download_url,
                    annotations: e.annotations,
                });
            }
            for (const r of mcpResults) {
                events.push(r);
            }
            // Typed legal-source registry for this batch — streamed live so
            // pills/sources-list/panel get clean data, and persisted in events
            // so `extractAnnotations` can resolve `source_id` citations.
            if (legalSources.length > 0) {
                const lsEvent: LegalSourcesEvent = {
                    type: "legal_sources",
                    sources: legalSources,
                };
                write(`data: ${JSON.stringify(lsEvent)}\n\n`);
                events.push(lsEvent);
            }
            for (const w of webSearches) {
                events.push(w);
            }
            for (const x of webExtracts) {
                events.push(x);
            }

            // Index alignment would break if any tool branch skips its
            // push (unhandled tool name, disabled store, guard failure).
            // Each tool_result already carries its tool_call_id, so key off
            // that directly — and fall back to an error result for any
            // tool_use that didn't produce one, so Claude's next request
            // has a tool_result for every tool_use it sent.
            const resultByCallId = new Map<string, string>();
            for (const r of toolResults) {
                const row = r as { tool_call_id: string; content?: unknown };
                resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
            }
            return toolCalls.map((c) => ({
                tool_use_id: c.id,
                content:
                    resultByCallId.get(c.id) ??
                    JSON.stringify({
                        error: `Tool '${c.function.name}' is not available.`,
                    }),
            }));
        },
    };

    // EULEX_ORCHESTRATION: dvostupanjski retriever→writer tok (validiran
    // benchmarkom — plan i ODLUKA u docs/mcp-orchestration-plan.md). Samo
    // kad turn ima MCP alate za dohvat (bez njih retriever nema što
    // orkestrirati); flag je env-only pa se gasi bez deploya.
    const orchestrationOn = orchestrationEnabled && mcpTools.length > 0;

    // Stall watchdog (#25): arm the idle deadline for the whole stream —
    // orchestrated turns span BOTH phases (retriever → writer) on one
    // timer, re-armed by onStreamActivity (wrapped at the shared dispatch
    // point in streamChatWithTools) and by every SSE `write` above.
    const stallDeadlineMs = resolveLlmStreamDeadlineMs();
    let stallReject: (err: Error) => void = () => {};
    const stallGuard: Promise<never> | null = turnAbort
        ? new Promise<never>((_, reject) => {
              stallReject = reject;
          })
        : null;
    if (turnAbort) {
        stallWatchdog = createStallWatchdog({
            deadlineMs: stallDeadlineMs,
            onStall: () => {
                console.error(
                    `[runLLMStream] stall watchdog fired: no provider activity for ${stallDeadlineMs}ms — aborting turn`,
                );
                // The EXISTING per-turn abort: adapters cancel the provider
                // request and skip further tool iterations (issue #92 path).
                turnAbort.abort();
                // Also unblock the await below even if something in the
                // tool loop ignores the abort signal entirely (a hung MCP
                // fetch) — the route must still get to emit its terminal
                // SSE error and end the response.
                stallReject(new LlmStreamStallError(stallDeadlineMs));
            },
        });
        streamParams.onStreamActivity = () => stallWatchdog?.touch();
    }

    let streamResult: StreamChatResult;
    try {
        const streamPromise = orchestrationOn
            ? runOrchestratedChat({
                  retrieverModel:
                      process.env.EULEX_RETRIEVER_MODEL || "gpt-5.6-sol",
                  writerModel,
                  base: streamParams,
              })
            : streamChatWithTools(streamParams);
        if (stallGuard) {
            // If the stall guard wins the race, the orphaned stream promise
            // may still settle later (e.g. a hung tool finally rejecting) —
            // pre-attach a no-op handler so that late rejection never
            // becomes an unhandled-rejection process crash.
            void streamPromise.catch(() => {});
            streamResult = await Promise.race([streamPromise, stallGuard]);
        } else {
            streamResult = await streamPromise;
        }
        if (stallWatchdog?.stalled) {
            // The adapters return their PARTIAL result on abort instead of
            // throwing (see claude.ts / openai.ts) — normalize a stalled
            // turn into an error so it is never persisted as a success.
            throw new LlmStreamStallError(stallDeadlineMs);
        }
    } catch (error) {
        throw attachUsage(error, {
            usage: { ...turnUsage, incomplete: turnUsage.incomplete || !!stallWatchdog?.stalled || !turnUsage.iterations },
            model: turnUsage.calls?.at(-1)?.model ?? selectedModel,
            extraCostUsd: totalWebSearchCostUsd,
        });
    } finally {
        // Timer cleanup on ALL exits: success, provider error, stall,
        // client disconnect. Idempotent.
        stallWatchdog?.stop();
    }

    flushText(true); // final flush — no next segment, emit any held tail

    // Parse and emit citations from <CITATIONS> block. Resolves both
    // document citations and legal-source citations (against the in-turn
    // `legal_sources` events) — same shape the persisted annotations use.
    const citations = buildCitations
        ? buildCitations(fullText)
        : mapCitationsToAnnotations(fullText, docIndex, events, docTexts);
    write(`data: ${JSON.stringify({ type: "citations", citations })}\n\n`);
    write("data: [DONE]\n\n");

    // SECURITY: belt-and-braces — also scrub the persisted fullText and
    // any `content` events so the stored chat_messages row matches what
    // the user saw (which has already been scrubbed mid-stream by
    // streamVisibleContent / flushVisibleTail). We also strip any
    // <CITATIONS> block (or a dangling open tag) from the user-facing
    // `content` events as a final net — the streaming path already withholds
    // it, but a marker split across a tool-call boundary is the one case that
    // could slip through, and the block belongs in `citations`, not the prose.
    const stripCitationsForDisplay = (s: string): string =>
        s
            .replace(/<CITATIONS>[\s\S]*?<\/CITATIONS>/g, "")
            .replace(/<CITATIONS>[\s\S]*$/g, "")
            .trimEnd();
    const scrubbedFullText = scrubInternalIdentifiers(fullText);
    const scrubbedEvents = events.map((ev) =>
        ev && (ev as { type?: string }).type === "content"
            ? {
                  ...ev,
                  text: stripCitationsForDisplay(
                      scrubInternalIdentifiers(
                          (ev as { text?: string }).text ?? "",
                      ),
                  ),
              }
            : ev,
    ) as typeof events;

    return {
        fullText: scrubbedFullText,
        events: scrubbedEvents,
        usage: streamResult.usage,
        selectedModel: streamResult.model ?? selectedModel,
        webSearchCostUsd: totalWebSearchCostUsd,
        docTexts,
    };
}

// ---------------------------------------------------------------------------
// Annotation extraction (for DB save)
// ---------------------------------------------------------------------------

/**
 * Map the parsed `<CITATIONS>` block to persisted/streamed annotations.
 * Document citations become `citation_data`; legal-source citations resolve
 * their `source_id` against the in-turn `legal_sources` events and become
 * `legal_source_data` carrying a self-contained `LegalSource` snapshot
 * (so the message renders even if that event is later trimmed). Unresolved
 * markers are dropped (fail-soft).
 *
 * Citation verification (tracker #22): when `docTexts` carries the extracted
 * text of the cited doc (populated by this turn's read_document /
 * fetch_documents calls), each `citation_data` quote is deterministically
 * located in it — exact hit → `verified`; whitespace/case/diacritic-tolerant
 * hit → `repaired` (quote replaced with the exact source text, original kept
 * in `verification.original_quote`); no hit → `unverified`. When the doc's
 * text is unavailable (e.g. a follow-up turn quoting a doc read earlier) the
 * field is OMITTED — unknown is not unverified, and old records without the
 * field must render unchanged. `legal_source_data` (law articles) is
 * deliberately NOT verified — corpus verification is separate, later work.
 */
function mapCitationsToAnnotations(
    fullText: string,
    docIndex: DocIndex,
    events?: ({ type?: string } & Record<string, unknown>)[],
    docTexts?: Map<string, string>,
): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    // Lazy per-doc matcher cache — normalizing a large doc once per turn,
    // not once per citation.
    const matchers = new Map<string, QuoteMatcher>();
    const matcherFor = (docId: string): QuoteMatcher | null => {
        const text = docTexts?.get(docId);
        if (!text) return null;
        let m = matchers.get(docId);
        if (!m) {
            m = createQuoteMatcher(text);
            matchers.set(docId, m);
        }
        return m;
    };
    for (const c of parseCitations(fullText)) {
        if (c.kind === "source") {
            const src = resolveLegalSource(c.source_id, events);
            if (!src) continue;
            out.push({
                type: "legal_source_data",
                ref: c.ref,
                source: src,
                quote: c.quote,
            });
            continue;
        }
        const docInfo = resolveDoc(c.doc_id, docIndex);
        let quote = c.quote;
        let verification: Record<string, unknown> | undefined;
        try {
            const matcher = matcherFor(c.doc_id);
            if (matcher) {
                const loc = matcher.locate(c.quote);
                if (loc.status === "repaired") {
                    verification = {
                        status: "repaired",
                        original_quote: c.quote,
                    };
                    quote = loc.exact;
                } else {
                    verification = { status: loc.status };
                }
            }
        } catch (err) {
            // Fail-soft: a matcher bug must never drop the citation.
            console.warn(
                "[citations] quote verification threw (non-fatal):",
                err instanceof Error ? err.message : err,
            );
            verification = undefined;
            quote = c.quote;
        }
        out.push({
            type: "citation_data",
            ref: c.ref,
            doc_id: c.doc_id,
            document_id: docInfo?.document_id,
            version_id: docInfo?.version_id ?? null,
            version_number: docInfo?.version_number ?? null,
            filename: docInfo?.filename ?? c.doc_id,
            page: c.page,
            quote,
            ...(verification ? { verification } : {}),
        });
    }
    return out;
}

export function extractAnnotations(
    fullText: string,
    docIndex: DocIndex,
    events?: ({ type?: string } & Record<string, unknown>)[],
    docTexts?: Map<string, string>,
): unknown[] {
    const out: unknown[] = mapCitationsToAnnotations(
        fullText,
        docIndex,
        events,
        docTexts,
    );
    if (Array.isArray(events)) {
        for (const ev of events as { type?: string; annotations?: EditAnnotation[] }[]) {
            if (ev?.type === "doc_edited" && Array.isArray(ev.annotations)) {
                for (const a of ev.annotations) out.push({ ...a, type: "edit_data" });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Document context builder (from message file attachments)
// ---------------------------------------------------------------------------

export async function buildDocContext(
    messages: ChatMessage[],
    userId: string,
    db: ReturnType<typeof createServerSupabase>,
    chatId?: string | null,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();

    const documentIds = new Set<string>();
    for (const m of messages) {
        for (const f of m.files ?? []) {
            if (f.document_id) documentIds.add(f.document_id);
        }
    }

    // Also pull in document_ids from prior assistant events in this chat —
    // generated docs (generate_docx) and tracked-change edits (edit_document)
    // aren't attached to user messages as files, so they only live in the
    // assistant's `doc_created` / `doc_edited` events. Without this sweep
    // the model loses access to generated docs after the turn that created
    // them, and can't call edit_document / read_document on them.
    if (chatId) {
        const { data: rows } = await db
            .from("chat_messages")
            .select("content")
            .eq("chat_id", chatId)
            .eq("role", "assistant");
        for (const row of rows ?? []) {
            const content = (row as { content?: unknown }).content;
            if (!Array.isArray(content)) continue;
            for (const ev of content as Record<string, unknown>[]) {
                if (
                    (ev?.type === "doc_created" ||
                        ev?.type === "doc_edited") &&
                    typeof ev.document_id === "string"
                ) {
                    documentIds.add(ev.document_id);
                }
            }
        }
    }

    const ids = [...documentIds];
    if (ids.length > 0) {
        const { data: docs } = await db
            .from("documents")
            .select("id, filename, file_type, current_version_id, status")
            .in("id", ids)
            .eq("user_id", userId)
            .eq("status", "ready")
            // Deterministic order so the doc-N slug assigned below is STABLE
            // across turns when the doc set is unchanged. Without this, `.in`
            // returns rows in arbitrary order and the same document can shift
            // from doc-2 to doc-0 between turns — re-mapping handles (citations
            // key off document_id, so they survive, but it also needlessly
            // busts the prompt cache for the AVAILABLE DOCUMENTS block).
            .order("created_at", { ascending: true });

        const docList = (docs ?? []) as unknown as {
            id: string;
            filename: string;
            file_type: string;
            current_version_id?: string | null;
            active_version_number?: number | null;
            storage_path?: string | null;
        }[];
        await attachActiveVersionPaths(db, docList);
        for (let i = 0; i < docList.length; i++) {
            const doc = docList[i];
            if (!doc.storage_path) continue;
            const docLabel = `doc-${i}`;
            docIndex[docLabel] = {
                document_id: doc.id,
                filename: doc.filename,
                version_id: doc.current_version_id ?? null,
                version_number: doc.active_version_number ?? null,
            };
            docStore.set(docLabel, {
                storage_path: doc.storage_path,
                file_type: doc.file_type,
                filename: doc.filename,
            });
        }
    }

    console.log(
        "[buildDocContext] available docs:",
        Object.entries(docIndex).map(([label, info]) => ({
            label,
            filename: info.filename,
            document_id: info.document_id,
        })),
    );
    return { docIndex, docStore };
}

export async function buildProjectDocContext(
    projectId: string,
    _userId: string,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ docIndex: DocIndex; docStore: DocStore; folderPaths: Map<string, string> }> {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();

    const [{ data: docs }, { data: folders }] = await Promise.all([
        db.from("documents")
            .select("id, filename, file_type, current_version_id, status, folder_id")
            .eq("project_id", projectId)
            .eq("status", "ready")
            .order("created_at", { ascending: true }),
        db.from("project_subfolders")
            .select("id, name, parent_folder_id")
            .eq("project_id", projectId),
    ]);
    const docList = (docs ?? []) as unknown as {
        id: string;
        filename: string;
        file_type: string;
        current_version_id?: string | null;
        active_version_number?: number | null;
        folder_id?: string | null;
        storage_path?: string | null;
    }[];
    await attachActiveVersionPaths(db, docList);

    // Build folder id → full path map
    const folderMap = new Map<string, { name: string; parent_folder_id: string | null }>();
    for (const f of folders ?? []) folderMap.set(f.id, { name: f.name, parent_folder_id: f.parent_folder_id });

    function resolvePath(folderId: string | null): string {
        if (!folderId) return "";
        const parts: string[] = [];
        let cur: string | null = folderId;
        // A parent_folder_id cycle (see issue #110) would spin this loop
        // forever and hang every chat turn in the project before the stream
        // even opens. Stop at the first repeat and use what we have.
        const seen = new Set<string>();
        while (cur) {
            if (seen.has(cur)) break;
            seen.add(cur);
            const f = folderMap.get(cur);
            if (!f) break;
            parts.unshift(f.name);
            cur = f.parent_folder_id;
        }
        return parts.join(" / ");
    }

    const folderPaths = new Map<string, string>(); // doc label → folder path

    for (let i = 0; i < docList.length; i++) {
        const doc = docList[i];
        if (!doc.storage_path) continue;
        const docLabel = `doc-${i}`;
        docIndex[docLabel] = {
            document_id: doc.id,
            filename: doc.filename,
            version_id: doc.current_version_id ?? null,
            version_number: doc.active_version_number ?? null,
        };
        docStore.set(docLabel, {
            storage_path: doc.storage_path,
            file_type: doc.file_type,
            filename: doc.filename,
        });
        const path = resolvePath(doc.folder_id ?? null);
        if (path) folderPaths.set(docLabel, path);
    }

    console.log(
        "[buildProjectDocContext] available docs:",
        Object.entries(docIndex).map(([label, info]) => ({
            label,
            filename: info.filename,
            document_id: info.document_id,
            folder: folderPaths.get(label) ?? null,
        })),
    );
    return { docIndex, docStore, folderPaths };
}

export async function buildWorkflowStore(
    userId: string,
    userEmail: string | null | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<WorkflowStore> {
    const store: WorkflowStore = new Map();
    const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();

    // Seed built-ins first — served by the governance prompt pack (empty
    // without one; personal/shared workflows below are unaffected). Only
    // assistant-type packs with a prompt participate in read_workflow;
    // tabular packs drive the Analiza templates client-side.
    for (const wf of getWorkflowPacks()) {
        const type = (wf as { type?: unknown }).type;
        if (type !== undefined && type !== "assistant") continue;
        if (typeof wf.prompt_md !== "string" || !wf.prompt_md) continue;
        store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
    }

    // Then overlay user-owned assistant workflows.
    const { data: workflows } = await db
        .from("workflows")
        .select("id, title, prompt_md")
        .eq("user_id", userId)
        .eq("type", "assistant");
    for (const wf of workflows ?? []) {
        if (wf.prompt_md) {
            store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
        }
    }

    // Shared assistant workflows must also be readable by workflow tools.
    if (normalizedUserEmail) {
        const { data: shares } = await db
            .from("workflow_shares")
            .select("workflow_id")
            .eq("shared_with_email", normalizedUserEmail);
        const sharedIds = [...new Set((shares ?? []).map((share: { workflow_id: string }) => share.workflow_id))];
        if (sharedIds.length > 0) {
            const { data: sharedWorkflows } = await db
                .from("workflows")
                .select("id, title, prompt_md")
                .in("id", sharedIds)
                .eq("type", "assistant");
            for (const wf of sharedWorkflows ?? []) {
                if (wf.prompt_md) {
                    store.set(wf.id, { title: wf.title, prompt_md: wf.prompt_md });
                }
            }
        }
    }
    return store;
}
