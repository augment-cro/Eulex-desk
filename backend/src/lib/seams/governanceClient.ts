/**
 * Governance per-turn clients (contracts: pre-inference-hook.openapi.json,
 * prompt-pack.openapi.json POST /enrich).
 *
 * Optional seam: inert without GOVERNANCE_URL (standalone-core rule). Both
 * calls are per-user (sub `desk-<userId>`), unlike the system-level pack
 * fetch in promptPack.ts. Verdicts and classification are OPAQUE to the
 * core — no legal-scope or classification semantics here.
 *
 * Failure posture:
 *  - /pre-inference: fail-OPEN by default (a seam hiccup never blocks a
 *    turn); GOVERNANCE_FAIL_MODE=closed makes the caller refuse the turn.
 *  - /enrich: always passthrough on failure (the caller returns the
 *    original query).
 */
import { mintServiceToken } from "./serviceIdentity";
import type { SeamResult } from "./types";

export interface PreInferenceResult {
    prompt_blocks?: string[];
    /** Opaque JSON — the core never interprets it, only relays/logs it. */
    classification?: unknown;
    gate?: { action: "proceed" | "block" | "notify"; message_md?: string };
    directives?: Record<string, unknown>;
}

// Pre-inference sits on the hot path of every chat turn — keep the budget
// tight so a slow governance service degrades to fail-open, not to latency.
const PRE_INFERENCE_TIMEOUT_MS = 2_000;
// Enrichment runs an LLM pass server-side; it gets an interactive budget.
const ENRICH_TIMEOUT_MS = 30_000;

function baseUrl(): string | null {
    const url = process.env.GOVERNANCE_URL?.trim();
    return url ? url.replace(/\/+$/, "") : null;
}

async function call<T>(
    path: string,
    body: unknown,
    userId: string,
    timeoutMs: number,
): Promise<SeamResult<T>> {
    const base = baseUrl();
    if (!base) return { ok: false, error: "GOVERNANCE_URL_NOT_SET" };

    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    const token = mintServiceToken("governance", userId);
    if (token) headers.authorization = `Bearer ${token}`;

    try {
        const resp = await fetch(`${base}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(timeoutMs),
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

export const governanceClient = {
    isConfigured(): boolean {
        return baseUrl() !== null;
    },

    /** Contract default is fail-open; only the literal "closed" flips it. */
    failMode(): "open" | "closed" {
        return process.env.GOVERNANCE_FAIL_MODE?.trim().toLowerCase() === "closed"
            ? "closed"
            : "open";
    },

    async preInference(args: {
        query: string;
        meta: {
            chat_id: string | null;
            user_id: string;
            locale: string;
            client: string;
        };
    }): Promise<SeamResult<PreInferenceResult>> {
        return call<PreInferenceResult>(
            "/pre-inference",
            { query: args.query, meta: args.meta },
            args.meta.user_id,
            PRE_INFERENCE_TIMEOUT_MS,
        );
    },

    async enrich(
        query: string,
        locale: "hr" | "en",
        userId: string,
    ): Promise<SeamResult<{ enriched: string }>> {
        return call<{ enriched: string }>(
            "/enrich",
            { query, locale },
            userId,
            ENRICH_TIMEOUT_MS,
        );
    },
};
