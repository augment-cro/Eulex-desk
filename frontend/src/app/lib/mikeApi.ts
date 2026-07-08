/**
 * Eulex Desk API client — all requests to the Node.js backend.
 * Attaches the OAuth JWT token for user authentication.
 */

import {
    getStoredTokens,
    getValidAccessToken,
    refreshAccessToken,
    clearTokens,
} from "@/lib/oauth";
import {
    pushFromResponseHeaders,
    pushFromRateLimitedError,
} from "./rateLimitStore";
import type {
    AssistantEvent,
    LegalDocument,
    LegalSource,
    MikeAnnotation,
    MikeChat,
    MikeChatDetailOut,
    MikeDocument,
    MikeFolder,
    MikeMessage,
    MikeProject,
    MikeWorkflow,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    annotations?: MikeAnnotation[] | null;
    is_flagged?: boolean | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: MikeChat;
    messages: ServerMessage[];
}

// `??` only coalesces on null/undefined — a blank env var (which happened
// once when the Dockerfile exported `ENV NEXT_PUBLIC_API_BASE_URL=` even
// without a build-arg) would slip through and make API_BASE = "", which
// silently routed every backend call to the frontend origin and surfaced
// as 404 page-not-found HTML for /chat, /user/profile, /auth/pair/start.
// Treat whitespace-only values as unset too.
const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

function getAuthHeader(): Record<string, string> {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) return {};
    return { Authorization: `Bearer ${tokens.access_token}` };
}

/** Sent to the API so LLM prompts match the active Next.js UI locale (en | hr).
 *
 * Reads `<html lang>` first (set by `next-intl` on every server render from
 * the resolved locale, including the default when no NEXT_LOCALE cookie is
 * present). Falls back to the cookie. The cookie alone is NOT enough: if
 * the user is on the default locale (`hr`) and has never clicked the
 * LanguageSwitcher, the cookie is unset → backend silently defaults to
 * `en` → every LLM-facing endpoint (column suggester, chat, …) gets a
 * mismatched locale and replies in English. */
function getUiLocaleHeader(): Record<string, string> {
    if (typeof document === "undefined") return {};
    // Normalize to the base language subtag, so region variants next-intl may
    // emit (`hr-HR`, `en-US`) still resolve to "hr"/"en" instead of silently
    // falling through to the backend's English default.
    const base = (v?: string | null) =>
        (v ?? "").trim().toLowerCase().split("-")[0];
    const fromHtml = base(document.documentElement.lang);
    if (fromHtml === "hr" || fromHtml === "en") {
        return { "X-UI-Locale": fromHtml };
    }
    const m = document.cookie.match(/(?:^|; )NEXT_LOCALE=([^;]*)/);
    const code = base(m?.[1] ? decodeURIComponent(m[1]) : "");
    if (code === "hr" || code === "en") return { "X-UI-Locale": code };
    return {};
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = getAuthHeader();
    const localeHeaders = getUiLocaleHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};

    let response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...localeHeaders,
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });
    pushFromResponseHeaders(response);

    // Auto-refresh on 401, retry once. Previously gated on
    // body.code === "TOKEN_EXPIRED" — but Cloud Run revision swaps and
    // proxy blips produce 401s WITHOUT that code (sometimes without a
    // JSON body at all), and those failed with no retry: a burst of
    // dead /user/profile and /chat calls right after every deploy. Any
    // 401 now gets one token refresh + retry; the forced re-login stays
    // reserved for genuinely expired sessions, so a transient blip can
    // no longer log the user out.
    if (response.status === 401) {
        let tokenExpired = !authHeaders.Authorization;
        try {
            const body = await response.clone().json();
            if (body?.code === "TOKEN_EXPIRED") tokenExpired = true;
        } catch {
            /* non-JSON 401 body — still refresh + retry below */
        }
        const refreshed = await refreshAccessToken().catch(() => null);
        if (refreshed) {
            response = await fetch(`${API_BASE}${path}`, {
                cache: "no-store",
                ...restInit,
                headers: {
                    Accept: "application/json",
                    ...localeHeaders,
                    Authorization: `Bearer ${refreshed.access_token}`,
                    ...(initHeaders as Record<string, string> | undefined),
                },
            });
            pushFromResponseHeaders(response);
        } else if (tokenExpired) {
            // Refresh failed AND the session is genuinely gone — force
            // re-login. Unknown transient 401s fall through to the
            // regular error path instead of nuking the session.
            clearTokens();
            if (typeof window !== "undefined") {
                window.location.href = "/login";
            }
            throw new Error("Session expired. Please sign in again.");
        }
    }

    if (!response.ok) {
        // Surface 429 body to the rate-limit banner (headers may be
        // partial when the limiter returned without enriching them).
        if (response.status === 429) {
            try {
                const cloned = response.clone();
                const body = await cloned.json();
                if (body?.code === "RATE_LIMITED") {
                    pushFromRateLimitedError(body);
                }
            } catch {
                /* non-JSON body — banner stays as-is */
            }
        }
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Word add-in pairing
// ---------------------------------------------------------------------------

export interface PairingCode {
    code: string;
    expires_at: string;
    ttl_seconds: number;
}

export async function startPairingCode(): Promise<PairingCode> {
    return apiRequest<PairingCode>("/auth/pair/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

// ---------------------------------------------------------------------------
// Teams (Team tier)
// ---------------------------------------------------------------------------

export type TeamRole = "owner" | "admin" | "member";
export type TeamMemberStatus = "invited" | "active" | "removed";

export interface TeamMember {
    id: string;
    email: string;
    role: TeamRole;
    status: TeamMemberStatus;
    userId: string | null;
    displayName: string | null;
    invitedAt: string;
    joinedAt: string | null;
}

export interface Team {
    id: string;
    name: string;
    ownerUserId: string;
    seats: number;
    seatsUsed: number;
    role: TeamRole;
    isOwner: boolean;
    members: TeamMember[];
}

/** The caller's team (owner or member), or `{ team: null }` if none. */
export async function getMyTeam(): Promise<{ team: Team | null }> {
    return apiRequest<{ team: Team | null }>("/teams/mine");
}

/** Add/invite a colleague by email. Owner/admin only. */
export async function addTeamMember(
    teamId: string,
    email: string,
): Promise<{ member: TeamMember }> {
    return apiRequest<{ member: TeamMember }>(
        `/teams/${teamId}/members`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email }),
        },
    );
}

/** Remove a member (frees a seat). Owner/admin only; owner can't be removed. */
export async function removeTeamMember(
    teamId: string,
    memberId: string,
): Promise<void> {
    await apiRequest<void>(`/teams/${teamId}/members/${memberId}`, {
        method: "DELETE",
    });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<MikeProject[]> {
    return apiRequest<MikeProject[]>("/projects");
}

export async function createProject(
    name: string,
    cm_number?: string,
    shared_with?: string[],
): Promise<MikeProject> {
    return apiRequest<MikeProject>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cm_number, shared_with }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

/**
 * Open a Stripe Customer Portal session (invoices, payment method, plan
 * changes — Stripe-hosted). 404 with code NO_STRIPE_CUSTOMER when the
 * user never started a checkout; callers hide the button in that case.
 */
export async function createBillingPortalSession(): Promise<{ url: string }> {
    return apiRequest<{ url: string }>("/billing/portal", { method: "POST" });
}

export async function getProject(projectId: string): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        shared_with?: string[];
    },
): Promise<MikeProject> {
    return apiRequest<MikeProject>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<MikeFolder> {
    return apiRequest<MikeFolder>(
        `/projects/${projectId}/folders/${folderId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface MikeDocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    display_name: string | null;
}

export async function listDocumentVersions(
    documentId: string,
): Promise<{
    current_version_id: string | null;
    versions: MikeDocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    displayName?: string,
): Promise<MikeDocumentVersion> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (displayName) form.append("display_name", displayName);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocumentVersion>;
}

/**
 * Minimalni shape `document_edits` retka koji backend vraća iz GET
 * /single-documents/:id/edits — držimo ga uskim namjerno, jer ga
 * SuperDoc bubble panel koristi samo za mapping ↔ tracked changes.
 */
export interface MikeDocumentEditRow {
    id: string;
    version_id: string;
    change_id: string;
    del_w_id: string | null;
    ins_w_id: string | null;
    deleted_text: string | null;
    inserted_text: string | null;
    status: "pending" | "accepted" | "rejected";
    created_at: string;
}

export async function listDocumentEdits(
    documentId: string,
    status: "pending" | "all" = "pending",
): Promise<MikeDocumentEditRow[]> {
    const data = await apiRequest<{ edits: MikeDocumentEditRow[] }>(
        `/single-documents/${documentId}/edits?status=${status}`,
    );
    return data.edits ?? [];
}

export async function resolveDocumentEdit(
    documentId: string,
    editId: string,
    decision: "accept" | "reject",
): Promise<{
    ok: boolean;
    already_resolved?: boolean;
    status?: "accepted" | "rejected";
    version_id: string | null;
    download_url: string | null;
    remaining_pending?: number;
}> {
    return apiRequest(
        `/single-documents/${documentId}/edits/${editId}/${decision}`,
        { method: "POST" },
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    displayName: string | null,
): Promise<MikeDocumentVersion> {
    return apiRequest<MikeDocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: displayName }),
        },
    );
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<MikeDocument> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/documents`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocument>;
}

export async function uploadStandaloneDocument(
    file: File,
): Promise<MikeDocument> {
    const authHeaders = getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_BASE}/single-documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<MikeDocument>;
}

export async function listStandaloneDocuments(): Promise<MikeDocument[]> {
    return apiRequest<MikeDocument[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

/** Must stay in sync with `MAX_ZIP_DOCUMENTS` in backend `documents.ts`. */
export const MAX_ZIP_DOWNLOAD_DOCUMENTS = 50;

export class ZipDocumentLimitError extends Error {
    readonly max: number;

    constructor(max: number) {
        super("ZIP_DOCUMENT_LIMIT");
        this.name = "ZipDocumentLimitError";
        this.max = max;
    }
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    const authHeaders = getAuthHeader();
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders,
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const text = await response.text();
        let body: unknown;
        try {
            body = JSON.parse(text) as unknown;
        } catch {
            body = null;
        }
        if (
            body !== null &&
            typeof body === "object" &&
            (body as { code?: unknown }).code === "ZIP_DOCUMENT_LIMIT"
        ) {
            const rawMax = (body as { max_documents?: unknown }).max_documents;
            if (typeof rawMax === "number" && Number.isFinite(rawMax))
                throw new ZipDocumentLimitError(rawMax);
        }
        throw new Error(
            (body !== null &&
            typeof body === "object" &&
            typeof (body as { detail?: unknown }).detail === "string"
                ? String((body as { detail: string }).detail).trim()
                : text.trim()) ||
                `API error: ${response.status}`,
        );
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(): Promise<MikeChat[]> {
    // Request the backend max (500) instead of the default 100 so users with
    // long histories — including chats backfilled from the old WordPress
    // assistant — see all their conversations. The sidebar has no pagination;
    // 500 covers every current user (max ~294).
    return apiRequest<MikeChat[]>("/chat?limit=500");
}

export async function listProjectChats(projectId: string): Promise<MikeChat[]> {
    return apiRequest<MikeChat[]>(`/projects/${projectId}/chats`);
}

/**
 * Fetch the full text of a legal source (EU/HR/FR) via the backend proxy,
 * normalized to `{ title, articles[] }`. Returns null when the source has no
 * fetch path. Throws on network/proxy errors (caller falls back to snippet).
 */
export async function getLegalDocument(
    source: LegalSource,
): Promise<LegalDocument | null> {
    if (!source.fetchPath) return null;
    const qs = `?scope=${encodeURIComponent(source.scope)}&path=${encodeURIComponent(source.fetchPath)}`;
    return apiRequest<LegalDocument>(`/legal-docs${qs}`);
}

export async function getChat(chatId: string): Promise<MikeChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: MikeMessage[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            id: m.id,
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
            flagged: !!m.is_flagged,
        };
    });
    return { chat: raw.chat, messages };
}

/**
 * Toggle the "not appropriate answer" flag on an assistant message.
 * Returns the new flag state so the caller can sync local UI without a
 * full chat refetch.
 */
export async function setMessageFlag(
    messageId: string,
    flagged: boolean,
    reason?: string,
): Promise<{ id: string; is_flagged: boolean; flagged_at: string | null }> {
    return apiRequest<{
        id: string;
        is_flagged: boolean;
        flagged_at: string | null;
    }>(`/chat/messages/${messageId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagged, reason }),
    });
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Chat sharing (email-bound invites — backend/routes/chatShares.ts)
// ---------------------------------------------------------------------------

export interface ChatShare {
    id: string;
    shared_with_email: string;
    created_at: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
}

export interface ShareChatResponse {
    sent: string[];
    failures: { email: string; reason: string }[];
    shares: ChatShare[];
}

export async function shareChat(
    chatId: string,
    payload: { emails: string[] },
): Promise<ShareChatResponse> {
    return apiRequest<ShareChatResponse>(`/chat/${chatId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listChatShares(chatId: string): Promise<ChatShare[]> {
    return apiRequest<ChatShare[]>(`/chat/${chatId}/shares`);
}

export async function deleteChatShare(
    chatId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/chat/${chatId}/shares/${shareId}`, { method: "DELETE" });
}

export interface SharedChatDetail {
    mode: "snapshot" | "live";
    chat: MikeChat;
    /**
     * Server returns raw chat_messages rows — the share page renders
     * them through the same mapping as `getChat()` for visual parity.
     */
    messages: ServerMessage[];
    shared_at: string;
    expires_at: string;
    accepted_at: string | null;
    owner: {
        display_name: string | null;
        email: string | null;
    };
    redirect_to: string;
}

export interface SharedChatView {
    mode: "snapshot" | "live";
    chat: MikeChat;
    messages: MikeMessage[];
    shared_at: string;
    expires_at: string;
    accepted_at: string | null;
    owner: { display_name: string | null; email: string | null };
    redirect_to: string;
}

/** Mirrors `getChat()`'s ServerMessage → MikeMessage normalization. */
function mapServerMessages(serverMessages: ServerMessage[]): MikeMessage[] {
    return serverMessages.map((m) => {
        if (m.role === "user") {
            return {
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            annotations: m.annotations ?? undefined,
            events,
        };
    });
}

export async function getSharedChat(token: string): Promise<SharedChatView> {
    const raw = await apiRequest<SharedChatDetail>(
        `/share/${encodeURIComponent(token)}`,
    );
    return {
        ...raw,
        messages: mapServerMessages(raw.messages),
    };
}

/**
 * PUBLIC teaser for a share link — shown before sign-in. Mirrors the
 * backend `GET /share/:token/preview`: first question + a truncated start
 * of the first answer only. No auth required (works logged-out).
 */
export interface SharedChatPreview {
    mode: "preview";
    title: string | null;
    owner_name: string | null;
    question: string | null;
    answer_excerpt: string | null;
    answer_truncated: boolean;
    total_messages: number;
    expires_at: string;
}

export async function getSharedChatPreview(
    token: string,
): Promise<SharedChatPreview> {
    return apiRequest<SharedChatPreview>(
        `/share/${encodeURIComponent(token)}/preview`,
    );
}

export async function acceptSharedChat(
    token: string,
): Promise<{ chat_id: string; project_id: string | null; redirect_to: string }> {
    return apiRequest(`/share/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
    });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

// ---------------------------------------------------------------------------
// Query Enrichment ("Poboljšaj pitanje")
// ---------------------------------------------------------------------------

export interface EnrichedQuery {
    query: string;
    /** One-sentence explanation of what makes this variant better (UI label). */
    why: string;
}

export interface QueryEnrichmentResult {
    /** Plain string array — backward compat. */
    improved_queries: string[];
    /** Richer variant array with per-query `why` explanation. */
    improved_queries_rich: EnrichedQuery[];
}

export async function enrichQuery(
    query: string,
    options?: { locale?: string; documentNames?: string[] },
): Promise<QueryEnrichmentResult> {
    return apiRequest<QueryEnrichmentResult>("/chat/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            query,
            locale: options?.locale,
            document_names: options?.documentNames ?? [],
        }),
    });
}

/**
 * Streaming version of enrichQuery.
 * Yields two event types from the SSE stream:
 *   { type: "delta",   index: number, text: string }  — query text chunk
 *   { type: "variant", index: number, variant: EnrichedQuery } — full card
 */
export type EnrichStreamEvent =
    | { type: "delta"; index: number; text: string }
    | { type: "variant"; index: number; variant: EnrichedQuery };

export async function* streamEnrichQuery(
    query: string,
    options?: { locale?: string; documentNames?: string[] },
    signal?: AbortSignal,
): AsyncGenerator<EnrichStreamEvent> {
    const response = await fetch(`${API_BASE}/chat/enrich`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            ...getUiLocaleHeader(),
            ...getAuthHeader(),
        },
        body: JSON.stringify({
            query,
            locale: options?.locale,
            document_names: options?.documentNames ?? [],
        }),
        signal,
        cache: "no-store",
    });

    if (!response.ok || !response.body) {
        throw new Error(`Enrich stream failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete last line

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (!payload) continue;
            try {
                const event = JSON.parse(payload) as {
                    type: string;
                    index?: number;
                    text?: string;
                    variant?: EnrichedQuery;
                };
                if (event.type === "done") return;
                if (event.type === "delta" && typeof event.text === "string") {
                    yield { type: "delta", index: event.index ?? 0, text: event.text };
                } else if (event.type === "variant" && event.variant?.query) {
                    yield { type: "variant", index: event.index ?? 0, variant: event.variant };
                }
            } catch { /* malformed event — skip */ }
        }
    }
}

async function streamFetch(
    url: string,
    init: RequestInit,
): Promise<Response> {
    const response = await fetch(url, init);
    pushFromResponseHeaders(response);
    if (response.status === 429) {
        try {
            const body = await response.clone().json();
            if (body?.code === "RATE_LIMITED") {
                pushFromRateLimitedError(body);
            }
        } catch {
            /* ignore */
        }
    }
    return response;
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: { filename: string; document_id?: string }[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    /** "low" | "medium" | "high" — reasoning intensity for this turn. */
    effort?: string;
    /** Composer web-search toggle (globe icon). Omit/true = on. */
    web_search?: boolean;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    const authHeaders = getAuthHeader();
    return streamFetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    /** "low" | "medium" | "high" — reasoning intensity for this turn. */
    effort?: string;
    /** Composer web-search toggle (globe icon). Omit/true = on. */
    web_search?: boolean;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    const authHeaders = getAuthHeader();
    return streamFetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
): Promise<TabularReview[]> {
    const qs = projectId
        ? `?project_id=${encodeURIComponent(projectId)}`
        : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`);
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "llm" }> {
    return apiRequest<{
        prompt: string;
        source: "llm";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export type AiColumnDraft = {
    name: string;
    prompt: string;
    format: string;
    tags?: string[];
};

export type AiColumnSuggesterEvent =
    | {
          type: "status";
          phase: "thinking" | "searching" | "applying";
          message?: string;
      }
    | {
          type: "web_search_started";
          query: string;
          provider: string;
      }
    | {
          type: "web_search_result";
          provider: string;
          query: string;
          results: Array<{
              title: string;
              url: string;
              snippet: string;
              published_date?: string | null;
          }>;
          error?: string | null;
      }
    | { type: "clarify"; question: string }
    | {
          type: "result";
          columns: AiColumnDraft[];
          explanation?: string | null;
      }
    | { type: "error"; message: string }
    | { type: "done" };

/**
 * SSE-streaming variant of the column suggester. The backend emits a
 * sequence of `status` / `web_search_*` events and ends with EXACTLY
 * one of `result` (apply the new columns) or `clarify` (surface a
 * follow-up question to the user), followed by `done`.
 *
 * Caller passes an `onEvent` callback for live UI updates and an
 * optional `signal` to cancel an in-flight request.
 */
export async function streamSuggestTabularColumnsWithAi(args: {
    reviewId: string;
    instruction: string;
    columns_config: unknown[];
    onEvent: (event: AiColumnSuggesterEvent) => void;
    signal?: AbortSignal;
}): Promise<void> {
    const { reviewId, instruction, columns_config, onEvent, signal } = args;
    const authHeaders = getAuthHeader();
    const res = await fetch(`${API_BASE}/tabular-review/ai-suggest-columns`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify({
            review_id: reviewId,
            instruction,
            columns_config,
        }),
        signal,
    });
    if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        throw new Error(
            `ai-suggest-columns failed (${res.status}): ${txt.slice(0, 300)}`,
        );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line. Split on \n\n,
        // keep the last (possibly incomplete) chunk in `buf` for the
        // next iteration.
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
            const rawEvent = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLine = rawEvent
                .split("\n")
                .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
                const event = JSON.parse(payload) as AiColumnSuggesterEvent;
                onEvent(event);
            } catch (err) {
                console.warn(
                    "[streamSuggestTabularColumnsWithAi] invalid JSON",
                    err,
                    payload.slice(0, 200),
                );
            }
        }
    }
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<MikeDocument> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeaders = getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { ...getUiLocaleHeader(), ...authHeaders },
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    const authHeaders = getAuthHeader();
    return streamFetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...getUiLocaleHeader(),
            ...authHeaders,
        },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    documentId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            document_id: documentId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    documentIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_ids: documentIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = MikeWorkflow["type"];

export async function listWorkflows(
    type: WorkflowType,
): Promise<MikeWorkflow[]> {
    return apiRequest<MikeWorkflow[]>(`/workflows?type=${type}`);
}

/**
 * Built-in workflow packs, re-served by the backend from the governance
 * prompt-pack cache. Returns [] when no pack is configured (standalone
 * core) — callers render an empty built-ins section, never an error.
 */
export async function listBuiltinWorkflows(): Promise<MikeWorkflow[]> {
    return apiRequest<MikeWorkflow[]>("/workflows/builtin");
}

export async function getWorkflow(workflowId: string): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    title: string;
    type: "assistant" | "tabular";
    prompt_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    practice?: string | null;
}): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        title?: string;
        prompt_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        practice?: string | null;
    },
): Promise<MikeWorkflow> {
    return apiRequest<MikeWorkflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function refineWorkflowWithAi(
    workflowId: string,
    instruction: string,
): Promise<{
    title: string;
    type: string;
    prompt_md: string;
    columns_config: unknown[];
}> {
    return apiRequest(`/workflows/ai-refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId, instruction }),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(
    workflowId: string,
): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

// ---------------------------------------------------------------------------
// Custom Contexts
//
// Split client: context CONTENT (CRUD, sources, shares, alerts history,
// create-from-chat) lives in an external contexts service the browser calls
// DIRECTLY — base URL from NEXT_PUBLIC_CONTEXTS_URL, auth via a short-TTL
// service token minted by the core (GET /service-token/contexts). The core
// keeps only the generic runtime (toggles, attach links, badge counts),
// which stays on apiRequest. With NEXT_PUBLIC_CONTEXTS_URL unset the whole
// feature is dormant: list calls resolve empty and the UI hides itself.
// ---------------------------------------------------------------------------

function contextsServiceUrl(): string {
    return (process.env.NEXT_PUBLIC_CONTEXTS_URL ?? "")
        .trim()
        .replace(/\/+$/, "");
}

/** Whether a contexts service is configured (drives all contexts UI). */
export function contextsServiceEnabled(): boolean {
    return contextsServiceUrl().length > 0;
}

let contextsServiceToken: { token: string; expiresAt: number } | null = null;

async function getContextsServiceToken(force = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (
        !force &&
        contextsServiceToken &&
        contextsServiceToken.expiresAt - now > 60
    ) {
        return contextsServiceToken.token;
    }
    const res = await apiRequest<{ token: string; expires_in: number | null }>(
        "/service-token/contexts",
    );
    contextsServiceToken = {
        token: res.token,
        expiresAt: now + (res.expires_in ?? 3600),
    };
    return res.token;
}

/**
 * Request against the contexts service's management API. Mirrors
 * apiRequest's error shaping (throw with the response body text) so shared
 * error helpers keep working; retries once with a fresh service token on a
 * 401 (token expiry).
 */
async function contextsRequest<T>(
    path: string,
    init?: RequestInit,
): Promise<T> {
    if (!contextsServiceEnabled()) {
        throw new Error("Contexts service is not configured");
    }
    const { headers: initHeaders, ...restInit } = init ?? {};
    const doFetch = (token: string) =>
        fetch(`${contextsServiceUrl()}/manage/contexts${path}`, {
            cache: "no-store",
            ...restInit,
            headers: {
                Accept: "application/json",
                ...getUiLocaleHeader(),
                Authorization: `Bearer ${token}`,
                ...(initHeaders as Record<string, string> | undefined),
            },
        });

    let response = await doFetch(await getContextsServiceToken());
    if (response.status === 401) {
        response = await doFetch(await getContextsServiceToken(true));
    }
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }
    return (await response.json()) as T;
}

export type ContextVisibility = "private" | "shared" | "team";
export type ContextSourceKind =
    | "legal_instrument"
    | "legal_article"
    | "caselaw"
    | "web";
export type ContextSourceMode = "pinned" | "retrieved";

export interface MikeContext {
    id: string;
    owner_user_id: string;
    team_id: string | null;
    name: string;
    description: string | null;
    instructions_md: string | null;
    alerts_enabled: boolean;
    visibility: ContextVisibility;
    version: number;
    created_at: string;
    updated_at: string;
}

export interface MikeContextListItem {
    context: MikeContext;
    isOwner: boolean;
    allowEdit: boolean;
}

export interface MikeContextSource {
    id: string;
    context_id: string;
    kind: ContextSourceKind;
    ref: string;
    mode: ContextSourceMode;
    retrieval_note: string | null;
    sync_state: string | null;
    label: string | null;
    citation: string | null;
    added_from: string;
    position: number;
    tracked_for_alerts: boolean;
}

export interface MikeContextShare {
    context_id: string;
    shared_with_email: string;
    allow_edit: boolean;
}

export interface MikeContextToggle {
    contextId: string;
    enabled: boolean;
}

export function listContexts(): Promise<MikeContextListItem[]> {
    // Dormant feature → empty list without a network call.
    if (!contextsServiceEnabled()) return Promise.resolve([]);
    return contextsRequest<MikeContextListItem[]>("");
}

export function createContext(input: {
    name: string;
    description?: string;
    instructions_md?: string;
    visibility?: ContextVisibility;
}): Promise<MikeContext> {
    return contextsRequest<MikeContext>("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export function getContext(
    id: string,
): Promise<MikeContext & { isOwner: boolean; allowEdit: boolean }> {
    return contextsRequest(`/${id}`);
}

export function updateContext(
    id: string,
    patch: Partial<
        Pick<
            MikeContext,
            | "name"
            | "description"
            | "instructions_md"
            | "visibility"
            | "alerts_enabled"
        >
    >,
): Promise<MikeContext> {
    return contextsRequest<MikeContext>(`/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
}

export function deleteContext(id: string): Promise<void> {
    return contextsRequest(`/${id}`, { method: "DELETE" });
}

export function listContextSources(id: string): Promise<MikeContextSource[]> {
    return contextsRequest(`/${id}/sources`);
}

export function addContextSource(
    id: string,
    input: {
        kind: ContextSourceKind;
        ref: string;
        mode: ContextSourceMode;
        retrieval_note?: string;
        label?: string;
        citation?: string;
    },
): Promise<MikeContextSource> {
    return contextsRequest(`/${id}/sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export function updateContextSource(
    id: string,
    sourceId: string,
    patch: {
        mode?: ContextSourceMode;
        retrieval_note?: string;
        tracked_for_alerts?: boolean;
    },
): Promise<MikeContextSource> {
    return contextsRequest(`/${id}/sources/${sourceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
}

export function removeContextSource(
    id: string,
    sourceId: string,
): Promise<void> {
    return contextsRequest(`/${id}/sources/${sourceId}`, {
        method: "DELETE",
    });
}

export function listContextShares(id: string): Promise<MikeContextShare[]> {
    return contextsRequest(`/${id}/shares`);
}

export function shareContext(
    id: string,
    email: string,
    allowEdit: boolean,
): Promise<{ ok: boolean }> {
    return contextsRequest(`/${id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, allow_edit: allowEdit }),
    });
}

export function unshareContext(id: string, email: string): Promise<void> {
    return contextsRequest(`/${id}/shares`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
    });
}

export function listContextToggles(): Promise<MikeContextToggle[]> {
    return apiRequest(`/contexts/toggles`);
}

export function setContextToggle(
    id: string,
    enabled: boolean,
): Promise<{ ok: boolean }> {
    return apiRequest(`/contexts/toggles/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

export interface MikeContextAlertEvent {
    id: string;
    context_id: string;
    context_name: string;
    source_id: string;
    change_type: string;
    summary: string;
    detected_at: string;
}

export function listContextAlerts(
    id: string,
): Promise<MikeContextAlertEvent[]> {
    return contextsRequest(`/${id}/alerts`);
}

export function listContextAlertCounts(): Promise<
    { contextId: string; count: number }[]
> {
    return apiRequest(`/contexts/alert-counts`);
}

// --- Attach links (Plan 5) -------------------------------------------------
// A context attached to a workflow/project joins that run's active set; the
// backend re-checks access per requester, so attaching never widens access.

export interface MikeContextLinks {
    workflows: string[];
    projects: string[];
}

export function listContextLinks(id: string): Promise<MikeContextLinks> {
    return apiRequest(`/contexts/${id}/links`);
}

export function attachContextToWorkflow(
    id: string,
    workflowId: string,
): Promise<{ ok: boolean }> {
    return apiRequest(`/contexts/${id}/workflows/${workflowId}`, {
        method: "POST",
    });
}

export function detachContextFromWorkflow(
    id: string,
    workflowId: string,
): Promise<void> {
    return apiRequest(`/contexts/${id}/workflows/${workflowId}`, {
        method: "DELETE",
    });
}

export function attachContextToProject(
    id: string,
    projectId: string,
): Promise<{ ok: boolean }> {
    return apiRequest(`/contexts/${id}/projects/${projectId}`, {
        method: "POST",
    });
}

export function detachContextFromProject(
    id: string,
    projectId: string,
): Promise<void> {
    return apiRequest(`/contexts/${id}/projects/${projectId}`, {
        method: "DELETE",
    });
}

export interface NewContextSourceInput {
    kind: ContextSourceKind;
    ref: string;
    mode: ContextSourceMode;
    retrieval_note?: string;
    label?: string;
    citation?: string;
}

/**
 * Create a context from a chat: the backend validates everything up front,
 * auto-drafts instructions_md from the transcript with a low-tier model, then
 * creates the context + sources in one shot. The caller should let the user
 * review/edit the drafted instructions afterwards.
 */
export function createContextFromChat(input: {
    name: string;
    transcript: string;
    sources: NewContextSourceInput[];
}): Promise<{ context: MikeContext; sources: MikeContextSource[] }> {
    return contextsRequest(`/from-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export interface McpServer {
    id: string;
    slug: string;
    name: string;
    url: string;
    header_keys: string[];
    enabled: boolean;
    last_error: string | null;
    auth_type: "headers" | "oauth";
    oauth_authorized: boolean;
    created_at: string;
    updated_at: string;
}

export interface McpServerTestResult {
    ok: boolean;
    tool_count?: number;
    tools?: { name: string; description: string }[];
    error?: string;
}

export async function listMcpServers(): Promise<McpServer[]> {
    return apiRequest<McpServer[]>("/user/mcp-servers");
}

export interface BuiltinMcpServer {
    slug: string;
    name: string;
    enabled: boolean;
}

export async function listBuiltinMcpServers(): Promise<BuiltinMcpServer[]> {
    return apiRequest<BuiltinMcpServer[]>("/builtin-mcp-servers");
}

/**
 * Toggle a built-in (server-side) MCP connector for the current user.
 * Built-ins default to enabled; this writes only the deviation. The
 * change applies to the next chat request.
 */
export async function updateBuiltinMcpServer(
    slug: string,
    payload: { enabled: boolean },
): Promise<{ slug: string; enabled: boolean }> {
    return apiRequest<{ slug: string; enabled: boolean }>(
        `/builtin-mcp-servers/${encodeURIComponent(slug)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function createMcpServer(payload: {
    name: string;
    url: string;
    slug?: string;
    headers?: Record<string, string>;
    enabled?: boolean;
    auth_type?: "headers" | "oauth";
}): Promise<McpServer> {
    return apiRequest<McpServer>("/user/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function startMcpOauth(
    id: string,
): Promise<{ authorize_url: string | null; already_authorized?: boolean }> {
    return apiRequest(`/user/mcp-servers/${id}/oauth/start`, {
        method: "POST",
    });
}

export async function updateMcpServer(
    id: string,
    payload: {
        name?: string;
        url?: string;
        headers?: Record<string, string>;
        enabled?: boolean;
    },
): Promise<McpServer> {
    return apiRequest<McpServer>(`/user/mcp-servers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteMcpServer(id: string): Promise<void> {
    await apiRequest(`/user/mcp-servers/${id}`, { method: "DELETE" });
}

/**
 * Wipes all OAuth state (DCR registration, tokens, code verifier) for a
 * connector. Use when the auth server has forgotten the client (e.g. after
 * a server-side registry reset) and the cached client_id is stuck — calling
 * this and then `startMcpOauth` forces a fresh discovery + DCR + sign-in.
 */
export async function resetMcpOauth(id: string): Promise<void> {
    await apiRequest(`/user/mcp-servers/${id}/reauth`, { method: "POST" });
}

export async function testMcpServer(id: string): Promise<McpServerTestResult> {
    return apiRequest<McpServerTestResult>(`/user/mcp-servers/${id}/test`, {
        method: "POST",
    });
}

// ─────────────────────────────────────────────────────────────────────
// File-source connectors (Google Drive / OneDrive / Box).
// Backend: backend/src/routes/integrations.ts
// ─────────────────────────────────────────────────────────────────────

export const INTEGRATION_PROVIDER_IDS = [
    "google_drive",
    "onedrive",
    "box",
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDER_IDS)[number];

export interface IntegrationProviderStatus {
    id: IntegrationProviderId;
    display_name: string;
    /** Operator wired the env-var credentials for this provider. */
    configured: boolean;
    /** This user has authorized the connector. */
    connected: boolean;
    account_email: string | null;
    account_name: string | null;
    expires_at: string | null;
}

export interface IntegrationFile {
    id: string;
    name: string;
    mime_type: string;
    size_bytes: number | null;
    modified_at: string | null;
    revision: string | null;
    web_url: string | null;
    parent: string | null;
}

export interface IntegrationFileListing {
    files: IntegrationFile[];
    next_page_token: string | null;
}

export async function listIntegrations(): Promise<{
    providers: IntegrationProviderStatus[];
}> {
    return apiRequest<{ providers: IntegrationProviderStatus[] }>(
        "/integrations",
    );
}

export async function startIntegrationOAuth(
    provider: IntegrationProviderId,
): Promise<{ authorize_url: string }> {
    return apiRequest<{ authorize_url: string }>(
        `/integrations/${provider}/oauth/start`,
        { method: "POST" },
    );
}

export async function disconnectIntegration(
    provider: IntegrationProviderId,
): Promise<void> {
    await apiRequest(`/integrations/${provider}`, { method: "DELETE" });
}

export async function listIntegrationFiles(
    provider: IntegrationProviderId,
    opts: { q?: string; page_token?: string; page_size?: number } = {},
): Promise<IntegrationFileListing> {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.page_token) params.set("page_token", opts.page_token);
    if (opts.page_size) params.set("page_size", String(opts.page_size));
    const qs = params.toString();
    return apiRequest<IntegrationFileListing>(
        `/integrations/${provider}/files${qs ? `?${qs}` : ""}`,
    );
}

export async function importIntegrationFile(
    provider: IntegrationProviderId,
    file_id: string,
    project_id: string | null,
): Promise<MikeDocument> {
    return apiRequest<MikeDocument>(`/integrations/${provider}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id, project_id }),
    });
}

export interface GoogleDrivePickerToken {
    access_token: string;
    app_id: string;
    developer_key: string | null;
}

/**
 * Fetch a short-lived OAuth token (+ the app/project number) for the
 * Google Drive Picker iframe. The token is auto-refreshed server-side
 * if it's within 60s of expiry.
 */
export async function getGoogleDrivePickerToken(): Promise<GoogleDrivePickerToken> {
    return apiRequest<GoogleDrivePickerToken>(
        "/integrations/google_drive/picker_token",
    );
}

// ---------------------------------------------------------------------------
// PII Shield (frontend ↔ /pii proxy in the backend)
// ---------------------------------------------------------------------------

export type PiiMode = "off" | "standard" | "strict_legal" | "strict";

export interface PiiEntity {
    placeholder: string;
    entity_type: string;
    start: number;
    end: number;
    score: number;
    original_text: string;
}

export interface PiiPreviewResult {
    session_id: string;
    entities: PiiEntity[];
    entity_summary: Record<string, number>;
    preview_text: string;
}

export interface PiiSessionMeta {
    id: string;
    chat_id: string | null;
    user_id: string;
    mode: PiiMode;
    engine_version: string;
    engine_compat_class: "safe" | "breaking";
    status: "active" | "expired" | "deleted";
    expires_at: string | null;
    entity_summary: Record<string, number>;
    total_entities: number;
}

export interface PiiRenderResult {
    rendered_text: string;
    hallucinated_placeholders: string[];
}

export interface PiiApplyOverridesResult {
    pii_processed_text: string | null;
    entity_summary: Record<string, number>;
}

/**
 * Run a document through the shield for the review modal. Returns the
 * preview text + an entity list the modal renders as a diff. Idempotent
 * per (chat_id, document_version_id): re-calling refines the existing
 * pii_sessions row in place.
 */
export async function piiPreviewDocument(args: {
    chat_id?: string | null;
    document_version_id: string;
    text: string;
    mode?: Exclude<PiiMode, "off">;
    language?: "hr" | "en";
}): Promise<PiiPreviewResult> {
    return apiRequest<PiiPreviewResult>("/pii/sessions/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
    });
}

/**
 * Run a stored document through the shield by id. Backend resolves
 * the current version, downloads + extracts text server-side, then
 * calls the sidecar. The browser never sees the raw text — only the
 * masked preview + entity list for the review modal.
 *
 * Use this from the chat composer after a successful upload. The
 * sister-route `piiPreviewDocument` takes raw text and is reserved
 * for callers that already have the cleaned string in memory.
 */
export interface PiiDocumentPreviewResult extends PiiPreviewResult {
    document_version_id: string;
    filename: string;
}

export async function piiPreviewDocumentById(
    documentId: string,
    args: {
        chat_id?: string | null;
        mode?: Exclude<PiiMode, "off">;
        language?: "hr" | "en";
    } = {},
): Promise<PiiDocumentPreviewResult> {
    return apiRequest<PiiDocumentPreviewResult>(
        `/pii/documents/${documentId}/preview`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
        },
    );
}

/**
 * Persist the user's modal choices. `masked_placeholders` is the list
 * of placeholders the user wants to KEEP masked, `approved_for_disclosure`
 * is the list they explicitly want to reveal. Both lists are audited.
 */
export async function piiApplyOverrides(args: {
    session_id: string;
    masked_placeholders: string[];
    approved_for_disclosure: string[];
    text?: string;
}): Promise<PiiApplyOverridesResult> {
    const { session_id, ...body } = args;
    return apiRequest<PiiApplyOverridesResult>(
        `/pii/sessions/${session_id}/apply-overrides`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
}

/**
 * Render an assistant message that contains placeholders. Used by the
 * lazy renderer in `AssistantMessage` so the browser only learns the
 * originals when the user looks at the message.
 */
export async function piiRender(
    session_id: string,
    text: string,
): Promise<PiiRenderResult> {
    return apiRequest<PiiRenderResult>(`/pii/sessions/${session_id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
}

/** Reveal one specific placeholder (audited). Used by the message-level
 * disclosure menu. */
export async function piiDisclose(
    session_id: string,
    placeholder: string,
    reason?: string,
): Promise<{ placeholder: string; original: string }> {
    return apiRequest(`/pii/sessions/${session_id}/disclose-placeholder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeholder, reason }),
    });
}

/** Session meta (entity summary, expiry, engine version). The badge in
 * the composer polls this to show "12 PII hidden". */
export async function piiSessionMeta(
    session_id: string,
): Promise<PiiSessionMeta> {
    return apiRequest<PiiSessionMeta>(`/pii/sessions/${session_id}`);
}

/** Resolve `chat.id → pii_sessions.id` without forcing anonymisation.
 *  Returns `{ session_id: null }` if no session exists yet (e.g. chat
 *  without any PII-triggering documents). The frontend uses this to
 *  drive `usePiiRenderedText` so assistant messages with placeholders
 *  get de-anonymised in the browser. */
export async function piiSessionByChatId(
    chat_id: string,
): Promise<{ session_id: string | null }> {
    return apiRequest<{ session_id: string | null }>(
        `/pii/chats/${chat_id}/session-id`,
    );
}

/** Sidecar engine version. Used at app boot to detect a stale
 * `engine_compat_class` and trigger a "refresh required" banner. */
export async function piiVersion(): Promise<{
    configured: boolean;
    ok?: boolean;
    engine_version?: string;
    engine_compat_class?: "safe" | "breaking";
}> {
    return apiRequest("/pii/version");
}

// ---------------------------------------------------------------------------
// Draft Mode — selection-based inline editing
// ---------------------------------------------------------------------------

export interface DraftEditAnnotation {
    kind: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    version_number: number | null;
    change_id: string;
    del_w_id: string | null;
    ins_w_id: string | null;
    deleted_text: string;
    inserted_text: string;
    context_before: string;
    context_after: string;
    reason?: string;
    status: "pending";
}

export interface DraftSelectionEditResult {
    ok: true;
    document_id: string;
    filename: string;
    version_id: string;
    version_number: number;
    download_url: string;
    annotations: DraftEditAnnotation[];
    errors: { index: number; reason: string }[];
}

/**
 * Submit a Draft Mode inline edit. The backend asks the LLM for a precise
 * {find, replace, reason} JSON from the given selected_text + instruction,
 * then applies it as a tracked change (w:ins / w:del) via applyTrackedEdits.
 *
 * @param signal Optional AbortSignal so the caller can cancel in-flight requests.
 */
export async function draftSelectionEdit(
    params: {
        document_id: string;
        selected_text: string;
        context_before?: string;
        context_after?: string;
        instruction: string;
    },
    signal?: AbortSignal,
): Promise<DraftSelectionEditResult> {
    const authHeaders = getAuthHeader();
    const localeHeaders = getUiLocaleHeader();
    const response = await fetch(`${API_BASE}/draft/selection-edit`, {
        method: "POST",
        cache: "no-store",
        signal,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...localeHeaders,
            ...authHeaders,
        },
        body: JSON.stringify(params),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    return response.json() as Promise<DraftSelectionEditResult>;
}
