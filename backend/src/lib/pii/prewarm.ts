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

import { piiClient, type PiiMode } from "./client";
import { getChatSessionId, getDocumentAnalysisCache } from "./session";

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
    text: string;
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
            // Skip when an analysis already exists. Cheap DB lookup.
            const sessionId = await getChatSessionId(args.chatId);
            if (sessionId) {
                const cache = await getDocumentAnalysisCache(
                    sessionId,
                    args.documentVersionId,
                );
                if (cache && cache.processedText != null) return;
            }

            const result = await piiClient.anonymize({
                text: args.text,
                userId: args.userId,
                mode: args.mode,
                language: args.language,
                chatId: args.chatId,
                documentVersionId: args.documentVersionId,
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
