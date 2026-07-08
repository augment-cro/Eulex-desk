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
}

export interface ContextResolveResult {
    instructions_md: string;
    sources: { id: string; label?: string; url?: string }[];
    scope_allowlist?: string[];
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

    async list(
        userId: string,
        tenant?: string | null,
        email?: string | null,
    ): Promise<SeamResult<ContextSummary[]>> {
        return call<ContextSummary[]>("/contexts", {
            method: "GET",
            userId,
            tenant,
            email,
        });
    },

    async resolve(
        contextId: string,
        query: string,
        userId: string,
        tenant?: string | null,
        email?: string | null,
    ): Promise<SeamResult<ContextResolveResult>> {
        return call<ContextResolveResult>(
            `/contexts/${encodeURIComponent(contextId)}/resolve`,
            { method: "POST", body: { query }, userId, tenant, email },
        );
    },
};
