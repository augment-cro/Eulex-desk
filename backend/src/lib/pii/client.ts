/**
 * HTTP client for the `mike-pii-shield` sidecar.
 *
 * Authentication
 * ==============
 *  - On Cloud Run (`PII_SHIELD_URL` matches `https://*.run.app`) we
 *    fetch a fresh OIDC ID-token from the metadata server using the
 *    sidecar URL as the `audience`. Cloud Run validates the token and
 *    grants traffic when the calling service account has
 *    `roles/run.invoker`.
 *  - Anywhere else (local dev, docker-compose, port-forward) we send
 *    no auth header — the sidecar's `--ingress=internal` flag is the
 *    network boundary in production, and dev relies on localhost.
 *
 * Failure semantics
 * =================
 * All public methods return a discriminated-union `Result` so callers
 * can pick fail-open vs fail-closed semantics per mode without having
 * to wrap every call in try/catch (plan §11 Gap #18 / R9 retry
 * strategy).
 */

import {
    PII_OPEN,
    PII_CLOSE,
    PII_SENTINEL_OPEN,
    containsPlaceholder,
} from "./placeholders";

// ----------------------------------------------------------------------- //
//  Public types                                                           //
// ----------------------------------------------------------------------- //

export type PiiMode = "standard" | "strict_legal" | "strict";

export interface PiiEntity {
    placeholder: string;
    entity_type: string;
    start: number;
    end: number;
    score: number;
    original_text: string;
}

export interface AnonymizeResult {
    session_id: string;
    anonymized_text: string;
    entities: PiiEntity[];
    entity_summary: Record<string, number>;
}

export interface DeanonymizeResult {
    restored_text: string;
    hallucinated_placeholders: string[];
}

export interface MergeDocumentResult {
    merged_placeholders: { old: string; new: string }[];
    processed_text: string;
    entity_summary: Record<string, number>;
}

export interface ApplyOverridesResult {
    pii_processed_text: string | null;
    entity_summary: Record<string, number>;
}

export interface SessionMeta {
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

/** `GET /sessions/by-chat/{chat_id}` — lookup-only session metadata
 * (no entity summary: the shield never decrypts mappings for this). */
export interface SessionLookup {
    id: string;
    chat_id: string | null;
    user_id: string;
    mode: PiiMode;
    engine_version: string;
    engine_compat_class: "safe" | "breaking";
    status: "active" | "expired" | "deleted";
    expires_at: string | null;
}

/** `GET /sessions/{id}/analysis/{document_version_id}` — one
 * `pii_document_analyses` row, owned by the shield since #14. */
export interface AnalysisLookup {
    id: string;
    session_id: string;
    document_version_id: string;
    status: string;
    entity_summary: Record<string, number> | null;
    processed_text_cache: string | null;
}

export type Result<T> =
    | { ok: true; data: T }
    | { ok: false; error: string; status?: number };

// ----------------------------------------------------------------------- //
//  Configuration                                                           //
// ----------------------------------------------------------------------- //

function sidecarUrl(): string | null {
    const url = process.env.PII_SHIELD_URL?.trim();
    return url ? url.replace(/\/+$/, "") : null;
}

function needsOidc(url: string): boolean {
    // Cloud Run service URLs always live under `.run.app`. We also
    // detect `https://` URLs explicitly so `http://localhost:8081`
    // skips OIDC even when PII_SHIELD_URL is set.
    return /\.run\.app(\/|$)/i.test(url) || /eulex\.ai/i.test(url);
}

// ----------------------------------------------------------------------- //
//  OIDC token cache (per-process)                                          //
// ----------------------------------------------------------------------- //

interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

async function getOidcToken(audience: string): Promise<string | null> {
    const now = Date.now();
    const cached = tokenCache.get(audience);
    if (cached && cached.expiresAt - now > 60_000) return cached.token;

    const metadataUrl =
        "http://metadata.google.internal/computeMetadata/v1/instance/" +
        "service-accounts/default/identity?audience=" +
        encodeURIComponent(audience);
    try {
        const resp = await fetch(metadataUrl, {
            headers: { "Metadata-Flavor": "Google" },
            // Metadata server should answer in <50ms; fail fast.
            signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) {
            console.warn(
                "[pii.client] OIDC token fetch failed:",
                resp.status,
                await resp.text().catch(() => ""),
            );
            return null;
        }
        const token = (await resp.text()).trim();
        // OIDC tokens are 1h scoped; cache for 50min.
        tokenCache.set(audience, { token, expiresAt: now + 50 * 60_000 });
        return token;
    } catch (err) {
        // Local dev: no metadata server. Caller falls back to no-auth.
        return null;
    }
}

// ----------------------------------------------------------------------- //
//  HTTP plumbing                                                          //
// ----------------------------------------------------------------------- //

const DEFAULT_TIMEOUT_MS = 15_000;

async function call<T>(
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; method?: string } = {},
): Promise<Result<T>> {
    const base = sidecarUrl();
    if (!base) {
        return { ok: false, error: "PII_SHIELD_URL_NOT_SET" };
    }
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (needsOidc(base)) {
        const token = await getOidcToken(base);
        if (token) headers.authorization = `Bearer ${token}`;
    }
    try {
        const resp = await fetch(url, {
            method: opts.method ?? "POST",
            headers,
            body: opts.method === "GET" ? undefined : JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return {
                ok: false,
                status: resp.status,
                error: text || `HTTP ${resp.status}`,
            };
        }
        const data = (await resp.json()) as T;
        return { ok: true, data };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg };
    }
}

// ----------------------------------------------------------------------- //
//  High-level API                                                         //
// ----------------------------------------------------------------------- //

export interface AnonymizeArgs {
    text: string;
    userId: string;
    mode: PiiMode;
    language: "hr" | "en";
    chatId?: string | null;
    sessionId?: string | null;
    documentVersionId?: string | null;
    source?: "document" | "user_input" | "tool_result";
}

export const piiClient = {
    /**
     * True when the env-var is wired up. Callers that depend on the
     * sidecar should consult this first so they can bypass the call
     * entirely in environments where PII Shield is not deployed.
     */
    isConfigured(): boolean {
        return sidecarUrl() !== null;
    },

    async anonymize(args: AnonymizeArgs): Promise<Result<AnonymizeResult>> {
        return call<AnonymizeResult>("/anonymize", {
            text: args.text,
            language: args.language,
            mode: args.mode,
            source: args.source,
            session_id: args.sessionId ?? undefined,
            chat_id: args.chatId ?? undefined,
            user_id: args.userId,
            document_version_id: args.documentVersionId ?? undefined,
        });
    },

    async deanonymize(args: {
        sessionId: string;
        text: string;
        mode?: PiiMode;
    }): Promise<Result<DeanonymizeResult>> {
        // Cheap shortcut — don't round-trip when there's nothing to do.
        if (!containsPlaceholder(args.text)) {
            return {
                ok: true,
                data: { restored_text: args.text, hallucinated_placeholders: [] },
            };
        }
        return call<DeanonymizeResult>("/deanonymize", {
            session_id: args.sessionId,
            text: args.text,
            mode: args.mode,
        });
    },

    async deanonymizeJson(
        sessionId: string,
        data: unknown,
    ): Promise<Result<unknown>> {
        const res = await call<{ data: unknown }>(
            `/sessions/${sessionId}/deanonymize-json`,
            { data },
        );
        if (!res.ok) return res;
        return { ok: true, data: res.data.data };
    },

    async applyOverrides(args: {
        sessionId: string;
        maskedPlaceholders: string[];
        approvedForDisclosure: string[];
        text?: string;
    }): Promise<Result<ApplyOverridesResult>> {
        return call<ApplyOverridesResult>(
            `/sessions/${args.sessionId}/apply-overrides`,
            {
                masked_placeholders: args.maskedPlaceholders,
                approved_for_disclosure: args.approvedForDisclosure,
                text: args.text,
            },
        );
    },

    async mergeDocument(args: {
        chatSessionId: string;
        sourceSessionId: string;
        documentVersionId: string;
    }): Promise<Result<MergeDocumentResult>> {
        return call<MergeDocumentResult>(
            `/sessions/${args.chatSessionId}/merge-document`,
            {
                source_session_id: args.sourceSessionId,
                document_version_id: args.documentVersionId,
            },
        );
    },

    async render(args: {
        sessionId: string;
        text: string;
    }): Promise<Result<DeanonymizeResult>> {
        if (!containsPlaceholder(args.text)) {
            return {
                ok: true,
                data: { restored_text: args.text, hallucinated_placeholders: [] },
            };
        }
        return call<DeanonymizeResult>("/render", {
            session_id: args.sessionId,
            text: args.text,
        });
    },

    async getSession(sessionId: string): Promise<Result<SessionMeta>> {
        return call<SessionMeta>(`/sessions/${sessionId}`, null, { method: "GET" });
    },

    /** Resolve (chat_id → ACTIVE session) without creating one. 404
     * (`ok: false, status: 404`) when the chat has no session yet —
     * callers fall through to /anonymize which creates it. */
    async getChatSession(chatId: string): Promise<Result<SessionLookup>> {
        return call<SessionLookup>(`/sessions/by-chat/${chatId}`, null, {
            method: "GET",
        });
    },

    /** Cached analysis row for a (session, document_version) tuple.
     * 404 when the pre-warm never ran — callers re-analyze inline. */
    async getDocumentAnalysis(
        sessionId: string,
        documentVersionId: string,
    ): Promise<Result<AnalysisLookup>> {
        return call<AnalysisLookup>(
            `/sessions/${sessionId}/analysis/${documentVersionId}`,
            null,
            { method: "GET" },
        );
    },

    async getVersion(): Promise<
        Result<{
            engine_version: string;
            engine_compat_class: "safe" | "breaking";
            recognizers: string[];
        }>
    > {
        return call("/version", null, { method: "GET", timeoutMs: 2000 });
    },
};

// Re-export sentinel constants for callers that detect placeholders
// without importing the placeholders module.
export { PII_OPEN, PII_CLOSE, PII_SENTINEL_OPEN, containsPlaceholder };
