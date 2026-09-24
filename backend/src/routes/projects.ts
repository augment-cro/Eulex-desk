import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  can,
  getEntitlements,
  intEntitlement,
  minTierForEntitlement,
} from "../lib/entitlements";
import { createServerSupabase } from "../lib/supabase";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  contentSha256,
} from "../lib/documentVersions";
import {
  buildProjectExportManifest,
  projectManifestFilename,
} from "../lib/projectExportManifest";
import { safeErrorLog } from "../lib/safeError";
import { downloadFile, uploadFile, storageKey, deleteFile } from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import { handleDocumentUpload } from "./documents";
import { contentTypeForUpload, isSupportedUploadType } from "../lib/fileTypes";
import { textCachePathsFor } from "../lib/documentText";
import { checkProjectAccess, type ProjectAccess } from "../lib/access";
import { normalizeUploadFilename } from "../lib/filenameUtf8";
import { normalizeSharedEmails } from "../lib/sharing";
import { singleFileUpload } from "../lib/upload";
import { recordAuditEvent } from "../lib/audit";

export const projectsRouter = Router();

// GET /projects
//
// ?include=documents additionally returns each project's `documents` array
// (same rows/shape as GET /projects/:projectId), fetched with ONE batched
// query across all projects — the directory modal used to fan out one
// GET /projects/:id per project instead (#26 N+1). Without the param the
// response is unchanged.
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const includeDocuments = String(req.query.include ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes("documents");
  const db = createServerSupabase();

  const { data: ownProjects, error: ownError } = await db
    .from("projects")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (ownError) return void res.status(500).json({ detail: ownError.message });

  // `shared_with` is stored lowercased (lib/sharing.ts), but users.email can
  // be mixed-case — an exact `@>` match hid shared projects from those users
  // while checkProjectAccess (which lowercases) let their API calls through
  // (issue #108).
  const sharedEmail = userEmail?.toLowerCase();
  const { data: sharedProjects, error: sharedError } = sharedEmail
    ? await db
        .from("projects")
        .select("*")
        .contains("shared_with", [sharedEmail])
        .neq("user_id", userId)
        .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (sharedError)
    return void res.status(500).json({ detail: sharedError.message });

  const projects = [...(ownProjects ?? []), ...(sharedProjects ?? [])].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const projectIds = projects.map((p) => p.id as string);

  // Batched counts: three `.in()` queries total instead of three count
  // queries PER project (#26 bonus). Tally project_id occurrences in JS.
  const docCounts = new Map<string, number>();
  const chatCounts = new Map<string, number>();
  const reviewCounts = new Map<string, number>();
  if (projectIds.length > 0) {
    const [docRows, chatRows, reviewRows] = await Promise.all([
      db.from("documents").select("project_id").in("project_id", projectIds),
      db
        .from("chats")
        .select("project_id")
        .in("project_id", projectIds)
        // Soft-deleted chats (migration 132) don't count.
        .neq("status", "deleted"),
      db
        .from("tabular_reviews")
        .select("project_id")
        .in("project_id", projectIds),
    ]);
    const tally = (
      rows: { data: unknown },
      counts: Map<string, number>,
    ) => {
      for (const r of (rows.data ?? []) as { project_id: string | null }[]) {
        if (!r.project_id) continue;
        counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1);
      }
    };
    tally(docRows, docCounts);
    tally(chatRows, chatCounts);
    tally(reviewRows, reviewCounts);
  }

  // ?include=documents — one batched query for every project's documents,
  // with the same per-doc enrichment (active version paths + latest
  // version numbers, both single-round-trip helpers) as GET /projects/:id.
  let docsByProject: Map<string, Record<string, unknown>[]> | null = null;
  if (includeDocuments) {
    docsByProject = new Map();
    if (projectIds.length > 0) {
      const { data: allDocs, error: docsError } = await db
        .from("documents")
        .select("*")
        .in("project_id", projectIds)
        .order("created_at", { ascending: true });
      if (docsError)
        return void res.status(500).json({ detail: docsError.message });
      const docsTyped = (allDocs ?? []) as unknown as {
        id: string;
        project_id: string;
        current_version_id?: string | null;
      }[];
      await attachLatestVersionNumbers(db, docsTyped);
      await attachActiveVersionPaths(db, docsTyped);
      for (const d of docsTyped) {
        const list = docsByProject.get(d.project_id) ?? [];
        list.push(d as unknown as Record<string, unknown>);
        docsByProject.set(d.project_id, list);
      }
    }
  }

  const result = projects.map((p) => ({
    ...p,
    is_owner: p.user_id === userId,
    document_count: docCounts.get(p.id as string) ?? 0,
    chat_count: chatCounts.get(p.id as string) ?? 0,
    review_count: reviewCounts.get(p.id as string) ?? 0,
    ...(docsByProject
      ? { documents: docsByProject.get(p.id as string) ?? [] }
      : {}),
  }));
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  // Normalise recipients: lowercase + dedupe + drop empties + drop self.
  const cleanedShared = normalizeSharedEmails(shared_with, userEmail);

  const db = createServerSupabase();

  // Saved-project cap (Free = 5; 0 = unlimited). Enforced inline because
  // it's a numeric limit, not a boolean entitlement.
  const tierLevelId = res.locals.tierLevelId as number | undefined;
  if (typeof tierLevelId === "number") {
    const maxProjects = intEntitlement(
      await getEntitlements(tierLevelId),
      "maxSavedProjects",
    );
    if (maxProjects > 0) {
      const { count } = await db
        .from("projects")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (typeof count === "number" && count >= maxProjects) {
        return void res.status(403).json({
          detail: `Dosegnut je limit od ${maxProjects} spremljenih projekata za vašu pretplatu.`,
          code: "TIER_REQUIRED",
          feature: "maxSavedProjects",
          required: minTierForEntitlement("fullWorkbench"),
          limit: maxProjects,
        });
      }
    }
  }

  // Sharing a predmet with other users is a Team-tier capability.
  if (cleanedShared.length > 0) {
    const tl = res.locals.tierLevelId as number | undefined;
    const ent = typeof tl === "number" ? await getEntitlements(tl) : null;
    if (!can(ent, "addUsersToProjects")) {
      return void res.status(403).json({
        detail: "Dodavanje korisnika na predmet zahtijeva Team pretplatu.",
        code: "TIER_REQUIRED",
        feature: "addUsersToProjects",
        required: "team",
      });
    }
  }

  const { data, error } = await db
    .from("projects")
    .insert({
      user_id: userId,
      name: name.trim(),
      cm_number: cm_number ?? null,
      shared_with: cleanedShared,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json({ ...data, documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project, error } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (error || !project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    // Lowercase both sides — see issue #108 / checkProjectAccess.
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.some(
        (e: string) => e.toLowerCase() === userEmail.toLowerCase(),
      ));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docsTyped,
    folders: folderData ?? [],
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const { data: project } = await db
    .from("projects")
    .select("id, user_id, shared_with")
    .eq("id", projectId)
    .single();
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? (project.shared_with as string[])
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  // Query users table directly (replaces Supabase auth.admin.listUsers)
  const { data: allUsersRaw } = await db.from("users").select("id, email");
  const allUsers = (allUsersRaw ?? []) as { id: string; email: string }[];
  const userByEmail = new Map<string, { id: string; email: string }>();
  const userById = new Map<string, { id: string; email: string }>();
  for (const u of allUsers) {
    if (!u.email) continue;
    const lower = u.email.toLowerCase();
    userByEmail.set(lower, { id: u.id, email: u.email });
    userById.set(u.id, { id: u.id, email: u.email });
  }

  const memberUserIds: string[] = [];
  for (const email of sharedWith) {
    const u = userByEmail.get(email);
    if (u) memberUserIds.push(u.id);
  }

  const profileIds = [
    project.user_id as string,
    ...memberUserIds,
  ].filter((x, i, arr) => arr.indexOf(x) === i);

  const profileByUserId = new Map<
    string,
    { display_name: string | null; organisation: string | null }
  >();
  if (profileIds.length > 0) {
    const { data: profiles } = await db
      .from("user_profiles")
      .select("user_id, display_name, organisation")
      .in("user_id", profileIds);
    for (const p of profiles ?? []) {
      profileByUserId.set(p.user_id as string, {
        display_name: (p.display_name as string | null) ?? null,
        organisation: (p.organisation as string | null) ?? null,
      });
    }
  }

  const ownerInfo = userById.get(project.user_id as string);
  const owner = {
    user_id: project.user_id,
    email: ownerInfo?.email ?? null,
    display_name:
      profileByUserId.get(project.user_id as string)?.display_name ?? null,
  };
  const members = sharedWith.map((email) => {
    const u = userByEmail.get(email);
    const display_name = u
      ? profileByUserId.get(u.id)?.display_name ?? null
      : null;
    return { email, display_name };
  });

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const updates: Record<string, unknown> = {};
  if (req.body.name != null) updates.name = req.body.name;
  // An explicit `null` clears the CM number; `undefined` (key absent) leaves
  // it untouched. `!= null` treated both as "no change", so the UI could
  // never clear the field (issue #100).
  if (req.body.cm_number !== undefined) {
    updates.cm_number =
      typeof req.body.cm_number === "string" && req.body.cm_number.trim()
        ? req.body.cm_number.trim()
        : null;
  }
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties + drop self.
    const cleaned = normalizeSharedEmails(req.body.shared_with, userEmail);
    updates.shared_with = cleaned;
    // Adding users to a predmet is a Team-tier capability. Un-sharing
    // (empty list) is always allowed.
    if (cleaned.length > 0) {
      const tl = res.locals.tierLevelId as number | undefined;
      const ent = typeof tl === "number" ? await getEntitlements(tl) : null;
      if (!can(ent, "addUsersToProjects")) {
        return void res.status(403).json({
          detail: "Dodavanje korisnika na predmet zahtijeva Team pretplatu.",
          code: "TIER_REQUIRED",
          feature: "addUsersToProjects",
          required: "team",
        });
      }
    }
  }

  const db = createServerSupabase();
  const { data, error } = await db
    .from("projects")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Project not found" });

  // Workspace audit trail (#27) — sharing changes only; counts, no emails.
  if (Array.isArray(updates.shared_with))
    void recordAuditEvent({
      userId,
      eventType: "project.sharing_changed",
      projectId,
      metadata: { shared_count: (updates.shared_with as string[]).length },
    });

  const [{ data: docs }, { data: folderData }] = await Promise.all([
    db.from("documents").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
    db.from("project_subfolders").select("*").eq("project_id", projectId).order("created_at", { ascending: true }),
  ]);
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json({ ...data, documents: docsTyped, folders: folderData ?? [] });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  const db = createServerSupabase();

  // Ownership check first — the delete below is scoped the same way, but we
  // must not enumerate/erase storage for a project the caller doesn't own.
  const { data: owned } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", userId)
    .single();
  if (!owned) return void res.status(404).json({ detail: "Project not found" });

  // The DB cascade drops documents + document_versions, taking their
  // storage paths with them. Collect and erase the bytes FIRST, or every
  // object is orphaned in GCS forever with nothing left to point at it —
  // unbounded cost, and client documents retained after a user-initiated
  // delete (issue #106). Best-effort, mirroring the single-document path.
  const { data: projectDocs } = await db
    .from("documents")
    .select("id")
    .eq("project_id", projectId);
  const docIds = (projectDocs ?? []).map((d: { id: string }) => d.id);
  if (docIds.length > 0) {
    const { data: versions } = await db
      .from("document_versions")
      .select("storage_path, pdf_storage_path")
      .in("document_id", docIds);
    await Promise.all(
      (versions ?? []).flatMap(
        (v: { storage_path?: string; pdf_storage_path?: string }) =>
          [
            v.storage_path,
            v.pdf_storage_path,
            ...(v.storage_path ? textCachePathsFor(v.storage_path) : []),
          ]
            .filter((p): p is string => typeof p === "string" && p.length > 0)
            .map((p) =>
              deleteFile(p).catch((err) => {
                console.warn(
                  "[projects] storage delete failed (orphan left):",
                  p,
                  err instanceof Error ? err.message : err,
                );
              }),
            ),
      ),
    );
  }

  const { error } = await db
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const { data: docs } = await db
    .from("documents")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  const docsTyped = (docs ?? []) as unknown as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachActiveVersionPaths(db, docsTyped);
  res.json(docsTyped);
});

// GET /projects/:projectId/export — tamper-evident manifest of the project's
// documents: every version with its content_sha256 plus the accept/reject
// edit trail, under a SHA-256 digest that is Ed25519-signed when the
// deployment has MANIFEST_SIGNING_KEY set. To check an export, recompute a
// downloaded file's SHA-256 and compare, then check the manifest's signature
// against the key served at GET /manifest-signing-key.
projectsRouter.get("/:projectId/export", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  try {
    const manifest = await buildProjectExportManifest(db, projectId);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${projectManifestFilename(projectId)}"`,
    );
    res.json(manifest);
  } catch (err) {
    console.error("[projects/export] failed", {
      projectId,
      error: safeErrorLog(err),
    });
    // Generic detail on purpose — the underlying error can carry table or
    // storage internals that don't belong in an HTTP response.
    res
      .status(500)
      .json({ detail: "Failed to build project export manifest" });
  }
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const { data: doc } = await db
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", userId)
      .single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const { data: updated, error } = await db
        .from("documents")
        .update({ project_id: projectId, updated_at: new Date().toISOString() })
        .eq("id", documentId)
        .select("*")
        .single();
      if (error || !updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const { data: copy, error } = await db
        .from("documents")
        .insert({
          project_id: projectId,
          user_id: userId,
          filename: doc.filename,
          file_type: doc.file_type,
          size_bytes: doc.size_bytes,
          page_count: doc.page_count,
          structure_tree: doc.structure_tree,
          status: doc.status,
        })
        .select("*")
        .single();
      if (error || !copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        const { data: srcV } = await db
          .from("document_versions")
          .select(
            "storage_path, pdf_storage_path, version_number, display_name, source",
          )
          .eq("id", doc.current_version_id)
          .single();
        if (srcV?.storage_path) {
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id as string, doc.filename);
          const srcType = (doc.file_type as string | null) ?? "";
          const contentType = isSupportedUploadType(srcType)
            ? contentTypeForUpload(srcType)
            : "application/octet-stream";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdf_storage_path);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id as string);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const { data: newV } = await db
            .from("document_versions")
            .insert({
              document_id: copy.id,
              storage_path: newKey,
              pdf_storage_path: newPdfPath,
              source: (srcV.source as string | null) ?? "upload",
              version_number: srcV.version_number ?? 1,
              display_name: srcV.display_name ?? doc.filename,
              size_bytes: srcBytes.byteLength,
              content_sha256: contentSha256(srcBytes),
            })
            .select("id")
            .single();
          copyVersionRowId = (newV?.id as string | null) ?? null;
          if (copyVersionRowId) {
            await db
              .from("documents")
              .update({ current_version_id: copyVersionRowId })
              .eq("id", copy.id);
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents
projectsRouter.post(
  "/:projectId/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const db = createServerSupabase();

    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    await handleDocumentUpload(req, res, userId, projectId, db);
  },
);

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
//
// Pagination: ?limit=N&offset=M (same defaults as GET /chat).
const PROJECT_CHAT_DEFAULT_LIMIT = 100;
const PROJECT_CHAT_MAX_LIMIT = 500;

projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const rawLimit = parseInt(req.query.limit as string, 10);
  const rawOffset = parseInt(req.query.offset as string, 10);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? rawLimit : PROJECT_CHAT_DEFAULT_LIMIT, 1),
    PROJECT_CHAT_MAX_LIMIT,
  );
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);

  // Soft-deleted chats (migration 132) never list. Archived chats stay
  // visible in the project tab — the project view has no archive UI, so
  // hiding them here would strand them.
  const { data, error, count } = await db
    .from("chats")
    .select("*", { count: "exact" })
    .eq("project_id", projectId)
    .neq("status", "deleted")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return void res.status(500).json({ detail: error.message });

  const rows = data ?? [];
  const total = typeof count === "number" ? count : undefined;
  const hasMore = total !== undefined ? offset + rows.length < total : rows.length === limit;

  if (total !== undefined) {
    res.setHeader("X-Total-Count", String(total));
  }
  res.setHeader(
    "X-Pagination",
    JSON.stringify({ limit, offset, total, has_more: hasMore }),
  );

  res.json(rows);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as { name: string; parent_folder_id?: string | null };
  // `name?.trim()` throws on a non-string (number/object) inside this bare
  // async handler → unhandled rejection → the request hangs (issue #109).
  if (typeof name !== "string" || !name.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const { data: parent } = await db.from("project_subfolders").select("id").eq("id", parent_folder_id).eq("project_id", projectId).single();
    if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db.from("project_subfolders").insert({
    project_id: projectId,
    user_id: userId,
    name: name.trim(),
    parent_folder_id: parent_folder_id ?? null,
  }).select("*").single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const body = req.body as { name?: string; parent_folder_id?: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name != null) {
    // Non-string name → `.trim()` throws → hung request (issue #109).
    if (typeof body.name !== "string" || !body.name.trim())
      return void res.status(400).json({ detail: "name must be a non-empty string" });
    updates.name = body.name.trim();
  }
  if ("parent_folder_id" in body) {
    // Cycle check: walk up the tree from the proposed parent to ensure folderId is not an ancestor
    if (body.parent_folder_id) {
      const parent = await loadProjectFolder(db, projectId, body.parent_folder_id);
      if (!parent) return void res.status(404).json({ detail: "Parent folder not found" });

      let cur: string | null = body.parent_folder_id;
      // Visited-set backstop: if a cycle already exists (two concurrent
      // moves can slip past this pre-UPDATE check), this loop would spin
      // forever issuing one query per iteration (issue #110).
      const seen = new Set<string>();
      while (cur) {
        if (cur === folderId) return void res.status(400).json({ detail: "Cannot move a folder into itself or a descendant" });
        if (seen.has(cur))
          return void res
            .status(409)
            .json({ detail: "Folder hierarchy contains a cycle", code: "FOLDER_CYCLE" });
        seen.add(cur);
        const p = await loadProjectFolder(db, projectId, cur);
        if (!p) return void res.status(404).json({ detail: "Parent folder not found" });
        cur = p?.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await db.from("project_subfolders")
    .update(updates)
    .eq("id", folderId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Folder not found" });
  res.json(data);
});

/**
 * Folder deletion is owner-only (#26): it cascade-drops every subfolder and
 * re-homes documents, so a shared member must not be able to tear down the
 * owner's folder structure. Exported for the authz-gate unit tests.
 */
export function folderDeleteAllowed(access: ProjectAccess): boolean {
  return access.ok && access.isOwner;
}

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete("/:projectId/folders/:folderId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, folderId } = req.params;
  const db = createServerSupabase();

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });
  // Owner-only — mirror the resource-hiding 404 the other owner-only routes
  // in this file (PATCH/DELETE /projects/:projectId) respond with.
  if (!folderDeleteAllowed(access))
    return void res.status(404).json({ detail: "Folder not found" });

  const folder = await loadProjectFolder(db, projectId, folderId);
  if (!folder) return void res.status(404).json({ detail: "Folder not found" });

  // Move direct documents to root before cascade-deleting subfolders
  await db.from("documents").update({ folder_id: null }).eq("folder_id", folderId).eq("project_id", projectId);

  const { error } = await db.from("project_subfolders")
    .delete().eq("id", folderId).eq("project_id", projectId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch("/:projectId/documents/:documentId/folder", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { folder_id } = req.body as { folder_id: string | null };

  const db = createServerSupabase();
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return void res.status(404).json({ detail: "Project not found" });

  if (folder_id) {
    const folder = await loadProjectFolder(db, projectId, folder_id);
    if (!folder) return void res.status(404).json({ detail: "Folder not found" });
  }

  const { data, error } = await db.from("documents")
    .update({ folder_id: folder_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", documentId).eq("project_id", projectId)
    .select("*").single();
  if (error || !data) return void res.status(404).json({ detail: "Document not found" });
  res.json(data);
});

async function loadProjectFolder(
  db: ReturnType<typeof createServerSupabase>,
  projectId: string,
  folderId: string,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await db
    .from("project_subfolders")
    .select("id, parent_folder_id")
    .eq("id", folderId)
    .eq("project_id", projectId)
    .maybeSingle();
  return (data as { id: string; parent_folder_id: string | null } | null) ?? null;
}
