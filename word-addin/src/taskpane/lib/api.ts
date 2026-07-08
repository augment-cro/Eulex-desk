/**
 * Thin API client for the Word add-in. Wraps the backend HTTP surface
 * we actually need from inside Word: streaming chat, project listing,
 * project documents, document upload, chat history, workflows, tabular
 * reviews and the masked AI-keys profile fields used for the model
 * picker.
 *
 * Auth: every call attaches the JWT we received via pairing-code redeem.
 * No requests live outside this module — all backend chatter funnels
 * through the helpers below so swapping the auth header in the future
 * stays a one-liner.
 */

import { API_BASE, apiFetch, authHeader } from "./auth";

export { API_BASE };

// ---------------------------------------------------------------------------
// Chat types
// ---------------------------------------------------------------------------

export interface ApiMessage {
    role: "user" | "assistant" | "system";
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
}

export interface StreamChatPayload {
    messages: ApiMessage[];
    chat_id?: string;
    model?: string;
    files?: { document_id?: string; filename: string }[];
    /** Optional workflow the agent should invoke alongside the message. */
    workflow?: { id: string; title: string };
    /**
     * Where assistant-authored docs land. `"this_word_doc"` asks the
     * agent to write back to the open Word document; `"project"` (default)
     * keeps the original behavior of creating a new project doc.
     */
    creation_mode?: "project" | "this_word_doc";
    /**
     * Selection text in the open Word doc at the time of compose. The
     * agent can use it to scope edits.
     */
    selection?: { text: string; has_selection: boolean };
    /** Edit mode hint for the agent: track changes vs. comments. */
    editMode?: "track" | "comments";
    /**
     * Tells the backend this stream is feeding a Word add-in (not the
     * web UI), so it can inject Office.js-friendly tool-use guidance
     * into the system prompt and echo `editMode` on `doc_edited`
     * events. Always sent as `"word"` from this client.
     */
    client?: "web" | "word";
    signal?: AbortSignal;
}

export interface MikeChat {
    id: string;
    title: string | null;
    created_at: string;
    project_id?: string | null;
}

export interface MikeChatMessage {
    id: string;
    chat_id: string;
    role: string;
    content: string;
    created_at: string;
    annotations?: unknown;
    files?: unknown;
}

export interface MikeChatDetailOut {
    chat: MikeChat;
    messages: MikeChatMessage[];
}

// ---------------------------------------------------------------------------
// Project / document types
// ---------------------------------------------------------------------------

export interface ApiProject {
    id: string;
    name: string;
    cm_number?: string | null;
    created_at?: string;
}

export interface ApiDocument {
    id: string;
    filename: string;
    file_type?: string;
}

export interface ApiProjectDetail extends ApiProject {
    documents?: ApiDocument[];
}

// ---------------------------------------------------------------------------
// Workflow / tabular types
// ---------------------------------------------------------------------------

export interface MikeWorkflow {
    id: string;
    title: string;
    type: "assistant" | "tabular" | string;
    prompt_md?: string | null;
    practice?: string | null;
    columns_config?: { name?: string }[] | null;
    created_at?: string;
    updated_at?: string;
}

export type ApiWorkflow = MikeWorkflow;

export interface ApiTabularReview {
    id: string;
    title: string | null;
    project_id?: string | null;
    document_count?: number | null;
    updated_at?: string | null;
    created_at?: string | null;
}

export interface ApiTabularReviewDetail {
    review: ApiTabularReview & {
        columns_config?: { name?: string }[] | null;
    };
    documents: ApiDocument[];
}

// ---------------------------------------------------------------------------
// AI keys (used by ModelSelector to dim unavailable models)
// ---------------------------------------------------------------------------

export interface AiKeyStatus {
    enabled: boolean;
    /** Truthy when the user has saved a key (the actual value comes back
     *  masked, but presence is enough for UI gating). */
    key: string | null;
}

export interface AiKeysMap {
    anthropic: AiKeyStatus;
    gemini: AiKeyStatus;
    openai: AiKeyStatus;
    mistral: AiKeyStatus;
}

interface UserProfileShape {
    claude_api_key?: string | null;
    gemini_api_key?: string | null;
    openai_api_key?: string | null;
    mistral_api_key?: string | null;
    preferred_language?: string | null;
    display_name?: string | null;
    organisation?: string | null;
}

/**
 * Subset of the user profile the add-in cares about today. We only
 * surface fields used by the UI — extending this is cheap because
 * `/user/profile` returns the full row.
 */
export interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    /** Locale code from the web app (e.g. "en", "hr"). May be null when
     *  the user has never explicitly chosen a language; callers should
     *  fall back to their own default in that case. */
    preferredLanguage: string | null;
}

export async function getUserProfile(): Promise<UserProfile | null> {
    try {
        const res = await apiFetch(`${API_BASE}/user/profile`, {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        });
        if (!res.ok) return null;
        const data = (await res.json()) as UserProfileShape;
        return {
            displayName: data.display_name ?? null,
            organisation: data.organisation ?? null,
            preferredLanguage:
                typeof data.preferred_language === "string"
                    ? data.preferred_language
                    : null,
        };
    } catch {
        return null;
    }
}

export async function updateUserProfile(
    updates: Partial<{
        preferred_language: "en" | "hr";
        display_name: string;
        organisation: string;
    }>,
): Promise<boolean> {
    try {
        const res = await apiFetch(`${API_BASE}/user/profile`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...authHeader(),
            },
            body: JSON.stringify(updates),
        });
        return res.ok;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

export function streamChat(payload: StreamChatPayload): Promise<Response> {
    const { signal, ...body } = payload;
    return apiFetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeader(),
        },
        body: JSON.stringify(body),
        signal,
    });
}

export function streamProjectChat(
    payload: StreamChatPayload & { projectId: string },
): Promise<Response> {
    const { signal, projectId, files, ...rest } = payload;
    // Project chat expects `attached_documents`, not `files` — translate so
    // doc refs surface in the system prompt instead of being silently dropped.
    const body = {
        ...rest,
        attached_documents: files ?? undefined,
    };
    return apiFetch(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/chat`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...authHeader(),
            },
            body: JSON.stringify(body),
            signal,
        },
    );
}

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------

export async function listChats(): Promise<MikeChat[]> {
    const res = await apiFetch(`${API_BASE}/chat`, {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`chat ${res.status}`);
    return (await res.json()) as MikeChat[];
}

export async function getChat(chatId: string): Promise<MikeChatDetailOut> {
    const res = await apiFetch(
        `${API_BASE}/chat/${encodeURIComponent(chatId)}`,
        {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        },
    );
    if (!res.ok) throw new Error(`chat ${res.status}`);
    return (await res.json()) as MikeChatDetailOut;
}

// ---------------------------------------------------------------------------
// Projects + documents
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<ApiProject[]> {
    const res = await apiFetch(`${API_BASE}/projects`, {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`projects ${res.status}`);
    return (await res.json()) as ApiProject[];
}

export async function getProject(projectId: string): Promise<ApiProjectDetail> {
    const res = await apiFetch(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}`,
        {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        },
    );
    if (!res.ok) throw new Error(`project ${res.status}`);
    const data = (await res.json()) as ApiProjectDetail | { project: ApiProjectDetail };
    // Some BE handlers return `{ project, documents }`; flatten if so.
    if ("project" in (data as Record<string, unknown>)) {
        const wrapped = data as { project: ApiProjectDetail; documents?: ApiDocument[] };
        return { ...wrapped.project, documents: wrapped.documents };
    }
    return data as ApiProjectDetail;
}

export async function listProjectDocuments(
    projectId: string,
): Promise<ApiDocument[]> {
    const res = await apiFetch(
        `${API_BASE}/projects/${encodeURIComponent(projectId)}/documents`,
        {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        },
    );
    if (!res.ok) throw new Error(`documents ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data)) return data as ApiDocument[];
    if (Array.isArray(data?.documents)) return data.documents as ApiDocument[];
    return [];
}

/**
 * Upload an in-memory blob (typically the bytes of the open Word document
 * read via Office.js getFileAsync) to a project, or as a standalone
 * document when `projectId` is null.
 */
export async function uploadDocumentBlob(opts: {
    blob: Blob;
    filename: string;
    projectId: string | null;
}): Promise<{ id: string; filename: string }> {
    const form = new FormData();
    form.append("file", opts.blob, opts.filename);
    const url = opts.projectId
        ? `${API_BASE}/projects/${encodeURIComponent(opts.projectId)}/documents`
        : `${API_BASE}/single-documents`;
    const res = await apiFetch(url, {
        method: "POST",
        headers: authHeader(),
        body: form,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `upload ${res.status}`);
    }
    return res.json();
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export async function listWorkflows(
    type?: "assistant" | "tabular",
): Promise<MikeWorkflow[]> {
    const url = new URL(`${API_BASE}/workflows`);
    if (type) url.searchParams.set("type", type);
    const res = await apiFetch(url.toString(), {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`workflows ${res.status}`);
    return (await res.json()) as MikeWorkflow[];
}

export function listAssistantWorkflows(): Promise<MikeWorkflow[]> {
    return listWorkflows("assistant");
}

// ---------------------------------------------------------------------------
// Tabular reviews
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<ApiTabularReview[]> {
    const url = new URL(`${API_BASE}/tabular-review`);
    if (projectId) url.searchParams.set("project_id", projectId);
    const res = await apiFetch(url.toString(), {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`tabular-review ${res.status}`);
    const data = await res.json();
    // BE may return either an array or `{ reviews: [...] }`.
    if (Array.isArray(data)) return data as ApiTabularReview[];
    if (Array.isArray(data?.reviews)) return data.reviews as ApiTabularReview[];
    return [];
}

export async function getTabularReview(
    reviewId: string,
): Promise<ApiTabularReviewDetail> {
    const res = await apiFetch(
        `${API_BASE}/tabular-review/${encodeURIComponent(reviewId)}`,
        {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        },
    );
    if (!res.ok) throw new Error(`tabular-review ${res.status}`);
    const data = await res.json();
    // Normalise. Some BE endpoints return `{ review, documents }`; others
    // return the review at the top level with documents nested.
    if (data?.review) {
        return {
            review: data.review,
            documents: Array.isArray(data.documents) ? data.documents : [],
        };
    }
    return {
        review: data,
        documents: Array.isArray(data?.documents) ? data.documents : [],
    };
}

// ---------------------------------------------------------------------------
// AI keys (derived from /user/profile — keys come back masked, presence
// of any non-null/non-empty string is enough for UI availability).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP servers — Eulex Desk web parity (`McpToggleButton`): built-ins + user rows,
// toggles PATCH `enabled`; backend builds per-request MCP tool lists from flags.
// ---------------------------------------------------------------------------

export interface McpServer {
    id: string;
    slug: string;
    name: string;
    url: string;
    enabled: boolean;
    last_error: string | null;
    auth_type: "headers" | "oauth";
    oauth_authorized: boolean;
}

export interface BuiltinMcpServer {
    slug: string;
    name: string;
    enabled: boolean;
}

export async function listMcpServers(): Promise<McpServer[]> {
    const res = await apiFetch(`${API_BASE}/user/mcp-servers`, {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`mcp-servers ${res.status}`);
    return (await res.json()) as McpServer[];
}

export async function listBuiltinMcpServers(): Promise<BuiltinMcpServer[]> {
    const res = await apiFetch(`${API_BASE}/builtin-mcp-servers`, {
        headers: { Accept: "application/json", ...authHeader() },
        cache: "no-store",
    });
    if (!res.ok) throw new Error(`builtin-mcp-servers ${res.status}`);
    return (await res.json()) as BuiltinMcpServer[];
}

export async function updateBuiltinMcpServer(
    slug: string,
    payload: { enabled: boolean },
): Promise<{ slug: string; enabled: boolean }> {
    const res = await apiFetch(
        `${API_BASE}/builtin-mcp-servers/${encodeURIComponent(slug)}`,
        {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...authHeader(),
            },
            body: JSON.stringify(payload),
        },
    );
    if (!res.ok) throw new Error(`builtin-mcp-servers ${res.status}`);
    return (await res.json()) as { slug: string; enabled: boolean };
}

export async function updateMcpServer(
    id: string,
    payload: { enabled?: boolean },
): Promise<McpServer> {
    const res = await apiFetch(
        `${API_BASE}/user/mcp-servers/${encodeURIComponent(id)}`,
        {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                ...authHeader(),
            },
            body: JSON.stringify(payload),
        },
    );
    if (!res.ok) throw new Error(`mcp-servers ${res.status}`);
    return (await res.json()) as McpServer;
}

export async function getAiKeys(): Promise<AiKeysMap> {
    const empty: AiKeyStatus = { enabled: false, key: null };
    try {
        const res = await apiFetch(`${API_BASE}/user/profile`, {
            headers: { Accept: "application/json", ...authHeader() },
            cache: "no-store",
        });
        if (!res.ok) {
            return {
                anthropic: empty,
                gemini: empty,
                openai: empty,
                mistral: empty,
            };
        }
        const profile = (await res.json()) as UserProfileShape;
        const has = (v: string | null | undefined): AiKeyStatus =>
            v && v.trim().length > 0
                ? { enabled: true, key: v }
                : { enabled: false, key: null };
        return {
            anthropic: has(profile.claude_api_key),
            gemini: has(profile.gemini_api_key),
            openai: has(profile.openai_api_key),
            mistral: has(profile.mistral_api_key),
        };
    } catch {
        return {
            anthropic: empty,
            gemini: empty,
            openai: empty,
            mistral: empty,
        };
    }
}
