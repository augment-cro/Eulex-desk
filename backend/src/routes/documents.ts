import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { getClient } from "../lib/db";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  storageKey,
  uploadFile,
  versionStorageKey,
} from "../lib/storage";
import { docxToPdf, convertedPdfKey } from "../lib/convert";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
  loadActiveVersion,
} from "../lib/documentVersions";
import { sealManifest } from "../lib/manifestSigning";
import { ensureDocAccess } from "../lib/access";
import { normalizeUploadFilename } from "../lib/filenameUtf8";
import { singleFileUpload } from "../lib/upload";
import { recordAuditEvent, recordFeatureUse } from "../lib/audit";
import {
  UnsupportedFileTypeError,
  assertSupportedUploadType,
  contentTypeForUpload,
} from "../lib/fileTypes";
import { textCachePathsFor } from "../lib/documentText";

export const documentsRouter = Router();

// Hard cap on /download-zip request size. Each entry triggers a parallel
// loadActiveVersion + downloadFile + JSZip.file(...) that holds the full
// file bytes in memory until the zip is generated; without this guard a
// caller can crash the Cloud Run instance with a single large request
// (50 × ~5 MB ≈ 250 MB headroom, comfortable on 2Gi memory).
const MAX_ZIP_DOCUMENTS = 50;

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await db
    .from("documents")
    .select("*")
    .eq("user_id", userId)
    .is("project_id", null)
    .order("created_at", { ascending: false });
  if (error) return void res.status(500).json({ detail: error.message });
  const docs = (data ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docs);
  await attachActiveVersionPaths(db, docs);
  res.json(docs);
});

// POST /single-documents
documentsRouter.post(
  "/",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    await handleDocumentUpload(req, res, userId, null, db);
  },
);

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const { data: versions } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .eq("document_id", documentId);
  await Promise.all(
    (versions ?? []).flatMap((v: { storage_path?: string; pdf_storage_path?: string }) =>
      [
        v.storage_path,
        v.pdf_storage_path,
        ...(v.storage_path ? textCachePathsFor(v.storage_path) : []),
      ]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await db.from("documents").delete().eq("id", documentId);
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Optional ?version_id= renders a historical version. Defaults to the
// document's current_version_id.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, filename, file_type, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = (doc.file_type as string) ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";

  // For DOCX, prefer the per-version PDF rendition if one exists.
  const servePath =
    isDocx && active.pdf_storage_path
      ? active.pdf_storage_path
      : active.storage_path;
  const raw = await downloadFile(servePath);
  if (!raw)
    return void res
      .status(404)
      .json({ detail: "Document not found in storage" });

  if (fileType === "pdf" || (isDocx && active.pdf_storage_path)) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else if (fileType === "txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  } else {
    // Fallback: serve raw DOCX (mammoth will handle it client-side)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("inline", doc.filename as string),
    );
    res.send(Buffer.from(raw));
  }
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  if (document_ids.length > MAX_ZIP_DOCUMENTS)
    return void res.status(400).json({
      code: "ZIP_DOCUMENT_LIMIT",
      max_documents: MAX_ZIP_DOCUMENTS,
      detail: `Cannot download more than ${MAX_ZIP_DOCUMENTS} documents at once`,
    });

  const db = createServerSupabase();
  const { data: rawDocs, error } = await db
    .from("documents")
    .select("id, filename, file_type, current_version_id, user_id, project_id")
    .in("id", document_ids);

  if (error) return void res.status(500).json({ detail: error.message });
  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    (rawDocs ?? []).map(async (d: Record<string, unknown>) => ({
      doc: d,
      access: await ensureDocAccess(
        d as { user_id: string; project_id: string | null },
        userId,
        userEmail,
        db,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc as { id: string; filename: string });
  if (!docs || docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  // `documents.filename` is user-controlled and only had *leading* slashes
  // stripped at upload, so `../../evil.pdf` could land verbatim as a zip
  // entry name (zip-slip on extractors that honour it). Two docs sharing a
  // filename also silently overwrote each other. Flatten to a basename and
  // de-duplicate with a numeric suffix (issue #112).
  // Reserved for the integrity manifest below — a user document named
  // manifest.json gets de-duplicated to "manifest (2).json" instead of
  // colliding with it.
  const usedNames = new Set<string>(["manifest.json"]);
  const safeEntryName = (filename: string): string => {
    const base =
      (filename ?? "").split(/[/\\]/).pop()?.replace(/^\.+/, "") || "document";
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let n = 2;
    let candidate = `${stem} (${n})${ext}`;
    while (usedNames.has(candidate)) {
      n += 1;
      candidate = `${stem} (${n})${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  };

  // Sequential: safeEntryName's de-dup set must not be mutated concurrently.
  const manifestEntries: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const active = await loadActiveVersion(doc.id, db);
    if (!active) continue;
    const raw = await downloadFile(active.storage_path);
    if (!raw) continue;
    const entryName = safeEntryName(doc.filename);
    zip.file(entryName, Buffer.from(raw));
    // Hash the exact bytes placed in the zip, so the manifest entry is
    // verifiable against the extracted file with `shasum -a 256 <file>`.
    manifestEntries.push({
      entry_name: entryName,
      document_id: doc.id,
      version_id: active.id,
      version_number: active.version_number,
      content_sha256: contentSha256(raw),
      size_bytes: raw.byteLength,
    });
  }

  // Integrity manifest for the zip itself: per-entry SHA-256 over the bytes
  // shipped, sealed (digest + optional Ed25519 signature) like the project
  // export manifest.
  zip.file(
    "manifest.json",
    JSON.stringify(
      sealManifest({
        manifest_version: 1,
        kind: "document_zip",
        exported_at: new Date().toISOString(),
        documents: manifestEntries,
      }),
      null,
      2,
    ),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);

  // Workspace audit trail (#27) — fire-and-forget, ids only.
  void recordAuditEvent({
    userId,
    eventType: "document.zip_exported",
    metadata: {
      document_count: docs.length,
      document_ids: docs.map((d) => d.id),
    },
  });
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename as string,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Streams the raw .docx bytes for the given document, optionally at a
// specific tracked-changes version. Unlike /url, this bypasses R2 (avoids
// the browser CORS problem on signed URLs) so the frontend docx-preview
// viewer can load tracked-change documents directly.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;
  const db = createServerSupabase();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, filename, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (error || !doc) {
    console.warn(`[docx] document ${documentId} not found:`, error);
    return void res.status(404).json({ detail: "Document not found" });
  }
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) {
    console.warn(`[docx] access denied for ${documentId} user=${userId}`);
    return void res.status(404).json({ detail: "Document not found" });
  }

  const active = await loadActiveVersion(documentId, db, versionIdParam);
  if (!active) {
    console.warn(
      `[docx] no active version for doc=${documentId} requested_version=${versionIdParam}`,
    );
    return void res
      .status(404)
      .json({ detail: "No file available", document_id: documentId, version_id: versionIdParam });
  }

  console.log(
    `[docx] serving doc=${documentId} version=${active.id} path=${active.storage_path}`,
  );
  const raw = await downloadFile(active.storage_path);
  if (!raw) {
    console.warn(
      `[docx] GCS miss for doc=${documentId} version=${active.id} path=${active.storage_path}`,
    );
    return void res.status(404).json({
      detail: "Document bytes not available",
      version_id: active.id,
      storage_path: active.storage_path,
    });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(
      "inline",
      resolveDownloadFilename(
        doc.filename as string,
        active.display_name,
        active.version_number,
      ),
    ),
  );
  res.send(Buffer.from(raw));
});

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const db = createServerSupabase();

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const { data: rows } = await db
    .from("document_versions")
    .select("id, version_number, source, created_at, display_name")
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows ?? [],
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const db = createServerSupabase();

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const uploadFilename = normalizeUploadFilename(file.originalname);

    const { data: doc } = await db
      .from("documents")
      .select("id, filename, file_type, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    // An extension-less blob used to slip through (the old check required a
    // non-empty suffix), then got served as application/pdf by /display and
    // as DOCX by /docx (issue #112). Require a supported extension.
    let suffix: ReturnType<typeof assertSupportedUploadType>;
    try {
      suffix = assertSupportedUploadType(uploadFilename, "version");
    } catch (e) {
      if (e instanceof UnsupportedFileTypeError)
        return void res.status(400).json(e.toResponseBody());
      throw e;
    }
    if (doc.file_type && doc.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      uploadFilename,
    );
    const contentType = contentTypeForUpload(suffix);
    try {
      await uploadFile(
        key,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // Render this version's bytes to PDF up front so /display can show
    // historical versions without on-demand conversion. Same logic as the
    // initial-upload pipeline; failures don't block the version row.
    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(file.buffer);
        const pdfKey = `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`;
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[versions/upload] DOCX→PDF conversion failed for ${uploadFilename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      // For PDF uploads, the uploaded bytes are themselves the PDF rendition.
      pdfStoragePath = key;
    }

    // Per-document sequential version_number — the upload is V1 and
    // user_upload + assistant_edit count forward from there.
    const { data: maxRow } = await db
      .from("document_versions")
      .select("version_number")
      .eq("document_id", documentId)
      .in("source", ["upload", "user_upload", "assistant_edit"])
      .order("version_number", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    const nextVersionNumber =
      ((maxRow?.version_number as number | null) ?? 1) + 1;

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : uploadFilename;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "user_upload",
        version_number: nextVersionNumber,
        display_name: defaultDisplayName,
        size_bytes: file.buffer.byteLength,
        content_sha256: contentSha256(file.buffer),
      })
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (verErr || !versionRow) {
      console.error("[versions/upload] insert failed", verErr);
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const documentsUpdate: Record<string, unknown> = {
      current_version_id: versionRow.id,
    };
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = (doc.filename as string | null)?.match(
        /\.[a-z0-9]{1,6}$/i,
      )?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      documentsUpdate.filename = `${providedDisplayName}${ext}`;
    }
    await db
      .from("documents")
      .update(documentsUpdate)
      .eq("id", documentId);

    // Workspace audit trail (#27) — fire-and-forget, ids and enums only.
    void recordAuditEvent({
      userId,
      eventType: "document.version_added",
      documentId,
      projectId: (doc.project_id as string | null) ?? null,
      metadata: {
        version_id: versionRow.id,
        version_number: nextVersionNumber,
        file_type: suffix,
      },
    });

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const { data: updated, error } = await db
      .from("document_versions")
      .update({ display_name: displayName })
      .eq("id", versionId)
      .eq("document_id", documentId)
      .select("id, version_number, source, created_at, display_name")
      .single();
    if (error || !updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// GET /single-documents/:documentId/edits
//
// Lista document_edits redaka za dokument. Default vraća samo pending
// (najčešći use case: bubble panel u SuperDocView treba znati koji su
// LLM-generirani prijedlozi još otvoreni). `status=all` vraća sve.
//
// Bez ovog endpointa SuperDoc-ov bubble nema bridge prema postojećim
// Mike prijedlozima — može ih samo accept-ati/reject-ati lokalno, što
// znači da `document_edits.status` u DB-u ostane stale i Mike chat
// prikazuje već-razriješene prijedloge kao "pending".
documentsRouter.get(
  "/:documentId/edits",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : "pending";
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // NB: tablica nema `reason` stupac (vidi migrations/database_catalog —
    // shema ima edit_type, content, status, version_id, change_id, w:id-ove,
    // tekst-ove, kontekste, ali NE i reason). Pre-fix kod ga je SELECT-ao
    // što je u Supabase REST-u rezultiralo 500 na svakom pozivu. Ako neki
    // čovjek/audit kasnije zatreba "zašto je Mike predložio ovu izmjenu",
    // dodat će se kao novi stupac kroz migraciju.
    let query = db
      .from("document_edits")
      .select(
        "id, version_id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, status, created_at",
      )
      .eq("document_id", documentId)
      .order("created_at", { ascending: true });

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const { data, error } = await query;
    if (error) {
      console.error("[edits/list] DB error", error);
      return void res.status(500).json({ detail: "Failed to load edits" });
    }
    res.json({ edits: data ?? [] });
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;
    const db = createServerSupabase();

    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;
  const db = createServerSupabase();

  const { data: edit } = await db
    .from("document_edits")
    .select("id, document_id, change_id, del_w_id, ins_w_id, status")
    .eq("id", editId)
    .eq("document_id", documentId)
    .single();
  if (!edit) {
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    const { data: doc } = await db
      .from("documents")
      .select("current_version_id, filename, user_id, project_id")
      .eq("id", documentId)
      .single();
    if (!doc) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
    if (!accessResolved.ok) {
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId, db);
    // Count for real — hardcoding 0 let a stale UI clear the pending-edits
    // badge while other edits were still pending (issue #112).
    const { count: stillPending } = await db
      .from("document_edits")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .eq("status", "pending");
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: doc.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            (doc.filename as string) ?? "document.docx",
          )
        : null,
      remaining_pending: stillPending ?? 0,
    };
    return void res.status(200).json(payload);
  }

  const { data: doc } = await db
    .from("documents")
    .select("id, current_version_id, user_id, project_id")
    .eq("id", documentId)
    .single();
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  // Serialize concurrent accept/reject on the SAME document with a
  // per-document pg advisory lock. Without it two requests both downloaded
  // the same original DOCX, each resolved a different tracked change, and
  // both re-uploaded to the same path → last write wins, leaving one edit
  // marked resolved while its change stayed in the file (issue #107). The
  // lock is held across the download→resolve→upload critical section; it's
  // per-document so it never blocks other documents.
  const lockClient = await getClient();
  let lockHeld = false;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [
      documentId,
    ]);
    lockHeld = true;

  const active = await loadActiveVersion(documentId, db);
  const latestPath = active?.storage_path ?? null;
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  if (!found) {
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    const { error: updErr } = await db
      .from("document_edits")
      .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
      .eq("id", editId);
    if (updErr) {
      console.error("[edit-resolution] status update failed");
      return void res.status(500).json({ detail: "Failed to update edit" });
    }
    // Workspace audit trail (#27) — fire-and-forget.
    void recordAuditEvent({
      userId,
      eventType:
        mode === "accept" ? "document.edit_accepted" : "document.edit_rejected",
      documentId,
      projectId: (doc.project_id as string | null) ?? null,
      metadata: { edit_id: editId, change_found: false },
    });
    const { data: filenameRow } = await db
      .from("documents")
      .select("filename")
      .eq("id", documentId)
      .single();
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        (filenameRow?.filename as string) ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;

  // Clear the hash before the bytes change, and set it again after. The
  // stored object and the hash live in different systems, so they cannot be
  // written atomically; ordering it this way means a failure in between
  // leaves the version unhashed — which the export manifest reports as
  // unverifiable. The opposite ordering can leave a hash attesting to
  // content the version no longer holds, the one thing the manifest must
  // never do.
  if (active) {
    await db
      .from("document_versions")
      .update({ content_sha256: null })
      .eq("id", active.id);
  }

  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  if (active) {
    await db
      .from("document_versions")
      .update({
        content_sha256: contentSha256(ab),
        size_bytes: ab.byteLength,
      })
      .eq("id", active.id);
  }

  // The DOCX bytes changed in place, so the version's cached PDF rendition
  // is now stale — GET /display prefers it for DOCX, so the viewer kept
  // showing the unresolved tracked change forever (issue #111). Rebuild it
  // best-effort; on failure clear the pointer so /display falls back to the
  // (correct) DOCX path rather than serving stale bytes.
  if (active?.pdf_storage_path) {
    try {
      const pdfBuf = await docxToPdf(Buffer.from(resolvedBytes));
      const pdfAb = pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer;
      await uploadFile(active.pdf_storage_path, pdfAb, "application/pdf");
    } catch (err) {
      console.warn(
        "[edit-resolution] PDF rendition rebuild failed — clearing pointer:",
        err instanceof Error ? err.message : err,
      );
      await db
        .from("document_versions")
        .update({ pdf_storage_path: null })
        .eq("id", active.id);
    }
  }

  const { error: statusErr } = await db
    .from("document_edits")
    .update({
      status: mode === "accept" ? "accepted" : "rejected",
      resolved_at: new Date().toISOString(),
    })
    .eq("id", editId);
  if (statusErr) {
    console.error("[edit-resolution] status update failed");
    return void res.status(500).json({ detail: "Failed to update edit" });
  }

  // Workspace audit trail (#27) — fire-and-forget.
  void recordAuditEvent({
    userId,
    eventType:
      mode === "accept" ? "document.edit_accepted" : "document.edit_rejected",
    documentId,
    projectId: (doc.project_id as string | null) ?? null,
    metadata: { edit_id: editId },
  });

  const { count: remainingPending } = await db
    .from("document_edits")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("status", "pending");

  const { data: filenameRow } = await db
    .from("documents")
    .select("filename")
    .eq("id", documentId)
    .single();
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      (filenameRow?.filename as string) ?? "document.docx",
    ),
    remaining_pending: remainingPending ?? 0,
  };
  res.json(payload);
  } finally {
    let unlockFailed = false;
    if (lockHeld) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
          documentId,
        ]);
      } catch (unlockErr) {
        // If we couldn't release the session-level advisory lock, DON'T
        // return this connection to the pool with the lock still held — the
        // next checkout would inherit it and deadlock. Destroy it instead.
        unlockFailed = true;
        console.error("[edit-resolution] advisory unlock failed:", unlockErr);
      }
    }
    lockClient.release(unlockFailed);
  }
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

/**
 * Lower-level document ingestion. Takes raw bytes + a filename and
 * walks them through the full pipeline (storage upload, structure
 * extraction, DOCX→PDF conversion, document_versions row, status flip).
 *
 * This is the single source of truth for "putting a file into Eulex Desk";
 * the standalone and project multipart upload routes and the integrations
 * import endpoint (Google Drive / OneDrive / Box) all call into here so any
 * future pipeline change is picked up by every path automatically.
 *
 * Throws on validation/storage errors (`UnsupportedFileTypeError` for a
 * format outside lib/fileTypes). Caller is responsible for mapping
 * exceptions to HTTP responses.
 */
export async function processDocumentBytes(params: {
  userId: string;
  projectId: string | null;
  filename: string;
  content: Buffer;
  db: ReturnType<typeof createServerSupabase>;
  /**
   * Provenance fields, only set when the file came from an external
   * file-source connector. NULL for direct multipart uploads.
   */
  source?: {
    provider: "google_drive" | "onedrive" | "box";
    external_id: string;
    revision: string | null;
  };
}): Promise<Record<string, unknown>> {
  const { userId, projectId, filename, content, db, source } = params;

  // "txt" exists for the chat composer's long-paste → attachment flow; it
  // skips the DOCX→PDF rendition (text-only pipeline).
  const suffix = assertSupportedUploadType(
    filename,
    source ? `connector:${source.provider}` : projectId ? "project" : "standalone",
  );

  const insertPayload: Record<string, unknown> = {
    project_id: projectId,
    user_id: userId,
    filename,
    file_type: suffix,
    size_bytes: content.byteLength,
    status: "processing",
  };
  if (source) {
    insertPayload.source_provider = source.provider;
    insertPayload.source_external_id = source.external_id;
    insertPayload.source_revision = source.revision;
    insertPayload.source_imported_at = new Date().toISOString();
  }

  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert(insertPayload)
    .select("*")
    .single();
  if (insertErr || !doc) {
    throw new Error(
      `Failed to create document record: ${insertErr?.message ?? "unknown"}`,
    );
  }

  try {
    const docId = doc.id as string;
    const key = storageKey(userId, docId, filename);
    const contentType = contentTypeForUpload(suffix);
    const ab = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    await uploadFile(key, ab, contentType);

    const tree = await extractStructureTree(ab, suffix, filename);
    const pageCount = suffix === "pdf" ? await countPdfPages(ab) : null;

    let pdfStoragePath: string | null = null;
    if (suffix === "docx" || suffix === "doc") {
      try {
        const pdfBuf = await docxToPdf(content);
        const pdfKey = convertedPdfKey(userId, docId);
        await uploadFile(
          pdfKey,
          pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
          ) as ArrayBuffer,
          "application/pdf",
        );
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(
          `[upload] DOCX→PDF conversion failed for ${filename}:`,
          err,
        );
      }
    } else if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "upload",
        version_number: 1,
        display_name: filename,
        size_bytes: content.byteLength,
        content_sha256: contentSha256(content),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record upload version: ${verErr?.message ?? "unknown"}`,
      );
    }

    await db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        size_bytes: content.byteLength,
        page_count: pageCount,
        structure_tree: tree ?? null,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId);

    // Workspace audit trail (#27) — fire-and-forget, ids and enums only
    // (no filenames). Covers direct uploads AND connector imports.
    void recordFeatureUse({ userId, feature: "document", projectId });
    void recordAuditEvent({
      userId,
      eventType: "document.uploaded",
      documentId: docId,
      projectId,
      metadata: {
        file_type: suffix,
        size_bytes: content.byteLength,
        ...(source ? { source_provider: source.provider } : {}),
      },
    });

    const { data: updated } = await db
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();
    return updated
      ? { ...updated, storage_path: key, pdf_storage_path: pdfStoragePath }
      : { id: docId, storage_path: key, pdf_storage_path: pdfStoragePath };
  } catch (e) {
    await db.from("documents").update({ status: "error" }).eq("id", doc.id);
    throw e instanceof Error
      ? e
      : new Error(`Document processing failed: ${String(e)}`);
  }
}

/** Multipart upload → processDocumentBytes → HTTP response. Shared by the
 *  standalone (`POST /single-documents`) and project
 *  (`POST /projects/:id/documents`) upload routes. */
export async function handleDocumentUpload(
  req: import("express").Request,
  res: import("express").Response,
  userId: string,
  projectId: string | null,
  db: ReturnType<typeof createServerSupabase>,
) {
  const file = req.file;
  if (!file) return void res.status(400).json({ detail: "file is required" });

  try {
    const responseDoc = await processDocumentBytes({
      userId,
      projectId,
      filename: normalizeUploadFilename(file.originalname),
      content: file.buffer,
      db,
    });
    return void res.status(201).json(responseDoc);
  } catch (e) {
    if (e instanceof UnsupportedFileTypeError) {
      return void res.status(400).json(e.toResponseBody());
    }
    const msg = e instanceof Error ? e.message : String(e);
    return void res.status(500).json({ detail: msg });
  }
}

async function countPdfPages(buf: ArrayBuffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(buf) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

async function extractStructureTree(
  content: ArrayBuffer,
  fileType: string,
  _filename: string,
): Promise<unknown[] | null> {
  try {
    // Plain text (pasted-text attachments) carries no useful outline;
    // mammoth below would throw on a non-zip buffer anyway.
    if (fileType === "txt") return null;
    if (fileType === "pdf") {
      const pdfjsLib = await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
      );
      const pdf = await (
        pdfjsLib as unknown as {
          getDocument: (opts: unknown) => {
            promise: Promise<{
              numPages: number;
              getOutline: () => Promise<{ title?: string }[]>;
            }>;
          };
        }
      ).getDocument({ data: new Uint8Array(content) }).promise;
      if (pdf.numPages <= 5) return null;
      const outline = await pdf.getOutline();
      if (outline?.length)
        return outline.map((item, i) => ({
          id: `h1-${i}`,
          title: item.title ?? `Item ${i + 1}`,
          level: 1,
          page_number: null,
          children: [],
        }));
      return Array.from({ length: pdf.numPages }, (_, i) => ({
        id: `page-${i + 1}`,
        title: `Page ${i + 1}`,
        level: 1,
        page_number: i + 1,
        children: [],
      }));
    } else {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(content),
      });
      const lines = result.value.split("\n").filter((l) => l.trim());
      const nodes = lines
        .slice(0, 30)
        .map((line, i) => ({
          id: `h1-${i}`,
          title: line.slice(0, 100),
          level: 1,
          page_number: null,
          children: [],
        }));
      return nodes.length ? nodes : null;
    }
  } catch {
    return null;
  }
}
