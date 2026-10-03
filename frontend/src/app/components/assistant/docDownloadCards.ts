import type { AssistantEvent } from "../shared/types";

type EditedEvent = Extract<AssistantEvent, { type: "doc_edited" }>;
type CreatedEvent = Extract<AssistantEvent, { type: "doc_created" }>;

/**
 * Download cards under one finished assistant answer: the latest edit per
 * document, plus each created document that no edit in the same answer
 * superseded.
 *
 * A turn that generates a document and then edits it emits doc_created (V1)
 * and doc_edited (V2). Showing both cards let the user download V1 — the
 * version without the changes they had just accepted (COIN, 30. 9., #93).
 */
export function docDownloadCards(events: AssistantEvent[]): {
    edited: EditedEvent[];
    created: CreatedEvent[];
} {
    const latestEditByDoc = new Map<string, EditedEvent>();
    for (const e of events) {
        if (e.type === "doc_edited" && !e.isStreaming && e.download_url)
            latestEditByDoc.set(e.document_id, e);
    }
    const created = events.filter(
        (e): e is CreatedEvent =>
            e.type === "doc_created" &&
            !!e.download_url &&
            !(e.document_id && latestEditByDoc.has(e.document_id)),
    );
    return { edited: Array.from(latestEditByDoc.values()), created };
}
