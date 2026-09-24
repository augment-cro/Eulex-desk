import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/app/lib/analytics", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/analytics")>()),
    track: vi.fn(),
}));

import { track } from "@/app/lib/analytics";
import { UploadHttpError } from "./mikeApi";
import {
    UPLOAD_CONCURRENCY,
    classifyUploadError,
    preflightUploadFiles,
    settleWithConcurrency,
    uploadFilesBulk,
} from "./bulkUpload";
import {
    GOOGLE_DOCS_MIME,
    GOOGLE_PICKER_MIME_TYPES,
    MAX_UPLOAD_BYTES,
    SUPPORTED_UPLOAD_ACCEPT,
    isSupportedIntegrationFile,
    isSupportedUploadFile,
    versionUploadAccept,
} from "./supportedFileTypes";

function file(name: string, size = 10): File {
    const f = new File(["x"], name);
    Object.defineProperty(f, "size", { value: size });
    return f;
}

beforeEach(() => {
    vi.mocked(track).mockClear();
});

describe("supportedFileTypes", () => {
    it("derives accept + predicates from one list", () => {
        expect(SUPPORTED_UPLOAD_ACCEPT).toBe(".pdf,.docx,.doc,.txt");
        expect(isSupportedUploadFile({ name: "Ugovor.PDF" })).toBe(true);
        expect(isSupportedUploadFile({ name: "notes.txt" })).toBe(true);
        expect(isSupportedUploadFile({ name: "table.xlsx" })).toBe(false);
        expect(isSupportedUploadFile({ name: "README" })).toBe(false);
    });

    it("offers exactly the document's own type for a new version", () => {
        expect(versionUploadAccept("txt")).toBe(".txt");
        expect(versionUploadAccept("pdf")).toBe(".pdf");
        expect(versionUploadAccept("docx")).toBe(".docx");
        expect(versionUploadAccept(null)).toBe(SUPPORTED_UPLOAD_ACCEPT);
    });

    it("treats native Google Docs as importable, Sheets/Slides not", () => {
        expect(
            isSupportedIntegrationFile({
                name: "Memo",
                mime_type: GOOGLE_DOCS_MIME,
            }),
        ).toBe(true);
        expect(
            isSupportedIntegrationFile({
                name: "Budget",
                mime_type: "application/vnd.google-apps.spreadsheet",
            }),
        ).toBe(false);
        expect(GOOGLE_PICKER_MIME_TYPES).toContain(GOOGLE_DOCS_MIME);
        expect(GOOGLE_PICKER_MIME_TYPES).toContain("text/plain");
        expect(GOOGLE_PICKER_MIME_TYPES).not.toContain("spreadsheet");
    });
});

describe("preflightUploadFiles", () => {
    it("rejects unsupported and oversized files with a reason", () => {
        const { accepted, rejected } = preflightUploadFiles([
            file("a.pdf"),
            file("b.xlsx"),
            file("noext"),
            file("big.docx", MAX_UPLOAD_BYTES + 1),
            file("c.txt"),
        ]);
        expect(accepted.map((f) => f.name)).toEqual(["a.pdf", "c.txt"]);
        expect(rejected).toEqual([
            { name: "b.xlsx", reason: "unsupported", fileType: "xlsx" },
            { name: "noext", reason: "unsupported", fileType: undefined },
            { name: "big.docx", reason: "too_large" },
        ]);
    });
});

describe("classifyUploadError", () => {
    it("maps 413 to too_large", () => {
        const err = new UploadHttpError(
            413,
            JSON.stringify({ detail: "File too large. Maximum size is 100 MB." }),
        );
        expect(classifyUploadError(err)).toEqual({ reason: "too_large" });
    });

    it("reads the unsupported_file_type contract (uploads and imports)", () => {
        const body = JSON.stringify({
            detail: "Unsupported file type: xlsx. Allowed: pdf, docx, doc, txt",
            code: "unsupported_file_type",
            file_type: "xlsx",
            allowed: ["pdf", "docx", "doc", "txt"],
        });
        expect(classifyUploadError(new UploadHttpError(400, body))).toEqual({
            reason: "unsupported",
            fileType: "xlsx",
        });
        // apiRequest (connector import) throws a plain Error with the body.
        expect(classifyUploadError(new Error(body))).toEqual({
            reason: "unsupported",
            fileType: "xlsx",
        });
    });

    it("falls back to the legacy detail string", () => {
        const legacy = new Error(
            JSON.stringify({
                detail: "Unsupported file type: pptx. Allowed: pdf, docx, doc",
            }),
        );
        expect(classifyUploadError(legacy)).toEqual({
            reason: "unsupported",
            fileType: "pptx",
        });
    });

    it("treats anything else as a generic error", () => {
        expect(classifyUploadError(new UploadHttpError(500, "boom"))).toEqual({
            reason: "error",
        });
        expect(classifyUploadError(new TypeError("Failed to fetch"))).toEqual({
            reason: "error",
        });
    });
});

describe("settleWithConcurrency", () => {
    it("keeps input order and never exceeds the limit", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const results = await settleWithConcurrency(
            [5, 1, 4, 2, 3, 0],
            2,
            async (ms) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((r) => setTimeout(r, ms));
                inFlight -= 1;
                if (ms === 4) throw new Error("four");
                return ms * 10;
            },
        );
        expect(maxInFlight).toBe(2);
        expect(results.map((r) => r.status)).toEqual([
            "fulfilled",
            "fulfilled",
            "rejected",
            "fulfilled",
            "fulfilled",
            "fulfilled",
        ]);
        expect(
            results.map((r) => (r.status === "fulfilled" ? r.value : null)),
        ).toEqual([50, 10, null, 20, 30, 0]);
    });
});

describe("uploadFilesBulk", () => {
    it("keeps every success when others fail, bounded to UPLOAD_CONCURRENCY", async () => {
        const files = [
            ...Array.from({ length: 8 }, (_, i) => file(`doc${i}.pdf`)),
            file("sheet.xlsx"),
            file("fail.docx"),
        ];
        let inFlight = 0;
        let maxInFlight = 0;
        const onUploaded = vi.fn();
        const upload = vi.fn(async (f: File) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight -= 1;
            if (f.name === "fail.docx") {
                throw new UploadHttpError(500, '{"detail":"boom"}');
            }
            return { id: f.name };
        });

        const { uploaded, failures } = await uploadFilesBulk(files, {
            upload,
            surface: "project",
            onUploaded,
        });

        // The unsupported file is never sent.
        expect(upload).toHaveBeenCalledTimes(9);
        expect(maxInFlight).toBeLessThanOrEqual(UPLOAD_CONCURRENCY);
        expect(uploaded.map((d) => d.id)).toEqual(
            files.slice(0, 8).map((f) => f.name),
        );
        expect(onUploaded).toHaveBeenCalledTimes(8);
        expect(failures).toEqual([
            { name: "sheet.xlsx", reason: "unsupported", fileType: "xlsx" },
            { name: "fail.docx", reason: "error" },
        ]);

        // One document_uploaded event per file, same shape as before.
        const calls = vi.mocked(track).mock.calls;
        expect(calls).toHaveLength(10);
        expect(calls).toContainEqual([
            "document_uploaded",
            { surface: "project", file_type: "xlsx", result: "error" },
        ]);
        expect(calls).toContainEqual([
            "document_uploaded",
            { surface: "project", file_type: "docx", result: "error" },
        ]);
        expect(
            calls.filter(
                ([, meta]) =>
                    (meta as { result: string }).result === "success",
            ),
        ).toHaveLength(8);
    });
});
