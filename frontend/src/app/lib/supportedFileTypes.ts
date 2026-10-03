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

export const SUPPORTED_UPLOAD_EXTENSIONS = [
    "pdf",
    "docx",
    "doc",
    "txt",
    "md",
    "xlsx",
    "xlsm",
    "xls",
    "csv",
    "eml",
    "msg",
] as const;

export type SupportedUploadExtension =
    (typeof SUPPORTED_UPLOAD_EXTENSIONS)[number];

/** `accept` attribute for every document `<input type="file">`. */
export const SUPPORTED_UPLOAD_ACCEPT = SUPPORTED_UPLOAD_EXTENSIONS.map(
    (ext) => `.${ext}`,
).join(",");

/** Human-readable list for copy, e.g. "PDF, DOCX, DOC, TXT, XLSX, …". */
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
    // Stored and read as .txt by the backend (fileTypes UPLOAD_TYPE_ALIASES).
    md: "text/markdown",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    eml: "message/rfc822",
    msg: "application/vnd.ms-outlook",
};

/**
 * Spreadsheet formats. They are cited by sheet + cell (not by page) and
 * render in the Fortune-sheet viewer; `/display` serves every one of them
 * as .xlsx bytes (the backend converts .xls and .csv).
 */
export const SPREADSHEET_EXTENSIONS = ["xlsx", "xlsm", "xls", "csv"] as const;

/** Content type `/display` answers with for every spreadsheet document. */
export const SPREADSHEET_DISPLAY_MIME = MIME_BY_EXTENSION.xlsx;

/**
 * Whether a `file_type` (or a file name's extension, via
 * `fileExtensionOf`) is a spreadsheet.
 */
export function isSpreadsheetFileType(
    fileType: string | null | undefined,
): boolean {
    return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(
        fileType?.toLowerCase() ?? "",
    );
}

/**
 * E-mail messages (.eml, Outlook .msg). `/display` serves their text —
 * headers, body, then each attachment as further pages — as text/plain, so
 * they open in the plain-text viewer and are cited by page like a PDF.
 */
export const EMAIL_EXTENSIONS = ["eml", "msg"] as const;

/** Whether a `file_type` (or a file name's extension) is an e-mail. */
export function isEmailFileType(fileType: string | null | undefined): boolean {
    return (EMAIL_EXTENSIONS as readonly string[]).includes(
        fileType?.toLowerCase() ?? "",
    );
}

/** Native Google Docs — the backend exports them to .docx on import. */
export const GOOGLE_DOCS_MIME = "application/vnd.google-apps.document";

/** Native Google Sheets — the backend exports them to .xlsx on import. */
export const GOOGLE_SHEETS_MIME = "application/vnd.google-apps.spreadsheet";

/** `mime-types` filter for the Google Drive Picker view. */
export const GOOGLE_PICKER_MIME_TYPES = [
    ...SUPPORTED_UPLOAD_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext]),
    GOOGLE_DOCS_MIME,
    GOOGLE_SHEETS_MIME,
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
 * the file name's extension, except native Google Docs and Sheets, which it
 * exports (to .docx / .xlsx).
 */
export function isSupportedIntegrationFile(file: {
    name: string;
    mime_type: string;
}): boolean {
    return (
        file.mime_type === GOOGLE_DOCS_MIME ||
        file.mime_type === GOOGLE_SHEETS_MIME ||
        isSupportedUploadFile(file)
    );
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
    // A .md upload is stored as "txt", so either extension is a valid version.
    if (ext === "txt") return ".txt,.md";
    return isSupportedExtension(ext) ? `.${ext}` : SUPPORTED_UPLOAD_ACCEPT;
}
