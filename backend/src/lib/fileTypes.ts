/**
 * Supported document formats — the single source of truth for upload
 * validation, stored content types and the "unsupported type" error that
 * every upload surface returns (standalone and project uploads, new
 * versions, cloud-connector imports).
 *
 * The frontend mirrors the list in
 * `frontend/src/app/lib/supportedFileTypes.ts` — keep the two in sync.
 */

export const SUPPORTED_UPLOAD_TYPES = ["pdf", "docx", "doc", "txt"] as const;

export type SupportedUploadType = (typeof SUPPORTED_UPLOAD_TYPES)[number];

const CONTENT_TYPES: Record<SupportedUploadType, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    txt: "text/plain; charset=utf-8",
};

/** Lower-cased extension without the dot; "" when the name has none. */
export function fileExtension(filename: string): string {
    return filename.includes(".")
        ? filename.split(".").pop()!.toLowerCase()
        : "";
}

export function isSupportedUploadType(ext: string): ext is SupportedUploadType {
    return (SUPPORTED_UPLOAD_TYPES as readonly string[]).includes(ext);
}

/** Content type for storing an upload of a supported type. */
export function contentTypeForUpload(ext: SupportedUploadType): string {
    return CONTENT_TYPES[ext];
}

/**
 * Thrown for an upload whose extension is not in SUPPORTED_UPLOAD_TYPES.
 * The message keeps the historical "Unsupported file type: …" prefix;
 * routes answer 400 with `toResponseBody()` so the frontend can localize
 * the error from `code` + `file_type` instead of parsing `detail`.
 */
export class UnsupportedFileTypeError extends Error {
    readonly code = "unsupported_file_type";
    readonly fileType: string;

    constructor(fileType: string) {
        super(
            `Unsupported file type: ${fileType || "(none)"}. Allowed: ${SUPPORTED_UPLOAD_TYPES.join(", ")}`,
        );
        this.name = "UnsupportedFileTypeError";
        this.fileType = fileType;
    }

    toResponseBody() {
        return {
            detail: this.message,
            code: this.code,
            file_type: this.fileType,
            allowed: [...SUPPORTED_UPLOAD_TYPES],
        };
    }
}

/**
 * Validate an upload's extension. Logs every rejection with the
 * extension and the surface — the only record of which formats users
 * actually try to upload (the 400 itself carries no reason in the
 * request log). Never logs the filename.
 */
export function assertSupportedUploadType(
    filename: string,
    surface: string,
): SupportedUploadType {
    const ext = fileExtension(filename);
    if (isSupportedUploadType(ext)) return ext;
    // The extension comes from a user-supplied name — bound it before it
    // reaches a log line or an error body.
    const shown = ext.replace(/[^a-z0-9]/g, "").slice(0, 12);
    console.warn(
        `[upload] rejected unsupported file_type="${shown || "(none)"}" surface=${surface}`,
    );
    throw new UnsupportedFileTypeError(shown);
}
