/**
 * Generic context-provider client (design §4.2; contract:
 * contracts/context-provider.openapi.json).
 *
 * Optional seam: inert without CONTEXTS_URL (standalone-core rule §2).
 * Context IDs, source IDs, and scope allowlists are OPAQUE to the core —
 * no context schema, retrieval logic, or legal-source semantics here.
 */
import { mintServiceToken } from "./serviceIdentity";
import type { SeamResult } from "./types";

export interface ContextSummary {
    id: string;
    name: string;
    description?: string;
    /** "system" = published by EULEX for every user (read-only). */
    level?: "personal" | "system";
}

export interface ContextResolveSource {
    id: string;
    label?: string;
    url?: string;
    kind?: string;
    tier?: string;
    status?: string;
    issuer?: string;
    published_on?: string;
}

export interface ContextLocalizedText {
    hr?: string;
    en?: string;
}

/**
 * A system context's task (a workflow such as "RT-10 Provjera usklađenosti
 * dokumenta"), as resolve (format 2) serves it. Optional fields are omitted
 * when empty. The core lists the tasks in the system prompt and serves the
 * steps (`prompt_md`) through read_workflow (seams/contextTasks).
 */
export interface ContextTask {
    id: string;
    name: string;
    name_i18n?: ContextLocalizedText;
    summary: string;
    summary_i18n?: ContextLocalizedText;
    when_i18n?: ContextLocalizedText;
    inputs?: { required?: string[]; optional?: string[] };
    checks?: string[];
    output?: { kind: string; name?: string; name_i18n?: ContextLocalizedText };
    done_when?: string[];
    status?: "ready" | "draft";
    prompt_md?: string;
}

export interface ContextResolveResult {
    instructions_md: string;
    sources: ContextResolveSource[];
    scope_allowlist?: string[];
    /** Optional (older providers omit them — treated as personal + strict). */
    name?: string;
    level?: "personal" | "system";
    answer_mode?: "strict" | "extended";
    version_label?: string;
    draft?: boolean;
    /** System contexts only: the model that should answer, and how hard it reasons. */
    model?: string;
    reasoning_effort?: string;
    /** System contexts only (format 2): the context's tasks; absent when none. */
    tasks?: ContextTask[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

function baseUrl(): string | null {
    const url = process.env.CONTEXTS_URL?.trim();
    return url ? url.replace(/\/+$/, "") : null;
}

async function call<T>(
    path: string,
    opts: {
        method?: "GET" | "POST";
        body?: unknown;
        userId: string;
        tenant?: string | null;
        email?: string | null;
        /** The caller's tier grants EULEX system contexts. */
        systemContexts?: boolean;
    },
): Promise<SeamResult<T>> {
    const base = baseUrl();
    if (!base) return { ok: false, error: "CONTEXTS_URL_NOT_SET" };

    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    const token = mintServiceToken(
        "contexts",
        opts.userId,
        opts.tenant ?? null,
        opts.email ?? null,
        { systemContexts: opts.systemContexts === true },
    );
    if (token) headers.authorization = `Bearer ${token}`;

    try {
        const resp = await fetch(`${base}${path}`, {
            method: opts.method ?? "POST",
            headers,
            body:
                (opts.method ?? "POST") === "GET"
                    ? undefined
                    : JSON.stringify(opts.body ?? {}),
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` };
        }
        return { ok: true, data: (await resp.json()) as T };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export const contextsClient = {
    isConfigured(): boolean {
        return baseUrl() !== null;
    },

    /**
     * `systemContexts`: the caller's tier grants EULEX system contexts. Only
     * then does the core ask for them (?system=1) and carry the token claim
     * the provider requires — without it they are neither listed nor
     * resolvable.
     */
    async list(
        userId: string,
        tenant?: string | null,
        email?: string | null,
        opts: { systemContexts?: boolean } = {},
    ): Promise<SeamResult<ContextSummary[]>> {
        // ?system=1: this core understands EULEX system contexts (providers
        // hide them from clients that do not ask).
        return call<ContextSummary[]>(opts.systemContexts ? "/contexts?system=1" : "/contexts", {
            method: "GET",
            userId,
            tenant,
            email,
            systemContexts: opts.systemContexts,
        });
    },

    async resolve(
        contextId: string,
        query: string,
        userId: string,
        tenant?: string | null,
        email?: string | null,
        opts: { systemContexts?: boolean } = {},
    ): Promise<SeamResult<ContextResolveResult>> {
        return call<ContextResolveResult>(
            `/contexts/${encodeURIComponent(contextId)}/resolve`,
            // format 2: this core wraps the blocks in its own precedence
            // header/footer (contextsRuntime.buildContextsSystemBlock).
            {
                method: "POST",
                body: { query, format: 2 },
                userId,
                tenant,
                email,
                systemContexts: opts.systemContexts,
            },
        );
    },
};
