/**
 * Document file types Max accepts — one source of truth for every upload
 * surface (standalone, project, tabular review) and the cloud-connector
 * pickers.
 *
 * MUST stay in sync with backend `backend/src/lib/fileTypes.ts`. The server
 * is the real gate (anything else → HTTP 400 `code: "unsupported_file_type"`);
 * this module only keeps the UI from offering or sending files the upload
 * would reject.
 */

export const SUPPORTED_UPLOAD_EXTENSIONS = ["pdf", "docx", "doc", "txt"] as const;

export type SupportedUploadExtension =
    (typeof SUPPORTED_UPLOAD_EXTENSIONS)[number];

/** `accept` attribute for every document `<input type="file">`. */
export const SUPPORTED_UPLOAD_ACCEPT = SUPPORTED_UPLOAD_EXTENSIONS.map(
    (ext) => `.${ext}`,
).join(",");

/** Human-readable list for copy, e.g. "PDF, DOCX, DOC, TXT". */
export const SUPPORTED_UPLOAD_LABEL = SUPPORTED_UPLOAD_EXTENSIONS.map((ext) =>
    ext.toUpperCase(),
).join(", ");

/**
 * Per-file size limit. Mirrors `MAX_UPLOAD_SIZE_BYTES` in backend
 * `backend/src/lib/upload.ts` (the server answers 413 above it).
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

const MIME_BY_EXTENSION: Record<SupportedUploadExtension, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    txt: "text/plain",
};

/** Native Google Docs — the backend exports them to .docx on import. */
export const GOOGLE_DOCS_MIME = "application/vnd.google-apps.document";

/** `mime-types` filter for the Google Drive Picker view. */
export const GOOGLE_PICKER_MIME_TYPES = [
    ...SUPPORTED_UPLOAD_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext]),
    GOOGLE_DOCS_MIME,
].join(",");

/**
 * Lower-cased extension without the dot ("" when there is none). Same rule
 * as the backend: everything after the last dot of the file name.
 */
export function fileExtensionOf(name: string): string {
    return name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
}

export function isSupportedExtension(
    ext: string | null | undefined,
): ext is SupportedUploadExtension {
    return (SUPPORTED_UPLOAD_EXTENSIONS as readonly string[]).includes(
        ext ?? "",
    );
}

/** Whether the backend accepts this file's type (size is checked separately). */
export function isSupportedUploadFile(file: { name: string }): boolean {
    return isSupportedExtension(fileExtensionOf(file.name));
}

/**
 * Whether a cloud-connector listing entry will import: the backend keys off
 * the file name's extension, except native Google Docs, which it exports.
 */
export function isSupportedIntegrationFile(file: {
    name: string;
    mime_type: string;
}): boolean {
    return file.mime_type === GOOGLE_DOCS_MIME || isSupportedUploadFile(file);
}

/**
 * `accept` for uploading a new version of an existing document. The backend
 * requires the new file to have the document's own type, so offer exactly
 * that one (falls back to every supported type for legacy rows).
 */
export function versionUploadAccept(
    fileType: string | null | undefined,
): string {
    const ext = fileType?.toLowerCase();
    return isSupportedExtension(ext) ? `.${ext}` : SUPPORTED_UPLOAD_ACCEPT;
}
