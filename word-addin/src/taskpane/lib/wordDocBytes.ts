import { normalizeFilenameForDisplay } from "./filenameUtf8";

/* global Office */

/**
 * Read the currently open Word document as a Blob via Office.js.
 *
 * `getFileAsync(FileType.Compressed)` returns the document in slices we
 * stitch back together. It works even on unsaved documents — Word builds
 * an in-memory .docx snapshot — so the user doesn't have to save first.
 *
 * Resolves with `{ blob, filename }` where `filename` is derived from
 * `Office.context.document.url` when available, otherwise "Document.docx".
 */
export async function getOpenDocumentBytes(): Promise<{
    blob: Blob;
    filename: string;
}> {
    if (typeof Office === "undefined" || !Office?.context?.document) {
        throw new Error(
            "Word is not available — open this add-in inside Word to use this action.",
        );
    }

    const filename = deriveFilename();

    return new Promise((resolve, reject) => {
        Office.context.document.getFileAsync(
            Office.FileType.Compressed,
            { sliceSize: 65536 },
            (fileResult) => {
                if (fileResult.status !== Office.AsyncResultStatus.Succeeded) {
                    reject(
                        new Error(
                            `Couldn't read the document: ${
                                fileResult.error?.message ?? "unknown error"
                            }`,
                        ),
                    );
                    return;
                }
                const file = fileResult.value;
                const sliceCount = file.sliceCount;
                const slices: Uint8Array[] = new Array(sliceCount);
                let received = 0;
                let failed = false;

                const finish = () => {
                    file.closeAsync(() => {});
                };

                for (let i = 0; i < sliceCount; i++) {
                    const idx = i;
                    file.getSliceAsync(idx, (sliceResult) => {
                        if (failed) return;
                        if (
                            sliceResult.status !==
                            Office.AsyncResultStatus.Succeeded
                        ) {
                            failed = true;
                            finish();
                            reject(
                                new Error(
                                    `Couldn't read slice ${idx} of the document: ${
                                        sliceResult.error?.message ??
                                        "unknown error"
                                    }`,
                                ),
                            );
                            return;
                        }
                        slices[idx] = new Uint8Array(sliceResult.value.data);
                        received += 1;
                        if (received === sliceCount) {
                            finish();
                            const blob = new Blob(slices as BlobPart[], {
                                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            });
                            resolve({ blob, filename });
                        }
                    });
                }
            },
        );
    });
}

function deriveFilename(): string {
    try {
        const raw = Office.context.document.url;
        if (raw && typeof raw === "string") {
            let base = "";
            try {
                const u = new URL(raw);
                const seg = u.pathname.split("/").filter(Boolean);
                base = seg.length ? seg[seg.length - 1]! : "";
            } catch {
                const segs = raw.split(/[\\/]/);
                base = segs[segs.length - 1] || "";
            }
            base = base.split("?")[0].split("#")[0];
            if (base) {
                const cleaned = normalizeFilenameForDisplay(base);
                return cleaned.toLowerCase().endsWith(".docx")
                    ? cleaned
                    : `${cleaned}.docx`;
            }
        }
    } catch {
        /* ignore */
    }
    return "Document.docx";
}
