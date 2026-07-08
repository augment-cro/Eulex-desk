/**
 * Draft Mode — selection-based inline editing.
 *
 * POST /draft/selection-edit
 *   Takes a short selection of text from a DOCX document, a user
 *   instruction, and surrounding context, asks the LLM for a precise
 *   {find, replace, reason} substitution, then applies it as a tracked
 *   change (w:ins / w:del) via the existing `applyTrackedEdits` pipeline.
 *   Returns the resulting edit annotation so the frontend can render the
 *   same Accept/Reject UX as for chat-generated edits.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { enforceRateLimit } from "../lib/rateLimit";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile, uploadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import { applyTrackedEdits } from "../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../lib/downloadTokens";
import { completeText, providerForModel } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { recordLlmUsage } from "../lib/llmUsage";
import {
    enforceLlmTextSafety,
    detectPromptInjection,
    logInjectionFinding,
} from "../lib/promptSecurity";
import { filterAccessibleDocumentIds } from "../lib/access";

export const draftRouter = Router();

// ---------------------------------------------------------------------------
// POST /draft/selection-edit
// ---------------------------------------------------------------------------
//
// Accepts a text selection from a DOCX document plus a natural-language
// instruction, and applies a tracked change to the document. The response
// mirrors the `doc_edited` SSE event annotations shape so the frontend
// reuses the existing Accept/Reject EditCard flow.

draftRouter.post(
    "/selection-edit",
    requireAuth,
    enforceRateLimit(),
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerSupabase();

        const {
            document_id: documentId,
            selected_text: selectedText,
            context_before: contextBefore,
            context_after: contextAfter,
            instruction,
        } = req.body as {
            document_id?: string;
            selected_text?: string;
            context_before?: string;
            context_after?: string;
            instruction?: string;
        };

        // ── Input validation ─────────────────────────────────────────────

        if (!documentId || typeof documentId !== "string") {
            return void res
                .status(400)
                .json({ detail: "document_id is required" });
        }
        if (!selectedText || typeof selectedText !== "string") {
            return void res
                .status(400)
                .json({ detail: "selected_text is required" });
        }
        if (!instruction || typeof instruction !== "string") {
            return void res
                .status(400)
                .json({ detail: "instruction is required" });
        }
        if (selectedText.length > 4000) {
            return void res.status(400).json({
                detail: "selected_text too long (max 4000 chars)",
            });
        }

        // ── Access control ───────────────────────────────────────────────

        const accessible = await filterAccessibleDocumentIds(
            [documentId],
            userId,
            userEmail,
            db,
        );
        if (!accessible.includes(documentId)) {
            return void res
                .status(404)
                .json({ detail: "Document not found" });
        }

        // ── Security: prompt injection check ─────────────────────────────

        const injectionCheck = detectPromptInjection(instruction);
        logInjectionFinding("/draft/selection-edit instruction", userId, injectionCheck);
        if (injectionCheck.severity === "critical") {
            return void res.status(400).json({
                detail: "Instruction contains disallowed content.",
            });
        }

        const selectionCheck = detectPromptInjection(selectedText);
        logInjectionFinding("/draft/selection-edit selected_text", userId, selectionCheck);

        const instructionGuard = enforceLlmTextSafety({
            text: instruction.slice(0, 1000),
            where: "/draft/selection-edit",
            userId,
        });
        if (instructionGuard.block) {
            return void res
                .status(400)
                .json({ detail: "Instruction contains disallowed content." });
        }

        // ── Load document ─────────────────────────────────────────────────

        const { data: doc } = await db
            .from("documents")
            .select("id, filename")
            .eq("id", documentId)
            .single();
        if (!doc) {
            return void res.status(404).json({ detail: "Document not found" });
        }

        const activeVersion = await loadActiveVersion(documentId, db);
        if (!activeVersion) {
            return void res
                .status(422)
                .json({ detail: "Document has no active version" });
        }

        let docBytesRaw: ArrayBuffer;
        try {
            const downloaded = await downloadFile(activeVersion.storage_path);
            if (!downloaded) {
                return void res
                    .status(500)
                    .json({ detail: "Failed to load document bytes" });
            }
            docBytesRaw = downloaded;
        } catch (err) {
            console.error("[draft/selection-edit] downloadFile failed", err);
            return void res
                .status(500)
                .json({ detail: "Failed to load document" });
        }
        const docBytes = Buffer.from(docBytesRaw);

        // ── Ask LLM for edit ──────────────────────────────────────────────

        const { api_keys, preferred_language } = await getUserModelSettings(
            userId,
            db,
        );

        const langHint =
            preferred_language === "hr"
                ? "Croatian (Respond with the replacement text in Croatian)"
                : "the same language as the selected text";

        const systemPrompt = `You are a precise legal document editor. The user has selected a passage from a legal document and wants it revised according to their instruction.

Your task: produce a minimal, targeted edit to the selected text.

Rules:
- Return ONLY valid JSON in the exact format: {"find": "...", "replace": "...", "reason": "..."}
- "find" must be a SUBSTRING of the selected text (keep it as short as possible — ideally just the changed words, not the full selection)
- "replace" is the replacement for "find" (empty string means deletion)
- "reason" is a very short, user-facing explanation (max 15 words) in ${langHint}
- Do NOT include markdown, prose, or any text outside the JSON object
- Preserve original legal terminology where appropriate
- Be conservative — minimal changes are better than sweeping rewrites`;

        const userPrompt = `Document context before selection:
"${(contextBefore ?? "").slice(-200)}"

Selected text to edit:
"${selectedText.slice(0, 2000)}"

Document context after selection:
"${(contextAfter ?? "").slice(0, 200)}"

User instruction: ${instructionGuard.safeText}

Return JSON only:`;

        let llmText = "";
        const startedAt = Date.now();
        try {
            const { text, usage } = await completeText({
                model: "claude-3-5-haiku-20241022",
                systemPrompt,
                user: userPrompt,
                maxTokens: 512,
                apiKeys: api_keys,
            });
            llmText = text.trim();

            if (usage) {
                void recordLlmUsage({
                    userId,
                    provider: providerForModel("claude-3-5-haiku-20241022"),
                    model: "claude-3-5-haiku-20241022",
                    usage,
                    durationMs: Date.now() - startedAt,
                    status: "ok",
                });
            }
        } catch (err) {
            console.error("[draft/selection-edit] LLM call failed", err);
            return void res
                .status(500)
                .json({ detail: "AI edit generation failed" });
        }

        // ── Parse LLM output ──────────────────────────────────────────────

        let editInput: { find: string; replace: string; reason?: string };
        try {
            // Strip any markdown code fences the model may have wrapped
            const cleaned = llmText
                .replace(/^```(?:json)?\s*/i, "")
                .replace(/\s*```$/, "")
                .trim();
            const parsed = JSON.parse(cleaned) as {
                find?: unknown;
                replace?: unknown;
                reason?: unknown;
            };
            if (
                typeof parsed.find !== "string" ||
                typeof parsed.replace !== "string"
            ) {
                throw new Error("Missing find/replace fields");
            }
            editInput = {
                find: parsed.find,
                replace: parsed.replace,
                reason:
                    typeof parsed.reason === "string"
                        ? parsed.reason
                        : undefined,
            };
        } catch (err) {
            console.error(
                "[draft/selection-edit] Failed to parse LLM JSON",
                err,
                llmText,
            );
            return void res.status(500).json({
                detail: "AI returned an unexpected format. Please try again.",
            });
        }

        // ── Apply tracked edit to DOCX ────────────────────────────────────

        const { bytes: editedBytes, changes, errors } = await applyTrackedEdits(
            docBytes,
            [
                {
                    find: editInput.find,
                    replace: editInput.replace,
                    context_before: (contextBefore ?? "").slice(-80),
                    context_after: (contextAfter ?? "").slice(0, 80),
                    reason: editInput.reason,
                },
            ],
            { author: "Mike Draft" },
        );

        if (changes.length === 0) {
            const reason =
                errors[0]?.reason ??
                `Could not locate the text to edit. The document may have changed. (LLM wanted to find: "${editInput.find.slice(0, 60)}")`;
            return void res.status(422).json({ detail: reason });
        }

        // ── Persist new version ───────────────────────────────────────────

        const ab = editedBytes.buffer.slice(
            editedBytes.byteOffset,
            editedBytes.byteOffset + editedBytes.byteLength,
        ) as ArrayBuffer;

        const versionId = crypto.randomUUID().replace(/-/g, "");
        const newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;

        try {
            await uploadFile(
                newPath,
                ab,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            );
        } catch (err) {
            console.error("[draft/selection-edit] uploadFile failed", err);
            return void res
                .status(500)
                .json({ detail: "Failed to save edited document" });
        }

        // Sequential version number (same logic as chatTools.ts applyEdit)
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

        // Inherit display name from previous version
        const { data: prevRow } = await db
            .from("document_versions")
            .select("display_name")
            .eq("document_id", documentId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        const inheritedDisplayName =
            (prevRow?.display_name as string | null) ??
            (doc.filename as string | null) ??
            null;

        const { data: versionRow, error: verErr } = await db
            .from("document_versions")
            .insert({
                document_id: documentId,
                storage_path: newPath,
                source: "assistant_edit",
                version_number: nextVersionNumber,
                display_name: inheritedDisplayName,
            })
            .select("id")
            .single();

        if (verErr || !versionRow) {
            console.error("[draft/selection-edit] version insert failed", verErr);
            return void res
                .status(500)
                .json({ detail: "Failed to record document version" });
        }

        const versionRowId = versionRow.id as string;

        // ── Persist document_edits rows ───────────────────────────────────

        const editRows = changes.map((c) => ({
            document_id: documentId,
            version_id: versionRowId,
            change_id: c.id,
            del_w_id: c.delId ?? null,
            ins_w_id: c.insId ?? null,
            deleted_text: c.deletedText,
            inserted_text: c.insertedText,
            context_before: c.contextBefore ?? "",
            context_after: c.contextAfter ?? "",
            reason: editInput.reason ?? null,
            status: "pending" as const,
        }));

        const { data: insertedEdits, error: editsErr } = await db
            .from("document_edits")
            .insert(editRows)
            .select(
                "id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after",
            );

        if (editsErr || !insertedEdits) {
            console.error("[draft/selection-edit] edits insert failed", editsErr);
            return void res
                .status(500)
                .json({ detail: "Failed to record edits" });
        }

        // Update document's current_version_id
        await db
            .from("documents")
            .update({ current_version_id: versionRowId })
            .eq("id", documentId);

        // ── Build response ────────────────────────────────────────────────

        const annotations = insertedEdits.map(
            (r: {
                id: string;
                change_id: string;
                del_w_id: string | null;
                ins_w_id: string | null;
                deleted_text: string;
                inserted_text: string;
                context_before: string | null;
                context_after: string | null;
            }) => {
                const src = changes.find((c) => c.id === r.change_id);
                return {
                    kind: "edit",
                    edit_id: r.id,
                    document_id: documentId,
                    version_id: versionRowId,
                    version_number: nextVersionNumber,
                    change_id: r.change_id,
                    del_w_id: src?.delId ?? null,
                    ins_w_id: src?.insId ?? null,
                    deleted_text: r.deleted_text ?? "",
                    inserted_text: r.inserted_text ?? "",
                    context_before: r.context_before ?? "",
                    context_after: r.context_after ?? "",
                    reason: editInput.reason,
                    status: "pending",
                };
            },
        );

        const downloadUrl = buildDownloadUrl(
            newPath,
            doc.filename as string,
        );

        console.log("[draft/selection-edit] success", {
            documentId,
            versionRowId,
            nextVersionNumber,
            changesCount: changes.length,
        });

        res.json({
            ok: true,
            document_id: documentId,
            filename: doc.filename,
            version_id: versionRowId,
            version_number: nextVersionNumber,
            download_url: downloadUrl,
            annotations,
            errors,
        });
    },
);
