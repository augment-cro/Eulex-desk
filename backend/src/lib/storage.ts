/**
 * Google Cloud Storage utilities for Eulex Desk document management.
 *
 * On Cloud Run the default service account is used automatically —
 * no credentials env-vars are needed.
 *
 * Optional env vars:
 *   GCS_BUCKET_NAME — bucket name (default: "mike-docs-mikeoss")
 */

import { Storage } from "@google-cloud/storage";

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME ?? "mike-docs-mikeoss";

export const storageEnabled = true; // always available on GCP

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const bucket = storage.bucket(BUCKET);
  const file = bucket.file(key);
  await file.save(Buffer.from(content), {
    contentType,
    resumable: false,
  });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  try {
    const bucket = storage.bucket(BUCKET);
    const file = bucket.file(key);
    const [contents] = await file.download();
    return contents.buffer.slice(
      contents.byteOffset,
      contents.byteOffset + contents.byteLength,
    ) as ArrayBuffer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  try {
    const bucket = storage.bucket(BUCKET);
    const file = bucket.file(key);
    await file.delete({ ignoreNotFound: true });
  } catch {
    // swallow – best-effort deletion
  }
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  try {
    const bucket = storage.bucket(BUCKET);
    const file = bucket.file(key);
    const responseDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const [url] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresIn * 1000,
      responseDisposition,
    });
    return url;
  } catch (err) {
    // Callers answer 503 "Storage not configured". Swallowed silently, a
    // missing iam.serviceAccounts.signBlob grant broke every single-document
    // download for 10+ days (fixed 30. 9. 2026) — keep the cause visible.
    console.error(
      `[storage] signed URL failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

/**
 * The quoted `filename="…"` fallback of Content-Disposition. It must be
 * plain ASCII: Node's `setHeader` throws ERR_INVALID_CHAR on any character
 * above U+00FF (č, ć, š, ž, đ…), and Express 4 leaves that async throw
 * unanswered — the download and the viewer hung until Cloud Run's 20-minute
 * 504 for every document named with Croatian diacritics. The real name
 * travels in `filename*=UTF-8''…`, which every current browser prefers.
 */
export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function convertedPdfKey(userId: string, docId: string): string {
  return `documents/${userId}/${docId}/converted.pdf`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
