/**
 * Session/analysis lookups against the `mike-pii-shield` sidecar.
 *
 * Since #14 (PII DB split) the backend never touches the `pii_*`
 * tables at the SQL level — the shield owns its schema, so these
 * helpers are thin wrappers over the `piiClient` HTTP lookups. The
 * public API is unchanged: callers still get `null` when a session /
 * cache row doesn't exist (404) or when the shield is unreachable, and
 * fall through to /anonymize (which creates rows idempotently).
 *
 * `getChatPiiMode` stays a direct query — `chats.pii_mode` is a
 * core-owned user preference on a core table, not shield data.
 */

import { getPool } from "../db";
import { piiClient } from "./client";

export interface PiiDocumentAnalysisCache {
    sessionId: string;
    documentVersionId: string;
    status: "pending" | "auto_confirmed" | "awaiting_review" | "confirmed";
    processedText: string | null;
    entitySummary: Record<string, number> | null;
}

/** Resolve (chat_id → pii_session_id) without creating one. Returns
 * null when no active session exists yet. Backend should fall through
 * to /anonymize, which creates the row idempotently. */
export async function getChatSessionId(chatId: string): Promise<string | null> {
    const result = await piiClient.getChatSession(chatId);
    if (!result.ok) {
        // 404 = no session yet (expected); anything else is logged but
        // still resolves to null so callers fall through to /anonymize.
        if (result.status !== 404) {
            console.warn(
                "[pii.session] getChatSessionId sidecar lookup failed:",
                result.error,
            );
        }
        return null;
    }
    return result.data.id;
}

/** Read the cached anonymized text for a (session, document_version)
 * tuple. Avoids re-running the analyzer when nothing has changed. */
export async function getDocumentAnalysisCache(
    sessionId: string,
    documentVersionId: string,
): Promise<PiiDocumentAnalysisCache | null> {
    const result = await piiClient.getDocumentAnalysis(
        sessionId,
        documentVersionId,
    );
    if (!result.ok) {
        if (result.status !== 404) {
            console.warn(
                "[pii.session] getDocumentAnalysisCache sidecar lookup failed:",
                result.error,
            );
        }
        return null;
    }
    return {
        sessionId,
        documentVersionId,
        status: result.data.status as PiiDocumentAnalysisCache["status"],
        processedText: result.data.processed_text_cache,
        entitySummary: result.data.entity_summary,
    };
}

/** Read the chat's PII mode (if any). Returns null when the chat
 * doesn't override the user default — callers should fall back to
 * `getUserPiiPrefs`. */
export async function getChatPiiMode(chatId: string): Promise<string | null> {
    try {
        const pool = await getPool();
        const r = await pool.query<{ pii_mode: string | null }>(
            `SELECT pii_mode FROM public.chats WHERE id = $1 LIMIT 1`,
            [chatId],
        );
        return r.rows[0]?.pii_mode ?? null;
    } catch (err) {
        console.warn(
            "[pii.session] getChatPiiMode failed (column missing?):",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}
