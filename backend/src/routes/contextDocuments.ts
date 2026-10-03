/**
 * POST /internal/context-documents — ingest a file that belongs to a Custom
 * Context (service-to-core: the contexts-service's import script, token
 * iss "contexts", aud "eulex-desk"). The file goes through the ordinary
 * documents pipeline under the reserved owner SYSTEM_CONTEXT_OWNER (a fixed
 * UUID no user has) and the
 * route returns its document id, which the pack stores as a source of kind
 * "document". Idempotent by content: the same bytes return the existing
 * document instead of creating a copy.
 *
 * Body: { filename: string, content_base64: string }
 */
import { Router } from "express";
import { verifyInboundServiceToken } from "../lib/seams/serviceIdentity";
import { SYSTEM_CONTEXT_OWNER, ensureSystemContextOwner } from "../lib/seams/contextDocuments";
import { createServerSupabase } from "../lib/supabase";
import { contentSha256 } from "../lib/documentVersions";
import { processDocumentBytes } from "./documents";

// base64 inflates by 4/3 and Cloud Run caps HTTP/1 requests at 32 MiB.
const MAX_BYTES = 20 * 1024 * 1024;

export function createContextDocumentsRouter(): Router {
    const router = Router();

    router.post("/", async (req, res) => {
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const identity = token ? verifyInboundServiceToken(token) : null;
        if (!identity || identity.service !== "contexts") {
            return void res.status(401).json({ error: "unauthorized" });
        }
        const { filename, content_base64 } = (req.body ?? {}) as Record<string, unknown>;
        if (typeof filename !== "string" || !filename.trim() || typeof content_base64 !== "string") {
            return void res.status(400).json({ error: "filename and content_base64 are required" });
        }
        const content = Buffer.from(content_base64, "base64");
        if (content.byteLength === 0 || content.byteLength > MAX_BYTES) {
            return void res.status(400).json({ error: `file must be 1 byte – ${MAX_BYTES} bytes` });
        }
        const db = createServerSupabase();
        try {
            const sha = contentSha256(content);
            const { data: versions } = await db
                .from("document_versions")
                .select("document_id")
                .eq("content_sha256", sha);
            const candidateIds = [...new Set(((versions ?? []) as { document_id: string }[]).map((v) => v.document_id))];
            if (candidateIds.length > 0) {
                const { data: existing } = await db
                    .from("documents")
                    .select("id, filename, status")
                    .in("id", candidateIds)
                    .eq("user_id", SYSTEM_CONTEXT_OWNER)
                    .eq("status", "ready");
                const hit = ((existing ?? []) as { id: string; filename: string }[])[0];
                if (hit) return void res.json({ document_id: hit.id, filename: hit.filename, created: false });
            }
            await ensureSystemContextOwner(db);
            const doc = await processDocumentBytes({
                userId: SYSTEM_CONTEXT_OWNER,
                projectId: null,
                filename: filename.trim(),
                content,
                db,
            });
            res.status(201).json({ document_id: doc.id, filename: doc.filename, created: true });
        } catch (err) {
            console.error("[context-documents] ingest failed:", err);
            res.status(500).json({ error: err instanceof Error ? err.message : "ingest failed" });
        }
    });

    return router;
}
