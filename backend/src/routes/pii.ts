/**
 * /pii — frontend-facing HTTP routes.
 *
 * The sidecar is `--ingress=internal` so the browser cannot call it
 * directly. This router is the thin, authenticated proxy:
 *
 *   POST   /pii/sessions/preview                  — anonymize one document
 *                                                   for the review modal.
 *   POST   /pii/documents/:documentId/preview     — extract text from a
 *                                                   stored document + anonymize.
 *                                                   Used by the chat composer
 *                                                   so the browser never sees
 *                                                   the raw text.
 *   POST   /pii/sessions/:id/apply-overrides      — persist user choices.
 *   POST   /pii/sessions/:id/disclose-placeholder — reveal one mapping.
 *   POST   /pii/sessions/:id/render               — render an assistant
 *                                                   message client-side.
 *   GET    /pii/sessions/:id                      — session meta + summary.
 *   GET    /pii/version                           — engine version.
 *
 * Every route runs through requireAuth so the user-id is taken from
 * the verified JWT, NOT from the body. The sidecar still re-verifies
 * via the OIDC token + RLS, but defense-in-depth.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireEntitlement } from "../lib/entitlements";
import { getPool } from "../lib/db";
import { piiClient, type PiiMode } from "../lib/pii";
import { downloadFile } from "../lib/storage";
import { extractDocxBodyText } from "../lib/docxTrackedChanges";
import { extractPdfText } from "../lib/chatTools";

export const piiRouter = Router();

// ----------------------------------------------------------------------- //
//  Authorisation helpers                                                  //
// ----------------------------------------------------------------------- //

async function userOwnsSession(
    userId: string,
    sessionId: string,
): Promise<boolean> {
    // Since #14 the pii_* tables live in the shield's own database, so
    // ownership is resolved via the sidecar instead of direct SQL.
    const result = await piiClient.getSession(sessionId);
    if (!result.ok) {
        if (result.status !== 404) {
            console.warn(
                "[pii] userOwnsSession sidecar lookup failed:",
                result.error,
            );
        }
        // Fail closed when we can't verify — unknown session or an
        // unreachable sidecar both short-circuit to 403 upstream.
        return false;
    }
    return result.data.user_id === userId;
}

// ----------------------------------------------------------------------- //
//  POST /pii/sessions/preview                                             //
// ----------------------------------------------------------------------- //

interface PreviewBody {
    chat_id?: string;
    document_version_id: string;
    text: string;
    mode?: PiiMode;
    language?: "hr" | "en";
}

piiRouter.post("/sessions/preview", requireAuth, requireEntitlement("piiAnonymization"), async (req, res) => {
    const userId = res.locals.userId as string;
    const body = req.body as PreviewBody;
    if (!body?.text || !body?.document_version_id) {
        return res.status(400).json({
            error: "missing_fields",
            detail: "text and document_version_id are required",
        });
    }
    if (!piiClient.isConfigured()) {
        return res.status(503).json({ error: "pii_shield_unavailable" });
    }

    const result = await piiClient.anonymize({
        text: body.text,
        userId,
        mode: body.mode ?? "standard",
        language: body.language ?? "hr",
        chatId: body.chat_id ?? null,
        documentVersionId: body.document_version_id,
        source: "document",
    });
    if (!result.ok) {
        return res.status(result.status ?? 502).json({
            error: "sidecar_failure",
            detail: result.error,
        });
    }
    return res.json({
        session_id: result.data.session_id,
        entities: result.data.entities,
        entity_summary: result.data.entity_summary,
        // The anonymized text is for preview only; the frontend uses
        // it to render the diff modal but does not pass it back.
        preview_text: result.data.anonymized_text,
    });
});

// ----------------------------------------------------------------------- //
//  POST /pii/documents/:documentId/preview                                //
// ----------------------------------------------------------------------- //
//
// Sister-endpoint of /pii/sessions/preview, but the *text* is resolved
// server-side from a stored document instead of being sent by the
// browser. The chat composer calls this right after a successful
// upload so the user can review what the sidecar would mask BEFORE
// the document is attached to an LLM turn.
//
// Why a separate route from /sessions/preview:
//
//   1. **Privacy**: in strict modes the document text is exactly the
//      kind of payload we don't want flowing through the browser. The
//      backend is already a trust boundary that holds the GCS reader
//      credentials; piping bytes through the client would be a step
//      backward.
//
//   2. **Cost / latency**: PDF documents go through Gemini OCR
//      (~10-30 s, ~1-3 cents per turn). The client doesn't need that
//      text — only the entity list + placeholders. Round-tripping
//      bytes wastes both time and money on every modal open.
//
//   3. **Ownership**: we already enforce document ownership for every
//      other document op via `public.documents.user_id`. Reusing that
//      check is cheaper than re-deriving it from an opaque blob.
//
// Output is bytewise identical to /sessions/preview so the modal
// component doesn't branch on source.
// ----------------------------------------------------------------------- //

interface DocPreviewBody {
    chat_id?: string;
    mode?: PiiMode;
    language?: "hr" | "en";
}

interface DocRow {
    user_id: string;
    current_version_id: string | null;
    file_type: string | null;
    filename: string;
}

interface VersionRow {
    id: string;
    storage_path: string;
}

piiRouter.post(
    "/documents/:documentId/preview",
    requireAuth,
    requireEntitlement("piiAnonymization"),
    async (req, res) => {
        const userId = res.locals.userId as string;
        const documentId = req.params.documentId;
        const body = (req.body ?? {}) as DocPreviewBody;

        if (!piiClient.isConfigured()) {
            return res.status(503).json({ error: "pii_shield_unavailable" });
        }

        try {
            const pool = await getPool();

            const docR = await pool.query<DocRow>(
                `SELECT user_id, current_version_id, file_type, filename
                   FROM public.documents WHERE id = $1`,
                [documentId],
            );
            if (docR.rows.length === 0) {
                return res.status(404).json({ error: "document_not_found" });
            }
            const doc = docR.rows[0];
            if (doc.user_id !== userId) {
                return res.status(403).json({ error: "document_owner_mismatch" });
            }
            if (!doc.current_version_id) {
                return res.status(409).json({
                    error: "no_current_version",
                    detail: "Document has no current version row.",
                });
            }

            const vR = await pool.query<VersionRow>(
                `SELECT id, storage_path FROM public.document_versions
                  WHERE id = $1`,
                [doc.current_version_id],
            );
            if (vR.rows.length === 0) {
                return res.status(404).json({ error: "version_not_found" });
            }
            const versionId = vR.rows[0].id;
            const storagePath = vR.rows[0].storage_path;

            const raw = await downloadFile(storagePath);
            if (!raw) {
                return res.status(502).json({
                    error: "storage_download_failed",
                    detail: "Could not read document bytes from object storage.",
                });
            }

            const fileType = (doc.file_type ?? "").toLowerCase();
            let text = "";
            try {
                if (fileType === "pdf") {
                    text = await extractPdfText(
                        raw,
                        process.env.GEMINI_API_KEY ?? null,
                    );
                } else if (fileType === "docx") {
                    text = await extractDocxBodyText(Buffer.from(raw));
                    if (!text) {
                        const mammoth = await import("mammoth");
                        const r = await mammoth.extractRawText({
                            buffer: Buffer.from(raw),
                        });
                        text = r.value ?? "";
                    }
                } else if (fileType === "doc") {
                    const WordExtractor = (await import("word-extractor"))
                        .default;
                    const extractor = new WordExtractor();
                    const d = await extractor.extract(Buffer.from(raw));
                    text = d.getBody();
                } else if (fileType === "txt" || fileType === "md") {
                    text = Buffer.from(raw).toString("utf8");
                } else {
                    return res.status(415).json({
                        error: "unsupported_file_type",
                        detail: `file_type='${doc.file_type}' is not supported for preview.`,
                    });
                }
            } catch (err) {
                console.error(
                    `[pii] preview extraction failed doc=${documentId} fileType="${fileType}":`,
                    err instanceof Error ? err.stack ?? err.message : err,
                );
                return res.status(500).json({ error: "extraction_failed" });
            }

            if (!text || text.trim().length === 0) {
                return res.status(422).json({
                    error: "empty_text",
                    detail:
                        "Extracted document text was empty. The file may be an image-only PDF without OCR-able content.",
                });
            }

            const result = await piiClient.anonymize({
                text,
                userId,
                mode: body.mode ?? "standard",
                language: body.language ?? "hr",
                chatId: body.chat_id ?? null,
                documentVersionId: versionId,
                source: "document",
            });
            if (!result.ok) {
                // The sidecar's own status is forwarded verbatim, so a
                // sidecar HTTP 500 surfaces here as a 500 with no other
                // trace. Log it explicitly — this is the only record that
                // a /preview failed because /anonymize did.
                console.error(
                    `[pii] /anonymize failed doc=${documentId} version=${versionId} status=${result.status ?? "n/a"}:`,
                    result.error,
                );
                return res.status(result.status ?? 502).json({
                    error: "sidecar_failure",
                    detail: result.error,
                });
            }
            return res.json({
                session_id: result.data.session_id,
                entities: result.data.entities,
                entity_summary: result.data.entity_summary,
                preview_text: result.data.anonymized_text,
                document_version_id: versionId,
                filename: doc.filename,
            });
        } catch (err) {
            console.error(
                `[pii] preview failed doc=${documentId} user=${userId}:`,
                err instanceof Error ? err.stack ?? err.message : err,
            );
            return res.status(500).json({ error: "internal_error" });
        }
    },
);

// ----------------------------------------------------------------------- //
//  POST /pii/sessions/:id/apply-overrides                                 //
// ----------------------------------------------------------------------- //

piiRouter.post(
    "/sessions/:id/apply-overrides",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const sessionId = req.params.id;
        if (!(await userOwnsSession(userId, sessionId))) {
            return res.status(403).json({ error: "session_owner_mismatch" });
        }
        const { masked_placeholders, approved_for_disclosure, text } = req.body ?? {};
        const result = await piiClient.applyOverrides({
            sessionId,
            maskedPlaceholders: Array.isArray(masked_placeholders)
                ? masked_placeholders
                : [],
            approvedForDisclosure: Array.isArray(approved_for_disclosure)
                ? approved_for_disclosure
                : [],
            text: typeof text === "string" ? text : undefined,
        });
        if (!result.ok) {
            return res.status(result.status ?? 502).json({
                error: "sidecar_failure",
                detail: result.error,
            });
        }
        return res.json(result.data);
    },
);

// ----------------------------------------------------------------------- //
//  POST /pii/sessions/:id/disclose-placeholder                            //
// ----------------------------------------------------------------------- //

piiRouter.post(
    "/sessions/:id/disclose-placeholder",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const sessionId = req.params.id;
        if (!(await userOwnsSession(userId, sessionId))) {
            return res.status(403).json({ error: "session_owner_mismatch" });
        }
        const { placeholder, reason } = req.body ?? {};
        if (typeof placeholder !== "string" || !placeholder) {
            return res.status(400).json({ error: "missing_placeholder" });
        }
        // Direct fetch — sidecar's `/sessions/{id}/disclose-placeholder`.
        // We keep the body shape identical so the proxy stays a one-liner.
        const url = `${process.env.PII_SHIELD_URL?.replace(/\/$/, "")}/sessions/${sessionId}/disclose-placeholder`;
        try {
            const resp = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ placeholder, reason }),
                signal: AbortSignal.timeout(5000),
            });
            const data = await resp.json();
            return res.status(resp.status).json(data);
        } catch (err) {
            return res.status(502).json({
                error: "sidecar_failure",
                detail: err instanceof Error ? err.message : String(err),
            });
        }
    },
);

// ----------------------------------------------------------------------- //
//  POST /pii/sessions/:id/render                                          //
// ----------------------------------------------------------------------- //

piiRouter.post("/sessions/:id/render", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const sessionId = req.params.id;
    if (!(await userOwnsSession(userId, sessionId))) {
        return res.status(403).json({ error: "session_owner_mismatch" });
    }
    const { text } = req.body ?? {};
    if (typeof text !== "string") {
        return res.status(400).json({ error: "missing_text" });
    }
    const result = await piiClient.render({ sessionId, text });
    if (!result.ok) {
        return res.status(result.status ?? 502).json({
            error: "sidecar_failure",
            detail: result.error,
        });
    }
    return res.json(result.data);
});

// ----------------------------------------------------------------------- //
//  GET /pii/sessions/:id                                                  //
// ----------------------------------------------------------------------- //

piiRouter.get("/sessions/:id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const sessionId = req.params.id;
    if (!(await userOwnsSession(userId, sessionId))) {
        return res.status(403).json({ error: "session_owner_mismatch" });
    }
    const result = await piiClient.getSession(sessionId);
    if (!result.ok) {
        return res.status(result.status ?? 502).json({
            error: "sidecar_failure",
            detail: result.error,
        });
    }
    return res.json(result.data);
});

// ----------------------------------------------------------------------- //
//  GET /pii/chats/:chatId/session-id                                      //
// ----------------------------------------------------------------------- //
//
// Returns the active pii_sessions.id for a given chat, or null when no
// session exists yet (chat hasn't run anonymize). Frontend uses this to
// know which session to query when rendering assistant messages with
// placeholders (`⟦PII:PERSON_1⟧` → original).
//
// Only the chat owner can resolve this — we re-check chat ownership
// instead of the session, since the session may not exist yet but the
// chat does.

piiRouter.get("/chats/:chatId/session-id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const chatId = req.params.chatId;

    try {
        const pool = await getPool();
        const ownerR = await pool.query<{ user_id: string }>(
            `SELECT user_id FROM public.chats WHERE id = $1`,
            [chatId],
        );
        if (ownerR.rows.length === 0) {
            return res.status(404).json({ error: "chat_not_found" });
        }
        if (ownerR.rows[0].user_id !== userId) {
            return res.status(403).json({ error: "chat_owner_mismatch" });
        }

        // Since #14: the shield owns pii_sessions — resolve via HTTP.
        const lookup = await piiClient.getChatSession(chatId);
        if (!lookup.ok && lookup.status !== 404) {
            console.warn(
                "[pii] GET /chats/:chatId/session-id sidecar lookup failed:",
                lookup.error,
            );
        }
        return res.json({ session_id: lookup.ok ? lookup.data.id : null });
    } catch (err) {
        console.warn(
            "[pii] GET /chats/:chatId/session-id failed:",
            err instanceof Error ? err.message : err,
        );
        return res.json({ session_id: null });
    }
});

// ----------------------------------------------------------------------- //
//  GET /pii/version                                                       //
// ----------------------------------------------------------------------- //

piiRouter.get("/version", requireAuth, async (_req, res) => {
    if (!piiClient.isConfigured()) {
        return res.status(503).json({ configured: false });
    }
    const result = await piiClient.getVersion();
    if (!result.ok) {
        return res.status(result.status ?? 502).json({
            configured: true,
            ok: false,
            detail: result.error,
        });
    }
    return res.json({ configured: true, ok: true, ...result.data });
});
