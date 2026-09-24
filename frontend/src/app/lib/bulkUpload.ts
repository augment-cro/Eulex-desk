/**
 * Shared multi-file upload used by every surface that takes several files at
 * once (data rooms of 60+ files are normal). Previously each surface ran
 * `Promise.all` over all files: no concurrency limit, and a single rejection
 * threw away every successful document while the user saw nothing.
 *
 * Here: unsupported / oversized files are never sent, the rest go up
 * `UPLOAD_CONCURRENCY` at a time, every success is kept even when other files
 * fail, and the failures come back with a reason the UI can show
 * (`UploadFailuresAlert`).
 */

import { fileTypeOf, track } from "@/app/lib/analytics";
import { UploadHttpError } from "@/app/lib/mikeApi";
import {
    MAX_UPLOAD_BYTES,
    fileExtensionOf,
    isSupportedExtension,
} from "@/app/lib/supportedFileTypes";

export type UploadFailureReason = "unsupported" | "too_large" | "error";

export interface UploadFailure {
    /** File name as picked — shown in the failure summary. */
    name: string;
    reason: UploadFailureReason;
    /** Rejected extension for `unsupported` (e.g. "xlsx"), when known. */
    fileType?: string;
}

export interface BulkUploadResult<T> {
    /** Uploaded documents, in the order the files were picked. */
    uploaded: T[];
    /** Every file that did not upload — pre-filtered or failed server-side. */
    failures: UploadFailure[];
}

/** Uploads in flight per batch. */
export const UPLOAD_CONCURRENCY = 3;

/**
 * Split picked files into the ones worth sending and the ones the backend
 * would reject anyway (type or size).
 */
export function preflightUploadFiles(files: readonly File[]): {
    accepted: File[];
    rejected: UploadFailure[];
} {
    const accepted: File[] = [];
    const rejected: UploadFailure[] = [];
    for (const file of files) {
        const ext = fileExtensionOf(file.name);
        if (!isSupportedExtension(ext)) {
            rejected.push({
                name: file.name,
                reason: "unsupported",
                fileType: ext || undefined,
            });
        } else if (file.size > MAX_UPLOAD_BYTES) {
            rejected.push({ name: file.name, reason: "too_large" });
        } else {
            accepted.push(file);
        }
    }
    return { accepted, rejected };
}

function parseErrorBody(err: unknown): Record<string, unknown> | null {
    if (!(err instanceof Error)) return null;
    try {
        const parsed: unknown = JSON.parse(err.message);
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

const FILE_TYPE_RE = /^[a-z0-9]+$/i;

/**
 * Why an upload or connector import failed. The upload helpers throw
 * `UploadHttpError` (carries the status); `apiRequest` throws the raw JSON
 * body as the message. A rejected format comes back as HTTP 400
 * `{ code: "unsupported_file_type", file_type }`.
 */
export function classifyUploadError(err: unknown): {
    reason: UploadFailureReason;
    fileType?: string;
} {
    if (err instanceof UploadHttpError && err.status === 413) {
        return { reason: "too_large" };
    }
    const body = parseErrorBody(err);
    if (body?.code === "unsupported_file_type") {
        const fileType =
            typeof body.file_type === "string" &&
            FILE_TYPE_RE.test(body.file_type)
                ? body.file_type
                : undefined;
        return { reason: "unsupported", fileType };
    }
    // Backends predating `code` only say it in `detail`.
    const legacy =
        typeof body?.detail === "string"
            ? /^Unsupported file type: ([a-z0-9]*)/i.exec(body.detail)
            : null;
    if (legacy) {
        return { reason: "unsupported", fileType: legacy[1] || undefined };
    }
    return { reason: "error" };
}

/**
 * `Promise.allSettled` over `items` with at most `limit` calls of `fn` in
 * flight. Results keep the input order.
 */
export async function settleWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            try {
                results[index] = {
                    status: "fulfilled",
                    value: await fn(items[index]),
                };
            } catch (reason) {
                results[index] = { status: "rejected", reason };
            }
        }
    };
    const workers = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return results;
}

/** One `document_uploaded` analytics event (unchanged shape). */
export function trackUploadResult(
    surface: string,
    file: File,
    ok: boolean,
): void {
    track("document_uploaded", {
        surface,
        file_type: fileTypeOf(file),
        result: ok ? "success" : "error",
    });
}

/**
 * Upload a batch of picked files. Never throws — every failure ends up in
 * `failures`. A pre-filtered file is tracked as `result: "error"`, as it was
 * when the server rejected it, so the analytics series stays continuous.
 */
export async function uploadFilesBulk<T>(
    files: readonly File[],
    options: {
        upload: (file: File) => Promise<T>;
        /** `surface` of the `document_uploaded` event. */
        surface: string;
        /** Called as each upload lands, so lists can fill in progressively. */
        onUploaded?: (doc: T) => void;
    },
): Promise<BulkUploadResult<T>> {
    const { upload, surface, onUploaded } = options;
    const { accepted, rejected } = preflightUploadFiles(files);
    const acceptedSet = new Set(accepted);
    for (const file of files) {
        if (!acceptedSet.has(file)) trackUploadResult(surface, file, false);
    }

    const settled = await settleWithConcurrency(
        accepted,
        UPLOAD_CONCURRENCY,
        async (file) => {
            let doc: T;
            try {
                doc = await upload(file);
            } catch (err) {
                trackUploadResult(surface, file, false);
                throw err;
            }
            trackUploadResult(surface, file, true);
            onUploaded?.(doc);
            return doc;
        },
    );

    const uploaded: T[] = [];
    const failures: UploadFailure[] = [...rejected];
    settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
            uploaded.push(result.value);
            return;
        }
        console.error(`Upload failed: ${accepted[i].name}`, result.reason);
        failures.push({
            name: accepted[i].name,
            ...classifyUploadError(result.reason),
        });
    });
    return { uploaded, failures };
}
