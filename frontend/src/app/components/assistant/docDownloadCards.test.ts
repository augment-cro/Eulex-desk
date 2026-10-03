import { describe, expect, it } from "vitest";
import type { AssistantEvent } from "../shared/types";
import { docDownloadCards } from "./docDownloadCards";

const created = (document_id?: string): AssistantEvent => ({
    type: "doc_created",
    filename: "Ugovor.docx",
    download_url: "/download/v1",
    document_id,
    version_number: 1,
});

const edited = (
    document_id: string,
    download_url: string,
    extra: Partial<Extract<AssistantEvent, { type: "doc_edited" }>> = {},
): AssistantEvent => ({
    type: "doc_edited",
    filename: "Ugovor.docx",
    document_id,
    version_id: `ver-${download_url}`,
    download_url,
    annotations: [],
    ...extra,
});

describe("docDownloadCards", () => {
    it("drops the V1 card of a document edited in the same answer (prod 30. 9.)", () => {
        const cards = docDownloadCards([
            created("doc-a"),
            edited("doc-a", "/download/v2"),
        ]);
        expect(cards.created).toEqual([]);
        expect(cards.edited.map((e) => e.download_url)).toEqual(["/download/v2"]);
    });

    it("keeps the created card when the document was not edited", () => {
        const cards = docDownloadCards([created("doc-a"), edited("doc-b", "/download/b2")]);
        expect(cards.created).toHaveLength(1);
        expect(cards.edited).toHaveLength(1);
    });

    it("keeps a legacy created card without a document id", () => {
        const cards = docDownloadCards([created(undefined), edited("doc-a", "/download/v2")]);
        expect(cards.created).toHaveLength(1);
    });

    it("keeps the created card while the edit is still streaming or failed without a file", () => {
        expect(
            docDownloadCards([created("doc-a"), edited("doc-a", "/download/v2", { isStreaming: true })]).created,
        ).toHaveLength(1);
        expect(docDownloadCards([created("doc-a"), edited("doc-a", "")]).created).toHaveLength(1);
    });

    it("keeps only the latest edit per document", () => {
        const cards = docDownloadCards([
            edited("doc-a", "/download/v2"),
            edited("doc-a", "/download/v3"),
        ]);
        expect(cards.edited.map((e) => e.download_url)).toEqual(["/download/v3"]);
    });
});
