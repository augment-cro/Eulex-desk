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
 *   POST   /pii/sessions/:id/attach-chat          — adopt a pre-chat preview
 *                                                   session as the chat's
 *                                                   session (#16 follow-up).
 *   POST   /pii/sessions/:id/apply-overrides      — persist user choices.
 *   POST   /pii/sessions/:id/disclose-placeholder — reveal one mapping.
 *   POST   /pii/sessions/:id/render               — render an assistant
 *                                                   message client-side.
 *   GET    /pii/sessions/:id                      — session meta + summary.
 *   GET    /pii/version                           — engine version.
 *
 * Every route runs through requireAuth so the user-id is taken from
 * the verified JWT, NOT from the body. End-user session ownership is
 * enforced HERE (userOwnsSession); the sidecar independently verifies
 * the CALLING SERVICE (Google-signed OIDC ID token / shared secret —
 * see mike-pii-shield/app/auth.py, #52), not the end user.
 */

import { Router } from "express";
import { recordAuditEvent, recordFeatureUse } from "../lib/audit";
import { requireAuth } from "../middleware/auth";
import { requireEntitlement } from "../lib/entitlements";
import { getPool } from "../lib/db";
import { piiClient, type PiiMode } from "../lib/pii";
import { downloadFile } from "../lib/storage";
import { extractDocumentText } from "../lib/documentText";
import { isSupportedUploadType } from "../lib/fileTypes";

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
    /** Present for document previews; absent for typed composer text
     *  (#16 — strict mode reviews every input, not just documents). */
    document_version_id?: string;
    /** Reuse an existing (standalone) session instead of creating a new
     *  one per preview — the fresh assistant page threads this so every
     *  pre-chat preview shares one session that later gets adopted by
     *  the chat via /sessions/:id/attach-chat. */
    session_id?: string;
    text: string;
    mode?: PiiMode;
    language?: "hr" | "en";
}

piiRouter.post("/sessions/preview", requireAuth, requireEntitlement("piiAnonymization"), async (req, res) => {
    const userId = res.locals.userId as string;
    void recordFeatureUse({ userId, feature: "pii" });
    void recordAuditEvent({ userId, eventType: "pii.session_started" });
    const body = req.body as PreviewBody;
    if (!body?.text) {
        return res.status(400).json({
            error: "missing_fields",
            detail: "text is required",
        });
    }
    if (!piiClient.isConfigured()) {
        return res.status(503).json({ error: "pii_shield_unavailable" });
    }

    // session_id (when present) wins over chat_id in the sidecar's
    // resolution order; the sidecar itself 403s on owner mismatch.
    const result = await piiClient.anonymize({
        text: body.text,
        userId,
        mode: body.mode ?? "standard",
        language: body.language ?? "hr",
        sessionId: body.session_id ?? null,
        chatId: body.chat_id ?? null,
        documentVersionId: body.document_version_id ?? null,
        source: body.document_version_id ? "document" : "user_input",
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
    /** Fresh-page session threading — see PreviewBody.session_id. */
    session_id?: string;
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
            if (!isSupportedUploadType(fileType) && fileType !== "md") {
                return res.status(415).json({
                    error: "unsupported_file_type",
                    detail: `file_type='${doc.file_type}' is not supported for preview.`,
                });
            }
            let text = "";
            try {
                // Same extractor — and, for PDFs, the same persisted OCR
                // transcription — as chat read_document, so the analysis
                // the user reviews here is of the exact text the model reads.
                text = await extractDocumentText({
                    fileType: fileType === "md" ? "txt" : fileType,
                    bytes: raw,
                    flavor: "plain",
                    geminiApiKey: process.env.GEMINI_API_KEY ?? null,
                    storagePath,
                });
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
                sessionId: body.session_id ?? null,
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
//  POST /pii/sessions/:id/attach-chat                                     //
// ----------------------------------------------------------------------- //
//
// Adopt a standalone preview session as THE session of a freshly created
// chat (#16 follow-up). The fresh assistant page runs the strict review
// modal BEFORE the chat row exists; the frontend calls this right after
// /chat/create so the first turn's anonymization (keyed by chat_id)
// resolves to the reviewed session — with the user's disclosure
// overrides — instead of spawning a second, override-less one.
// 409 = adoption came too late (chat already has a session, or the
// preview session is bound elsewhere); callers proceed — entities just
// stay masked, which is the fail-safe direction.

piiRouter.post("/sessions/:id/attach-chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const sessionId = req.params.id;
    const chatId = req.body?.chat_id;
    // Both ids reach Postgres as uuid params — reject non-uuids up front
    // so a malformed body surfaces 400 instead of a raw cast error.
    const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof chatId !== "string" || !UUID_RE.test(chatId)) {
        return res.status(400).json({
            error: "missing_fields",
            detail: "chat_id (uuid) is required",
        });
    }
    if (!UUID_RE.test(sessionId)) {
        return res.status(400).json({ error: "invalid_session_id" });
    }
    if (!piiClient.isConfigured()) {
        return res.status(503).json({ error: "pii_shield_unavailable" });
    }
    // Chat ownership: the session side is enforced by the sidecar
    // (user_id in the payload), but the chat id comes from the client —
    // verify it's the caller's chat before binding PII state to it.
    const pool = await getPool();
    const chatR = await pool.query(
        `SELECT id FROM public.chats
          WHERE id = $1 AND user_id = $2 AND status <> 'deleted'`,
        [chatId, userId],
    );
    if (chatR.rows.length === 0) {
        return res.status(404).json({ error: "chat_not_found" });
    }
    const result = await piiClient.attachChat({ sessionId, chatId, userId });
    if (!result.ok) {
        return res.status(result.status ?? 502).json({
            error: "attach_failed",
            detail: result.error,
        });
    }
    return res.json({ session_id: result.data.id, chat_id: result.data.chat_id });
});

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
        const {
            masked_placeholders,
            approved_for_disclosure,
            disclosure_reasons,
            text,
        } = req.body ?? {};
        // Per-placeholder audit reasons (#55): forward only well-formed
        // string→string pairs so a malformed body can't pollute the
        // shield's audit metadata.
        const disclosureReasons: Record<string, string> = {};
        if (disclosure_reasons && typeof disclosure_reasons === "object") {
            for (const [ph, reason] of Object.entries(
                disclosure_reasons as Record<string, unknown>,
            )) {
                if (typeof reason === "string" && reason.trim()) {
                    disclosureReasons[ph] = reason.trim();
                }
            }
        }
        const result = await piiClient.applyOverrides({
            sessionId,
            maskedPlaceholders: Array.isArray(masked_placeholders)
                ? masked_placeholders
                : [],
            approvedForDisclosure: Array.isArray(approved_for_disclosure)
                ? approved_for_disclosure
                : [],
            disclosureReasons,
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
        // Through piiClient like every other shield call (#52) — the
        // old hand-rolled fetch sent no OIDC token, so disclosure was
        // dead in prod (Cloud Run 403 before the request ever landed).
        const result = await piiClient.disclosePlaceholder({
            sessionId,
            placeholder,
            reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined,
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
