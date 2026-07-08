import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { enforceRateLimit } from "../lib/rateLimit";
import { createServerSupabase } from "../lib/supabase";
import {
    buildProjectDocContext,
    buildMessages,
    buildWorkflowStore,
    enrichWithPriorEvents,
    extractAnnotations,
    runLLMStream,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
} from "../lib/chatTools";
import { getUserApiKeys } from "../lib/userSettings";
import { recordLlmUsage } from "../lib/llmUsage";
import { checkProjectAccess } from "../lib/access";
import {
    closeMcpServers,
    loadEnabledMcpServersForUser,
} from "../lib/mcp/servers";
import { loadBuiltinMcpServers } from "../lib/mcp/builtin";
import { localeContextForLlm, parseUiLocale, referenceTimeContext } from "../lib/uiLocale";
import { loadContextsForTurn } from "../lib/seams/contextsRuntime";
import {
    detectPromptInjection,
    logInjectionFinding,
    writeSseRefusal,
} from "../lib/promptSecurity";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, enforceRateLimit(), async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const {
        messages,
        chat_id,
        model,
        effort,
        displayed_doc,
        attached_documents,
        client,
        editMode,
        web_search,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        model?: string;
        // Composer web-search toggle (globe icon). See chat.ts — defaults
        // to on when omitted; `false` drops the search tools this turn.
        web_search?: boolean;
        // See chat.ts for `effort` — validated to "low" | "medium" |
        // "high" before forwarding so a malformed client can't crash
        // the provider.
        effort?: string;
        displayed_doc?: { filename: string; document_id: string };
        attached_documents?: { filename: string; document_id: string }[];
        // See chat.ts for `client` / `editMode` semantics — same fields,
        // forwarded so per-project chats from the Word add-in get the
        // same Office.js-friendly tool-use guidance.
        client?: "web" | "word";
        editMode?: "track" | "comments";
    };
    const reasoningEffort: "low" | "medium" | "high" | undefined =
        effort === "low" || effort === "medium" || effort === "high"
            ? effort
            : undefined;

    const db = createServerSupabase();

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        const { data: existing } = await db
            .from("chats")
            .select("id, title, project_id")
            .eq("id", chatId)
            .single();
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else chatTitle = existing!.title;
    }

    if (!chatId) {
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: projectId })
            .select("id, title")
            .single();
        if (error || !newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            // See chat.ts — jsonb column needs JSON literals; wrap the
            // user's plain string so pg can parse it as a JSON string.
            content: JSON.stringify(lastUser.content ?? ""),
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    // SECURITY: same pre-LLM injection check as /chat — see chat.ts for
    // the rationale.
    const uiLocale = parseUiLocale(req);
    const lastUserContent =
        typeof lastUser?.content === "string" ? lastUser.content : "";
    const injectionFinding = detectPromptInjection(lastUserContent);
    logInjectionFinding("/projects/chat", userId, injectionFinding);
    if (injectionFinding.severity === "critical") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Alt-Svc", "clear");
        res.flushHeaders();

        const write = (line: string) => res.write(line);
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
        const { events: refusalEvents } = writeSseRefusal(write, uiLocale);

        try {
            await db.from("chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: refusalEvents,
                annotations: null,
            });
        } catch (err) {
            console.error(
                "[project-chat/stream] failed to persist safety refusal",
                err,
            );
        }
        res.end();
        return;
    }

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
        db,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayed_doc.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (attached_documents?.length) {
        const slugByDocumentId = new Map<string, string>();
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id)
                slugByDocumentId.set(info.document_id, slug);
        }
        const lines = attached_documents.map((d) => {
            const slug = slugByDocumentId.get(d.document_id);
            return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        // Timestamp is omitted from the cached static prefix and re-injected
        // below via the dynamic suffix — a ticking clock in the static block
        // busts the Anthropic prompt cache. Hour-truncated (see
        // referenceTimeContext) so the suffix — and with it the rolling
        // conversation-history cache — stays byte-stable across turns too.
        `${systemPromptExtra}\n\n${localeContextForLlm(uiLocale, { omitReferenceTime: true })}`,
        docIndex,
        referenceTimeContext(uiLocale),
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Force HTTP/2 over TCP for this SSE stream — see chat.ts for the full
    // rationale (Chrome QUIC drops mid-stream when middleboxes cut UDP/443).
    res.setHeader("Alt-Svc", "clear");
    res.flushHeaders();

    // Disable Node's default 2-min request socket timeout — extended-thinking
    // chats with multiple MCP rounds routinely exceed it. The Cloud Run
    // service-level --timeout=3600 still bounds the overall lifetime.
    if (typeof req.setTimeout === "function") req.setTimeout(0);
    if (typeof res.setTimeout === "function") res.setTimeout(0);

    const write = (line: string) => res.write(line);

    // SSE keep-alive heartbeat — see /chat/stream for the rationale.
    const heartbeat = setInterval(() => {
        try {
            res.write(`: keepalive ${Date.now()}\n\n`);
        } catch {
            /* socket closed; cleared in finally */
        }
    }, 15_000);
    req.on("close", () => clearInterval(heartbeat));

    const apiKeys = await getUserApiKeys(userId, db);
    // Per-user connectors come first so they win any slug collision in
    // findMcpServerForTool; built-in (system-side) MCPs follow.
    const [userMcpServers, builtinMcpServers] = await Promise.all([
        loadEnabledMcpServersForUser(userId, db),
        loadBuiltinMcpServers(userId, db),
    ]);
    const mcpServers = [...userMcpServers, ...builtinMcpServers];

    // Contexts active for this project chat: globally-toggled ∪ contexts
    // attached to this project, resolved by the configured context
    // provider. The provider re-checks access per requester, so a private
    // context attached to a shared project never leaks to other members;
    // each part fails soft on its own — see loadContextsForTurn. Never
    // breaks chat, and does nothing at all when no provider is configured.
    const activeContexts = await loadContextsForTurn({
        userId,
        email: userEmail ?? null,
        query: lastUserContent,
        projectId,
    });

    const turnStartedAt = Date.now();
    let usageRecorded = false;

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        // ---- PII Shield context resolution (parity with chat.ts) -----
        const piiContext: import("../lib/chatTools").PiiToolContext | null =
            await (async () => {
                try {
                    const { effectiveMode, piiActive, getChatPiiMode } =
                        await import("../lib/pii");
                    const { getUserModelSettings } = await import("../lib/userSettings");
                    const userSettings = await getUserModelSettings(userId, db);
                    const chatMode = chatId ? await getChatPiiMode(chatId) : null;
                    const mode = effectiveMode(chatMode, userSettings);
                    if (!piiActive(mode) || !chatId) return null;
                    return {
                        userId,
                        chatId,
                        mode,
                        language: uiLocale,
                    };
                } catch (err) {
                    console.warn(
                        "[projectChat/stream] PII context resolution failed (non-fatal):",
                        err instanceof Error ? err.message : err,
                    );
                    return null;
                }
            })();

        // Word export (generate_docx) is a Plus+ entitlement. Fail open on
        // a lookup error so a metering hiccup never breaks doc generation.
        const canExportDocx = await (async (): Promise<boolean> => {
            const tl = res.locals.tierLevelId as number | undefined;
            if (typeof tl !== "number") return true;
            try {
                const { getEntitlements, can } = await import(
                    "../lib/entitlements"
                );
                return can(await getEntitlements(tl), "exportWordMarkdown");
            } catch {
                return true;
            }
        })();

        const {
            fullText,
            events,
            usage,
            selectedModel,
            webSearchCostUsd,
        } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            model,
            reasoningEffort,
            apiKeys,
            projectId,
            mcpServers,
            client: client ?? "web",
            editMode: editMode ?? "track",
            piiContext,
            canExportDocx,
            webSearchEnabled: web_search,
            activeContexts,
        });

        const annotations = extractAnnotations(fullText, docIndex, events);
        const { data: insertedAssistant } = await db
            .from("chat_messages")
            .insert({
                chat_id: chatId,
                role: "assistant",
                content: events.length ? events : null,
                annotations: annotations.length ? annotations : null,
            })
            .select("id")
            .single();

        if (usage) {
            usageRecorded = true;
            await recordLlmUsage({
                userId,
                provider: "claude",
                client: client ?? "web",
                model: selectedModel,
                chatId,
                projectId,
                projectChatMessageId: insertedAssistant?.id ?? null,
                usage,
                durationMs: Date.now() - turnStartedAt,
                status: "ok",
                // See chat.ts — search-provider USD folded into cost_usd.
                extraCostUsd: webSearchCostUsd,
            });
        }

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }
    } catch (err) {
        console.error("[project-chat/stream] error:", err);
        if (!usageRecorded) {
            try {
                await recordLlmUsage({
                    userId,
                    provider: "claude",
                    client: client ?? "web",
                    model: model ?? "unknown",
                    chatId,
                    projectId,
                    usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheCreationInputTokens: 0,
                        cacheReadInputTokens: 0,
                        iterations: 0,
                    },
                    durationMs: Date.now() - turnStartedAt,
                    status: "error",
                    errorMessage:
                        err instanceof Error ? err.message : String(err),
                });
            } catch {
                /* recordLlmUsage already logs its own failures */
            }
        }
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        clearInterval(heartbeat);
        await closeMcpServers(mcpServers);
        res.end();
    }
});
