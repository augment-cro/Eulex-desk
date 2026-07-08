// Shared TypeScript types for Eulex Desk AI legal assistant

export interface MikeFolder {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MikeProject {
  id: string;
  user_id: string;
  is_owner?: boolean;
  name: string;
  cm_number: string | null;
  shared_with: string[];
  created_at: string;
  updated_at: string;
  documents?: MikeDocument[];
  folders?: MikeFolder[];
  document_count?: number;
  chat_count?: number;
  review_count?: number;
}

export interface MikeDocument {
  id: string;
  user_id?: string;
  project_id: string | null;
  folder_id?: string | null;
  filename: string;
  file_type: string | null; // pdf | docx | doc
  storage_path: string | null;
  pdf_storage_path: string | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: StructureNode[] | null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at?: string | null;
  /** Max version_number across assistant_edit rows, null if doc is unedited. */
  latest_version_number?: number | null;
}

export interface StructureNode {
  id: string;
  title: string;
  level: number;
  page_number: number | null;
  children: StructureNode[];
}

export interface MikeChat {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  created_at: string;
}

export interface MikeEditAnnotation {
  type?: "edit_data";
  kind?: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  /** Per-document monotonic Vn for the edit's target version. */
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before?: string;
  context_after?: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
}

export type AssistantEvent =
  | { type: "reasoning"; text: string; isStreaming?: boolean }
  | {
        type: "tool_call_start";
        name: string;
        /** Friendly label (e.g. "Legal Data Hunter · search") for MCP tools. */
        display_name?: string;
        isStreaming?: boolean;
    }
  | { type: "thinking"; isStreaming?: boolean }
  | {
        type: "doc_read";
        filename: string;
        document_id?: string;
        isStreaming?: boolean;
    }
  | {
        type: "doc_find";
        filename: string;
        query: string;
        total_matches: number;
        isStreaming?: boolean;
    }
  | {
        type: "doc_created";
        filename: string;
        download_url: string;
        /** Set when the generated doc is persisted as a first-class document. */
        document_id?: string;
        version_id?: string;
        version_number?: number | null;
        isStreaming?: boolean;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
        type: "mcp_tool_result";
        server: string;
        tool: string;
        ok: boolean;
        /** JSON-stringified args (capped server-side). */
        args: string;
        /** Tool output text (capped server-side). */
        output: string;
        isStreaming?: boolean;
    }
  | {
        type: "doc_replicated";
        /** Source document filename. */
        filename: string;
        /** How many copies were produced in this single tool call. */
        count: number;
        /** One entry per new copy. Empty while streaming. */
        copies?: {
            new_filename: string;
            document_id: string;
            version_id: string;
        }[];
        error?: string;
        isStreaming?: boolean;
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
        type: "doc_edited";
        filename: string;
        document_id: string;
        version_id: string;
        /** Per-document monotonic Vn written at emit time. */
        version_number?: number | null;
        download_url: string;
        annotations: MikeEditAnnotation[];
        error?: string;
        isStreaming?: boolean;
    }
  | {
        /**
         * Live `web_search` tool call kicked off by the LLM. Emitted before
         * the provider round-trip so the UI can show a "Searching the web…"
         * affordance immediately. Replaced/merged with `web_search_result`
         * once results land (matched by `query` so concurrent searches
         * don't collide).
         */
        type: "web_search_started";
        query: string;
        provider: string;
        /** Which role-based search ran: official sources / web / news. */
        kind?: "official" | "web" | "news";
        isStreaming?: boolean;
    }
  | {
        /**
         * Final `web_search` tool result — surfaced as a "Sources" panel
         * the user can click through. `error` is set when the provider
         * round-trip failed; `results` is empty in that case.
         */
        type: "web_search_result";
        query: string;
        provider: string;
        /** Which role-based search ran: official sources / web / news. */
        kind?: "official" | "web" | "news";
        results: {
            title: string;
            url: string;
            snippet: string;
            published_date: string | null;
        }[];
        error: string | null;
        isStreaming?: boolean;
    }
  | {
        /**
         * Live `read_url` tool call — the model is fetching a web page or
         * PDF. Emitted before the round-trip so the UI can show a
         * "Reading link…" affordance; replaced by `web_extract_result`
         * (matched by `url`) once the text lands.
         */
        type: "web_extract_started";
        url: string;
        isStreaming?: boolean;
    }
  | {
        /**
         * Final `read_url` result — a single page/PDF the model read.
         * `snippet` is a short preview of the extracted text (the full
         * body went to the model, not the wire). `error` is set when the
         * fetch failed.
         */
        type: "web_extract_result";
        url: string;
        title: string | null;
        snippet: string;
        /** The URL looked like a PDF (UI badge only). */
        is_pdf: boolean;
        /** true → the whole document was read; false → a focused preview. */
        full: boolean;
        error: string | null;
        isStreaming?: boolean;
    }
  | {
        /**
         * Per-turn registry of legal sources (EU / HR / FR) harvested from
         * MCP tool results. Drives the clickable citation pills, the "Izvori"
         * list under the answer, and the right-side document panel. Mirrors
         * `web_search_result` — structured data, separate from the
         * `mcp_tool_result` activity dot.
         */
        type: "legal_sources";
        sources: LegalSource[];
        isStreaming?: boolean;
    }
  | { type: "content"; text: string; isStreaming?: boolean };

/**
 * Unified legal-source citation shape for the three legal MCP servers
 * (EU/EUR-Lex, Croatian, French). Built backend-side by `harvestLegalSources`.
 */
export interface LegalSource {
  /** Stable id a citation references (HR/FR own id, EU "@eu/celex/…"). */
  id: string;
  scope: "@eu" | "@hr" | "@fr";
  title: string;
  citation?: string | null;
  /** Cited passage text harvested from the tool output (best effort). */
  snippet?: string | null;
  /** Public canonical URL: eur-lex / narodne-novine / legifrance. */
  externalUrl?: string | null;
  articleLabel?: string | null;
  /** In-app fetch path for the full document (Phase 2 proxy). */
  fetchPath?: string | null;
  /** EU only — drives the /legal-docs/eu/{celex} proxy. */
  celex?: string | null;
  inForce?: boolean | null;
}

export interface MikeMessage {
  /**
   * Server-assigned chat_messages.id. Present after the message has been
   * persisted by the backend (set from the `message_id` stream event for
   * fresh assistant turns, or from `getChat` for historical loads).
   * Powers per-message actions like flag/unflag and analytics.
   */
  id?: string;
  role: "user" | "assistant";
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
  model?: string;
  /**
   * Reasoning intensity selected for this turn. Only sent when the
   * picked model exposes a reasoning dial (Claude 4.x, GPT-5, Gemini
   * 3.x); the backend silently ignores it for everything else.
   */
  effort?: "low" | "medium" | "high";
  /**
   * Composer web-search toggle (globe icon) state at send time. `false`
   * tells the backend to drop the web-search tools for this turn;
   * omitted/true keeps them available (subject to provider config).
   */
  webSearch?: boolean;
  annotations?: MikeAnnotation[];
  events?: AssistantEvent[];
  /** Set when streaming failed; rendered as a red error block. */
  error?: string;
  /**
   * Set when the turn was blocked by the daily rate limit (429 or
   * mid-stream `rate_limited`). Renders an in-chat notice telling the
   * user the limit is reached and to pick a larger plan to continue.
   */
  rateLimited?: boolean;
  /**
   * "Not appropriate answer" flag — mirrors chat_messages.is_flagged.
   * Toggled via POST /chat/messages/:id/flag; we keep a denormalised
   * boolean on the message so the UI can render the active flag state
   * without an extra round-trip.
   */
  flagged?: boolean;
}

export interface CitationQuote {
  page: number;
  quote: string;
}

/**
 * A citation emitted by the assistant. Single-page citations have a numeric
 * `page` and a plain `quote`. A citation that spans a page break (one
 * continuous sentence cut by a page boundary) has `page` as a range string
 * like "41-42" and a `quote` containing the `[[PAGE_BREAK]]` sentinel at the
 * break point (text before is on page 41, text after is on page 42).
 */
export interface MikeCitationAnnotation {
  type: "citation_data";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;
  filename: string;
  page: number | string;
  quote: string;
}

/** One article/section of a fetched legal document (Phase 2 full-doc view). */
export interface LegalDocumentArticle {
  id: string;
  label: string | null;
  /** Bare article number for scroll-to-article (language-independent). */
  number?: string | null;
  text: string;
  /** HR full-document only: source `segment_type` (article_heading, stavak,
   *  section_heading, …) driving the panel's hierarchy + article grouping. */
  segmentType?: string | null;
}

/** Normalized full legal document returned by the `/legal-docs` proxy. */
export interface LegalDocument {
  title: string;
  articles: LegalDocumentArticle[];
  /** Law-level citation for the header (HR full-document only). */
  citation?: string | null;
  /** All NN gazette references for the regulation's versions, newest first. */
  gazetteRefs?: string[];
}

/**
 * One precise sub-article citation target — "stavak 2. točka a)" →
 * { stavak: "2", tocka: "a" }. Both fields are lowercase; either may be
 * absent (stavak-only or, in single-stavak articles, točka-only).
 */
export interface PinpointTarget {
  /** Stavak (paragraph) number, e.g. "2" from "(2)". */
  stavak?: string;
  /** Točka (point) id, e.g. "a" from "a)" or "3" from "3.". */
  tocka?: string;
}

/**
 * Precise sub-article citation parsed from the answer prose around a legal
 * reference. Holds ALL cited targets in prose order — "članak 38. stavak 2.
 * točka a) i stavak 9." → { targets: [{ stavak: "2", tocka: "a" },
 * { stavak: "9" }] }. Drives the magenta pinpoint highlight inside
 * `LegalSourcePanel` (the cited article stays green; each exact stavak/točka
 * gets magenta; scroll lands on the first one). Never empty — a citation
 * with no stavak/točka has `pinpoint: null` instead.
 */
export interface CitationPinpoint {
  targets: PinpointTarget[];
}

/**
 * A citation that points at a legal source (EU/HR/FR), not an uploaded
 * document. Carries a self-contained `LegalSource` snapshot so the message
 * renders even if the `legal_sources` event is later trimmed.
 */
export interface MikeLegalSourceAnnotation {
  type: "legal_source_data";
  ref: number;
  source: LegalSource;
  /** Exact cited passage (used to highlight inside the source panel). */
  quote: string;
  /** Stavak/točka pinpoint parsed from the prose around this reference. */
  pinpoint?: CitationPinpoint | null;
}

/** Either citation flavour — what `MikeMessage.annotations` actually holds. */
export type MikeAnnotation =
  | MikeCitationAnnotation
  | MikeLegalSourceAnnotation;

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(
  a: MikeCitationAnnotation,
): CitationQuote[] {
  const rangeMatch =
    typeof a.page === "string"
      ? a.page.match(/^(\d+)\s*-\s*(\d+)$/)
      : null;
  if (rangeMatch && a.quote.includes(PAGE_BREAK_SENTINEL)) {
    const startPage = parseInt(rangeMatch[1], 10);
    const endPage = parseInt(rangeMatch[2], 10);
    const [before, after] = a.quote.split(PAGE_BREAK_SENTINEL);
    return [
      { page: startPage, quote: before.trim() },
      { page: endPage, quote: after.trim() },
    ].filter((e) => e.quote.length > 0);
  }
  const pageNum =
    typeof a.page === "number" ? a.page : parseInt(String(a.page), 10);
  if (!Number.isFinite(pageNum)) return [];
  return [{ page: pageNum, quote: a.quote }];
}

/** Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42". */
export function formatCitationPage(a: MikeCitationAnnotation): string {
  if (typeof a.page === "string") return `Page ${a.page}`;
  return `Page ${a.page}`;
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: MikeCitationAnnotation): string {
  return a.quote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}

// Tabular Review

export type ColumnFormat =
    | "text"
    | "bulleted_list"
    | "number"
    | "currency"
    | "yes_no"
    | "date"
    | "tag"
    | "percentage"
    | "monetary_amount";

export interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: ColumnFormat;
    tags?: string[];
}

export interface TabularReview {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  columns_config: ColumnConfig[] | null;
  workflow_id: string | null;
  practice?: string | null;
  /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
  shared_with?: string[];
  /** Server-set: true when the requesting user is the review's creator. */
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  document_count?: number;
}

export interface TabularCell {
  id: string;
  review_id: string;
  document_id: string;
  column_index: number;
  content: {
    summary: string;
    flag?: "green" | "grey" | "yellow" | "red";
    reasoning?: string;
  } | null;
  status: "pending" | "generating" | "done" | "error";
  created_at: string;
}

// Workflows

export interface MikeWorkflow {
  id: string;
  user_id: string | null;
  title: string;
  type: "assistant" | "tabular";
  prompt_md: string | null;
  columns_config: ColumnConfig[] | null;
  is_system: boolean;
  created_at: string;
  practice?: string | null;
  shared_by_name?: string | null;
  allow_edit?: boolean;
  is_owner?: boolean;
}

// API helpers

export interface MikeChatDetailOut {
  chat: MikeChat;
  messages: MikeMessage[];
}

export interface TabularReviewDetailOut {
  review: TabularReview;
  cells: TabularCell[];
  documents: MikeDocument[];
}
