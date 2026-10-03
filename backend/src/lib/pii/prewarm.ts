/**
 * Background pre-warming for newly-uploaded documents.
 *
 * Goal: by the time the user opens a chat that touches a document,
 * the sidecar has already analyzed it and the processed_text_cache is
 * ready. Cuts the perceived latency of the first AI message in half
 * (see plan §11 Gap #15 / R6).
 *
 * Implementation:
 *   - Run as a fire-and-forget task triggered from the upload handler.
 *   - Bounded concurrency (max 3 in flight per process) so a bulk
 *     upload doesn't DDoS the sidecar.
 *   - Cache-aware: skip when an active analysis row already exists.
 *   - Errors are logged but never propagated — failed pre-warm just
 *     means the first chat message pays the analyzer cost itself.
 */

import { analysisKeyFor } from "./analysisKey";
import { piiClient, type PiiMode } from "./client";
import { effectiveMode } from "./gate";
import { getChatPiiMode, getChatSessionId, getDocumentAnalysisCache } from "./session";

const MAX_CONCURRENT = 3;
let inFlight = 0;
const queue: Array<() => Promise<void>> = [];

function runNext(): void {
    while (inFlight < MAX_CONCURRENT && queue.length > 0) {
        const job = queue.shift()!;
        inFlight++;
        job().finally(() => {
            inFlight--;
            runNext();
        });
    }
}

export interface PrewarmArgs {
    userId: string;
    chatId: string;
    documentVersionId: string;
    /** The document text, or a thunk that extracts it. A thunk runs
     *  inside the bounded queue, so extraction cost is gated too. */
    text: string | (() => Promise<string>);
    mode: PiiMode;
    language: "hr" | "en";
}

/**
 * Schedule a document for background anonymization. Returns
 * immediately; the actual work runs once a slot opens up. Callers
 * should not await this for user-facing latency — `await schedule()`
 * blocks only on enqueueing, not on the analyzer call itself.
 */
export async function schedulePrewarm(args: PrewarmArgs): Promise<void> {
    if (!piiClient.isConfigured()) return;

    queue.push(async () => {
        try {
            const text = typeof args.text === "function" ? await args.text() : args.text;
            if (!text.trim()) return;
            // Same key read_document will compute for this text.
            const analysisKey = analysisKeyFor({
                versionId: args.documentVersionId,
                text,
                language: args.language,
            });

            // Skip when an analysis already exists. Cheap DB lookup.
            const sessionId = await getChatSessionId(args.chatId);
            if (sessionId) {
                const cache = await getDocumentAnalysisCache(sessionId, analysisKey);
                if (cache && cache.processedText != null) return;
            }

            const result = await piiClient.anonymize({
                text,
                userId: args.userId,
                mode: args.mode,
                language: args.language,
                chatId: args.chatId,
                documentVersionId: args.documentVersionId,
                analysisKey,
                source: "document",
            });
            if (!result.ok) {
                console.warn(
                    "[pii.prewarm] /anonymize failed:",
                    result.error,
                    result.status ? `(status ${result.status})` : "",
                );
            }
        } catch (err) {
            console.warn(
                "[pii.prewarm] unexpected error:",
                err instanceof Error ? err.message : err,
            );
        }
    });

    runNext();
}

// ----------------------------------------------------------------------- //
//  Upload hook                                                            //
// ----------------------------------------------------------------------- //

export interface PrewarmUploadArgs {
    userId: string;
    /** The chat the composer uploaded into (multipart `chat_id`). */
    chatId: string;
    documentVersionId: string;
    fileType: string | null;
    bytes: Buffer;
    /** Version storage path — enables the persisted PDF OCR cache. */
    storagePath: string | null;
    language: "hr" | "en";
    /** `res.locals.tierLevelId`; undefined skips the entitlement gate, as
     *  the chat route does. */
    tierLevelId?: number | null;
    db: ReturnType<typeof import("../supabase").createServerSupabase>;
}

/**
 * Pre-anonymize a document the chat composer just uploaded, so the first
 * `read_document` of the turn is a cache lookup instead of a full
 * Presidio run. Called fire-and-forget from the upload handler; every
 * failure is logged and swallowed.
 *
 * Only `standard` mode is pre-warmed: `strict` runs the review preview on
 * the same document right after upload (which writes the same cache), and
 * `off` needs nothing. The chat must belong to the uploader — a stray
 * `chat_id` never seeds another user's session.
 *
 * PDFs are skipped: their text comes from Gemini OCR (~35 s, paid), the
 * read path has its own persisted OCR cache, and a user who sends within
 * that window would trigger a second OCR of the same file. E-mails
 * (eml/msg) are skipped for the same reason — their PDF attachments are
 * OCR'd too. DOCX/DOC/TXT extraction is local and cheap, and it runs
 * inside the prewarm queue so a bulk upload never fans out unbounded.
 */
export async function prewarmUploadedDocument(args: PrewarmUploadArgs): Promise<void> {
    if (!piiClient.isConfigured()) return;
    const fileType = (args.fileType ?? "").toLowerCase();
    if (fileType === "pdf" || fileType === "eml" || fileType === "msg") return;
    try {
        const { data: chat } = await args.db
            .from("chats")
            .select("id")
            .eq("id", args.chatId)
            .eq("user_id", args.userId)
            .maybeSingle();
        if (!chat) return;

        const { getUserApiKeys, getUserModelSettings } = await import("../userSettings");
        const mode = effectiveMode(
            await getChatPiiMode(args.chatId),
            await getUserModelSettings(args.userId, args.db),
        );
        if (mode !== "standard") return;

        if (typeof args.tierLevelId === "number") {
            const { getEntitlements, can } = await import("../entitlements");
            if (!can(await getEntitlements(args.tierLevelId), "piiAnonymization")) return;
        }

        const geminiApiKey = (await getUserApiKeys(args.userId, args.db)).gemini;
        await schedulePrewarm({
            userId: args.userId,
            chatId: args.chatId,
            documentVersionId: args.documentVersionId,
            // Same flavor as read_document, so the cached text (and its
            // key) is byte-identical to what an inline read produces.
            text: async () => {
                const { extractDocumentText } = await import("../documentText");
                return extractDocumentText({
                    fileType: args.fileType,
                    bytes: args.bytes,
                    flavor: "plain",
                    geminiApiKey,
                    storagePath: args.storagePath,
                });
            },
            mode,
            language: args.language,
        });
    } catch (err) {
        console.warn(
            "[pii.prewarm] upload hook failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
}
