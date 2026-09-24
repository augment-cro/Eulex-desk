import type { createServerSupabase } from "./supabase";
import { sealManifest } from "./manifestSigning";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Tamper-evident manifest for one project: every document version with its
 * content_sha256, plus the accept/reject edit trail. To check an exported
 * file against what the workspace held, recompute its SHA-256
 * (`shasum -a 256 <file>`) and compare with the manifest entry.
 *
 * `sealManifest` hashes the body and signs that digest with the deployment's
 * Ed25519 key, if one is configured. Unsigned, the manifest shows the *files*
 * are unmodified but says nothing about itself.
 *
 * Versions written before content hashing shipped carry a null hash rather
 * than a wrong one, so an old file set reads as unverifiable and never as
 * falsely verified.
 *
 * Every listing is ordered by (created_at, id) so the same project always
 * produces the same body — and therefore the same digest — regardless of
 * row insertion order.
 */

const MANIFEST_NOTES = [
    "content_sha256 covers each version's source file bytes only (the file at the version's storage path).",
    "PDF renditions of DOCX versions are derived display artifacts and are not covered by content_sha256.",
    "A null content_sha256 means the version predates content hashing and is unverifiable, not unverified.",
];

export function projectManifestFilename(projectId: string): string {
    const stamp = new Date()
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z")
        .replace(/:/g, "-");
    return `eulex-project-manifest-${projectId.slice(0, 8)}-${stamp}.json`;
}

export async function buildProjectExportManifest(
    db: Db,
    projectId: string,
): Promise<Record<string, unknown>> {
    const { data: project, error: projectError } = await db
        .from("projects")
        .select("id, name, cm_number, created_at")
        .eq("id", projectId)
        .single();
    if (projectError || !project) {
        throw new Error(
            `Failed to load project: ${projectError?.message ?? "not found"}`,
        );
    }

    const { data: docRows, error: docsError } = await db
        .from("documents")
        .select("id, filename, file_type, status, current_version_id, created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
    if (docsError) {
        throw new Error(`Failed to load documents: ${docsError.message}`);
    }
    const documents = (docRows ?? []) as Record<string, unknown>[];
    const documentIds = documents.map((d) => d.id as string);

    let versions: Record<string, unknown>[] = [];
    let edits: Record<string, unknown>[] = [];
    if (documentIds.length > 0) {
        const [versionsRes, editsRes] = await Promise.all([
            db
                .from("document_versions")
                .select(
                    "id, document_id, version_number, source, display_name, content_sha256, size_bytes, pdf_storage_path, created_at",
                )
                .in("document_id", documentIds)
                .order("created_at", { ascending: true })
                .order("id", { ascending: true }),
            db
                .from("document_edits")
                .select(
                    "id, document_id, version_id, change_id, status, created_at, resolved_at",
                )
                .in("document_id", documentIds)
                .order("created_at", { ascending: true })
                .order("id", { ascending: true }),
        ]);
        if (versionsRes.error) {
            throw new Error(
                `Failed to load document versions: ${versionsRes.error.message}`,
            );
        }
        if (editsRes.error) {
            throw new Error(
                `Failed to load document edits: ${editsRes.error.message}`,
            );
        }
        versions = (versionsRes.data ?? []) as Record<string, unknown>[];
        edits = (editsRes.data ?? []) as Record<string, unknown>[];
    }

    const groupByDocument = (rows: Record<string, unknown>[]) => {
        const byDoc = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
            const docId = row.document_id as string;
            const list = byDoc.get(docId) ?? [];
            list.push(row);
            byDoc.set(docId, list);
        }
        return byDoc;
    };
    const versionsByDoc = groupByDocument(versions);
    const editsByDoc = groupByDocument(edits);

    // pg returns timestamp columns as JS Date objects; canonicalize()
    // deliberately rejects non-plain objects, so every date must be
    // serialized to an ISO string (null/undefined and pre-serialized
    // strings pass through).
    const iso = (v: unknown): string | null =>
        v instanceof Date ? v.toISOString() : v == null ? null : String(v);

    return sealManifest({
        manifest_version: 1,
        exported_at: new Date().toISOString(),
        notes: MANIFEST_NOTES,
        project: {
            id: project.id,
            name: project.name,
            cm_number: project.cm_number ?? null,
            created_at: iso(project.created_at),
        },
        documents: documents.map((doc) => ({
            id: doc.id,
            // file_type lives on the documents row in this schema; every
            // version of a document shares it (the type is validated to
            // match on version upload).
            file_type: doc.file_type ?? null,
            status: doc.status,
            current_version_id: doc.current_version_id ?? null,
            created_at: iso(doc.created_at),
            versions: (versionsByDoc.get(doc.id as string) ?? []).map((v) => ({
                id: v.id,
                version_number: v.version_number ?? null,
                source: v.source,
                // display_name is the version's user-facing filename; fall
                // back to the parent document's filename for versions that
                // never got one.
                filename: v.display_name ?? doc.filename ?? null,
                content_sha256: v.content_sha256 ?? null,
                size_bytes: v.size_bytes ?? null,
                // Derived display artifact (DOCX→PDF rendition) — present or
                // not; never covered by content_sha256.
                has_pdf_rendition: v.pdf_storage_path != null,
                created_at: iso(v.created_at),
            })),
            edits: (editsByDoc.get(doc.id as string) ?? []).map((e) => ({
                id: e.id,
                version_id: e.version_id,
                change_id: e.change_id,
                status: e.status,
                created_at: iso(e.created_at),
                resolved_at: iso(e.resolved_at),
            })),
        })),
    });
}
