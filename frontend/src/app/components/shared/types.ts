// Shared TypeScript types for Eulex Desk AI legal assistant

import { formatSheetCell } from "@/app/lib/spreadsheetAddress";

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
  file_type: string | null; // pdf | docx | doc | txt | xlsx | xlsm | xls | csv
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
  // Sidebar history management (backend migration 132). 'deleted' chats
  // are never sent to the client, so status is a two-value union here.
  group_id: string | null;
  pinned: boolean;
  status: "active" | "archived";
}

export interface MikeChatGroup {
  id: string;
  name: string;
  status: "active" | "archived";
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

/** One step of the plan the model keeps while it applies a task or workflow. */
export interface PlanStep {
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  note?: string;
}

/** A status of an assessment finding (🔴 🟡 🔵 ⚪ 🟢). */
export type AssessmentStatus = "material" | "gap" | "legal" | "insufficient" | "ok";

export interface AssessmentEvidence {
  doc_id: string;
  document_id?: string;
  filename?: string;
  quote: string;
  page?: string;
}

export interface AssessmentFinding {
  id: string;
  check_id?: string;
  requirement: string;
  category: string;
  applicability: string;
  applicable_from?: string;
  practice?: string;
  evidence: AssessmentEvidence[];
  evidence_weight: string;
  verification: string;
  method?: string;
  status: AssessmentStatus;
  action?: string;
  owner_role?: string;
  due?: string;
  due_kind?: string;
  closure_criterion: string;
  closed_by?: { version: number; evidence: AssessmentEvidence[] };
}

export interface AssessmentFact {
  id: string;
  use_case_id?: string;
  statement: string;
  value?: string;
  /** user_asserted · document_supported · observed · inferred · unknown · conflicting */
  status: string;
  evidence: AssessmentEvidence[];
}

/** A decision of the record: a classification, or (id CHK-…) one answered Checker question. */
export interface AssessmentDecision {
  id: string;
  use_case_id: string;
  topic: string;
  classification: string | null;
  limitation?: string;
  reasoning: string;
  legal_sources: string[];
  fact_ids: string[];
}

/** One version of a context task's assessment record (record_assessment). */
export interface AssessmentSnapshot {
  assessment_id: string;
  version: number;
  recorded_at: string;
  title: string;
  task_id: string | null;
  facts_as_of: string | null;
  sources_checked_at: string | null;
  context: { id: string; version_label?: string } | null;
  /** The task's workflow, to continue it. */
  workflow: { id: string; title: string } | null;
  facts: AssessmentFact[];
  decisions: AssessmentDecision[];
  findings: AssessmentFinding[];
  unread_documents: string[];
  source_conflicts: string[];
  warning: "STOP" | "REVIEW" | "STANDARD" | null;
  superseded: string[];
  counts: Record<AssessmentStatus, number>;
  total: number;
  changes?: {
    from_version: number;
    closed: string[];
    added: string[];
    changed: string[];
    superseded: string[];
  };
}

/** Something of an active context that an answer ran without. */
export interface ContextUnavailable {
  kind: "context" | "document";
  name: string;
  /** The context id (kind "context" only). */
  id?: string;
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
        /** The whole plan as the model last published it (update_plan);
         *  the latest one of a message is shown as the PLAN card. */
        type: "plan_updated";
        steps: PlanStep[];
    }
  | {
        /** A version of an assessment record; the latest of a message is
         *  shown as the REZULTAT card. */
        type: "assessment_recorded";
        assessment: AssessmentSnapshot;
    }
  | {
        /** Contexts that took part in the answer (shown under it; a system
         *  context also brings its disclaimer). */
        type: "contexts_applied";
        contexts: {
            id: string;
            name: string;
            level: "personal" | "system";
            version_label?: string;
        }[];
        /** Present when a system context chose the model / reasoning effort. */
        model?: string;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
        /** What the answer ran without: a context that failed to load (no
         *  name — named from the user's list by `id`) or a context
         *  document. Absent when everything loaded. */
        unavailable?: ContextUnavailable[];
    }
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
  | {
        /**
         * Post-answer resolution of every article reference in the prose
         * (backend lib/legalRefs, tracker #45): which harvested source each
         * regex span points at, keyed by article number + occurrence so the
         * frontend can find the same span. Present only on turns answered
         * after 2026-09-19; older messages fall back to the local linker.
         */
        type: "legal_refs";
        refs: LegalRefItem[];
        /** References the regex missed (act-only mentions, missed article
         *  numbers), found by the model and verified server-side. Absent on
         *  turns answered before 2026-09-24. */
        extra?: LegalRefExtra[];
        model: string | null;
        isStreaming?: boolean;
    }
  | { type: "content"; text: string; isStreaming?: boolean };

export type LegalRefStatus = "linked" | "unverified" | "unresolved";

/** Mirror of backend `LegalRefExtra` (lib/legalRefs.ts). Anchored by the
 *  exact `text` and its occurrence in the joined raw answer. */
export interface LegalRefExtra {
  text: string;
  occurrence: number;
  start: number;
  kind: "article" | "act";
  number: string | null;
  source_id: string | null;
  status: "linked" | "unverified";
  by: "model" | "lookup";
  act?: string | null;
}

export interface LegalRefItem {
  /** Exact regex span in the answer ("članka 8"). */
  text: string;
  /** Normalized article number ("8", "17a"). */
  number: string;
  /** 0-based occurrence of that number among the answer's references. */
  occurrence: number;
  source_id: string | null;
  status: LegalRefStatus;
  by: "regex" | "model" | "lookup" | "none";
  act?: string | null;
}

/**
 * Unified legal-source citation shape for the legal MCP servers
 * (EU/EUR-Lex, Croatian, French, Slovenian, German). Built backend-side by
 * `harvestLegalSources`.
 */
export interface LegalSource {
  /** Stable id a citation references (national scopes: own id, EU "@eu/celex/…"). */
  id: string;
  scope: "@eu" | "@hr" | "@fr" | "@si" | "@de";
  title: string;
  citation?: string | null;
  /** Cited passage text harvested from the tool output (best effort). */
  snippet?: string | null;
  /** Public canonical URL: eur-lex / narodne-novine / legifrance / pisrs /
   *  gesetze-im-internet. */
  externalUrl?: string | null;
  articleLabel?: string | null;
  /** The act on its own, as the source server names it (EULEX
   *  `document.title`: "Zakon o trgovini"), separate from the composed
   *  `title` ("Zakon o trgovini, čl. 8 — Heading"). Absent on messages
   *  persisted before 2026-09-19 — `actTitleOf` then derives it from `title`. */
  documentTitle?: string | null;
  /** In-app fetch path for the full document (Phase 2 proxy). */
  fetchPath?: string | null;
  /** EU only — drives the /legal-docs/eu/{celex} proxy. */
  celex?: string | null;
  inForce?: boolean | null;
  /** Source class: statute/regulation (default) vs court decision. */
  kind?: "regulation" | "caselaw";
  /** Caselaw only — the court's case number ("Revr 123/2019"). */
  caseNumber?: string | null;
  /** Caselaw only — ECLI identifier parsed from the citation. */
  ecli?: string | null;
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
  /**
   * PII preview session created BEFORE the chat existed (strict-mode
   * review on the fresh assistant page, #16 follow-up). `handleNewChat`
   * attaches it to the freshly created chat via `piiAttachChat` so the
   * turn's anonymization reuses the reviewed session (and the user's
   * disclosure approvals) instead of spawning a new one. Never sent to
   * the chat message API itself.
   */
  piiSessionId?: string;
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

/**
 * One passage to highlight in a viewer. Paged documents (PDF, DOCX, TXT)
 * carry a 1-based `page` hint; spreadsheet citations carry `sheet` + `cell`
 * instead and have no page.
 */
export interface CitationQuote {
  page?: number;
  quote: string;
  /** Spreadsheet citations: the sheet name. */
  sheet?: string;
  /** Spreadsheet citations: an A1 address or range ("C2", "A214:B214"). */
  cell?: string;
}

/**
 * A citation emitted by the assistant. Single-page citations have a numeric
 * `page` and a plain `quote`. A citation that spans a page break (one
 * continuous sentence cut by a page boundary) has `page` as a range string
 * like "41-42" and a `quote` containing the `[[PAGE_BREAK]]` sentinel at the
 * break point (text before is on page 41, text after is on page 42).
 *
 * Spreadsheet citations have no page: they carry `sheet` and `cell` (an A1
 * address or range) instead.
 */
export interface MikeCitationAnnotation {
  type: "citation_data";
  ref: number;
  doc_id: string;
  document_id: string;
  version_id?: string | null;
  version_number?: number | null;
  filename: string;
  page?: number | string | null;
  sheet?: string | null;
  cell?: string | null;
  quote: string;
  /** The cited document belongs to an active EULEX context (cyan pill). */
  context?: boolean;
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
 * One stop on a regulation's version timeline (`/legal-docs/versions`).
 * HR: one entry per NN objava across the regulation's whole lineage,
 * chronological (oldest first).
 */
export interface LegalDocumentVersion {
  /** regulation_versions.id — sent back as `version_id` to view this text. */
  id: string;
  /** Owning regulation id — may differ from the cited regulation when the
   *  law is fragmented across legacy rows (lineage). */
  regulationId: string;
  versionNumber: number | null;
  /** not_in_force | in_force | future */
  status: string | null;
  enterIntoForce: string | null;
  applicationDate: string | null;
  endDate: string | null;
  /** "NN 64/2023" — the gazette issue that introduced this version. */
  nnReference: string | null;
  eliUrl: string | null;
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

/** Whether a citation points at a spreadsheet cell rather than a page. */
export function isSpreadsheetCitation(a: {
  sheet?: string | null;
  cell?: string | null;
}): boolean {
  return Boolean(a.sheet || a.cell);
}

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 * A spreadsheet citation yields one (sheet, cell, quote) entry.
 */
export function expandCitationToEntries(
  a: MikeCitationAnnotation,
): CitationQuote[] {
  if (isSpreadsheetCitation(a)) {
    return [
      {
        quote: a.quote,
        ...(a.sheet ? { sheet: a.sheet } : {}),
        ...(a.cell ? { cell: a.cell } : {}),
      },
    ];
  }
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

/**
 * Format where a citation points: the page through `pageLabel`, which the
 * caller localizes (common.pageShort — "str. 3", "p. 41-42"), or — for a
 * spreadsheet citation — the Excel-style reference "Ugovori!C2". Empty when
 * the citation names no page.
 */
export function formatCitationLocation(
  a: MikeCitationAnnotation,
  pageLabel: (page: string) => string,
): string {
  if (isSpreadsheetCitation(a)) return formatSheetCell(a.sheet, a.cell);
  if (a.page === null || a.page === undefined || a.page === "") return "";
  return pageLabel(String(a.page));
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
    /**
     * Citation verification (tracker #22) — set at generation time when at
     * least one [[page:N||quote:…]] / [[sheet:S||cell:A1||quote:…]] marker
     * could not be located in the document text. `unverified_citations` holds marker ordinals per field,
     * in the order the badges render. Absent on older cells.
     */
    unverified?: boolean;
    unverified_citations?: { summary?: number[]; reasoning?: number[] };
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
