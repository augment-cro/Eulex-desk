import { useCallback, useRef, useState } from "react";
import {
    getChat,
    streamChat,
    streamProjectChat,
    type ApiMessage,
    type StreamChatPayload,
} from "../lib/api";

export type ChatRole = "user" | "assistant";

/**
 * One assistant-proposed edit, sourced from the backend's
 * `doc_edited` SSE event. The Word add-in surfaces these as Apply
 * cards rendered against the user's open .docx via Office.js — so
 * everything the card needs to (a) locate the range and (b) audit the
 * landing spot to the user lives inline on the proposal.
 */
export interface EditProposal {
    /** Server-side annotation id (from the new .docx version). Used as a
     *  React key + to dedupe when the stream replays. */
    id?: string;
    /** Source document the LLM thinks this edit targets. Only shown in
     *  the UI when multiple docs were edited in one turn. */
    filename?: string;
    document_id?: string;
    version_id?: string;
    /** Text the LLM wants to replace inside the open Word doc. */
    find: string;
    /** Replacement text. */
    replace: string;
    /** ~40 chars right before `find` — surfaced on the card so the user
     *  can audit which paragraph the change will land in. */
    context_before?: string;
    /** ~40 chars right after `find`. */
    context_after?: string;
    /** Free-form rationale; rendered as italic on the card and inserted
     *  as a Word comment alongside the tracked change. */
    reason?: string;
}

export interface ChatMessage {
    id: string;
    role: ChatRole;
    content: string;
    /**
     * Reasoning text streamed before the visible content. Surfaced as a
     * dimmed "thinking" panel in the UI.
     */
    reasoning?: string;
    /** Documents the assistant created during this turn. */
    docs?: {
        filename: string;
        download_url?: string;
        document_id?: string;
    }[];
    /** Files attached to a user turn (for display only). */
    files?: { filename: string; document_id?: string }[];
    /**
     * Edit proposals streamed via the backend's `doc_edited` event. The
     * Word add-in renders one Apply card per entry — clicking Apply
     * runs Office.js' search + tracked-change replacement against the
     * user's open .docx (no round-trip to the server).
     */
    edits?: EditProposal[];
    /**
     * The user's chosen application mode at compose time. Sticks to the
     * assistant message so the Apply cards know which of "track" /
     * "comments" should get the primary-button styling, even after page
     * reloads or chat-history reload.
     */
    editMode?: "track" | "comments";
    /** True while the SSE stream is actively writing into this message. */
    streaming?: boolean;
}

export interface SendOptions {
    /** Optional project context — switches to the per-project /chat endpoint. */
    projectId?: string | null;
    /** Files attached to this turn (already uploaded). */
    files?: { filename: string; document_id?: string }[];
    /** Selection text from the open Word document. */
    selection?: { text: string; has_selection: boolean };
    /** Edit mode hint for the agent. */
    editMode?: "track" | "comments";
    /** Where assistant-generated content lands. */
    creationMode?: "project" | "this_word_doc";
    /** Optional model override. */
    model?: string;
    /** Workflow handed off from the Workflows tab. */
    workflow?: { id: string; title: string };
    /** Formatted summary of existing tracked changes to include as context. */
    trackedChangesContext?: string;
}

interface UseChatState {
    messages: ChatMessage[];
    chatId: string | null;
    isStreaming: boolean;
    error: string | null;
}

function uid(): string {
    return Math.random().toString(36).slice(2, 11);
}

/**
 * SSE event types we consume from the backend. There are more upstream
 * (citations, tool_call, doc_read, …); we ignore those in the add-in for
 * now to keep the message UI simple.
 */
type DocEditAnnotation = {
    edit_id?: string;
    find?: string;
    replace?: string;
    context_before?: string;
    context_after?: string;
    reason?: string;
};

type ServerEvent =
    | { type: "chat_id"; chatId: string }
    | { type: "content_delta"; text: string }
    | { type: "content_done" }
    | { type: "reasoning_delta"; text: string }
    | { type: "reasoning_block_end" }
    | { type: "doc_created_start"; filename: string }
    | {
          type: "doc_created";
          filename: string;
          download_url?: string;
          document_id?: string;
      }
    | { type: "doc_edited_start"; filename: string }
    | {
          type: "doc_edited";
          filename: string;
          document_id: string;
          version_id?: string;
          download_url?: string;
          annotations?: DocEditAnnotation[];
          edit_mode?: "track" | "comments";
          client?: "web" | "word";
      }
    | { type: "error"; detail?: string }
    | { type: string; [key: string]: unknown };

export function useChat() {
    const [state, setState] = useState<UseChatState>({
        messages: [],
        chatId: null,
        isStreaming: false,
        error: null,
    });
    const abortRef = useRef<AbortController | null>(null);
    // Mirror messages in a ref so the SSE handler can patch the latest
    // assistant message without re-binding on every render.
    const messagesRef = useRef<ChatMessage[]>([]);
    messagesRef.current = state.messages;

    const updateAssistant = useCallback(
        (mutate: (msg: ChatMessage) => ChatMessage) => {
            setState((prev) => {
                const messages = [...prev.messages];
                const lastIdx = messages.length - 1;
                if (lastIdx < 0 || messages[lastIdx].role !== "assistant") {
                    return prev;
                }
                messages[lastIdx] = mutate(messages[lastIdx]);
                return { ...prev, messages };
            });
        },
        [],
    );

    const send = useCallback(
        async (text: string, opts: SendOptions = {}) => {
            const trimmed = text.trim();
            if (!trimmed) return;
            if (state.isStreaming) return;

            const userMsg: ChatMessage = {
                id: uid(),
                role: "user",
                content: trimmed,
                files: opts.files,
            };
            const assistantMsg: ChatMessage = {
                id: uid(),
                role: "assistant",
                content: "",
                streaming: true,
                // Pin the user's chosen mode onto the assistant message so
                // the Apply card can pick the right primary button later
                // — even after a chat-history reload that drops live opts.
                editMode: opts.editMode,
            };

            const apiMessages: ApiMessage[] = [
                ...messagesRef.current
                    .filter((m) => m.content.trim().length > 0)
                    .map((m) => ({
                        role: m.role,
                        content: m.content,
                        files: m.files,
                    })),
                {
                    role: "user",
                    content: trimmed,
                    files: opts.files,
                },
            ];

            setState((prev) => ({
                ...prev,
                messages: [...prev.messages, userMsg, assistantMsg],
                isStreaming: true,
                error: null,
            }));

            const controller = new AbortController();
            abortRef.current = controller;

            // Enrich selection context with tracked changes summary
            // when the user toggled the "Changes" button.
            let selectionPayload = opts.selection;
            if (opts.trackedChangesContext && selectionPayload) {
                selectionPayload = {
                    ...selectionPayload,
                    text:
                        selectionPayload.text +
                        "\n\n" +
                        opts.trackedChangesContext,
                };
            } else if (opts.trackedChangesContext && !selectionPayload) {
                selectionPayload = {
                    text: opts.trackedChangesContext,
                    has_selection: false,
                };
            }

            const payload: StreamChatPayload = {
                messages: apiMessages,
                chat_id: state.chatId ?? undefined,
                model: opts.model,
                files: opts.files,
                workflow: opts.workflow,
                selection: selectionPayload,
                editMode: opts.editMode,
                creation_mode: opts.creationMode,
                // Tells the backend to inject the Word add-in addendum
                // into the system prompt and to echo `editMode` on
                // doc_edited events. Without this the model would
                // happily emit `find` strings longer than what
                // `Word.body.search()` can match.
                client: "word",
                signal: controller.signal,
            };

            try {
                const res = opts.projectId
                    ? await streamProjectChat({
                          ...payload,
                          projectId: opts.projectId,
                      })
                    : await streamChat(payload);

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    throw new Error(errText || `chat ${res.status}`);
                }
                const reader = res.body?.getReader();
                if (!reader) throw new Error("No response body");

                const decoder = new TextDecoder();
                let buffer = "";

                // Buffer reasoning until block_end so we don't churn the
                // assistant message on every token.
                let reasoningBuffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    for (const raw of lines) {
                        const trimmedLine = raw.trim();
                        if (!trimmedLine.startsWith("data:")) continue;
                        const json = trimmedLine.slice(5).trim();
                        if (!json || json === "[DONE]") continue;

                        let evt: ServerEvent;
                        try {
                            evt = JSON.parse(json);
                        } catch {
                            continue;
                        }

                        switch (evt.type) {
                            case "chat_id": {
                                const chatId = (evt as { chatId: string })
                                    .chatId;
                                setState((prev) => ({ ...prev, chatId }));
                                break;
                            }
                            case "content_delta": {
                                const text = (evt as { text: string }).text ?? "";
                                updateAssistant((m) => ({
                                    ...m,
                                    content: m.content + text,
                                }));
                                break;
                            }
                            case "reasoning_delta": {
                                reasoningBuffer +=
                                    (evt as { text: string }).text ?? "";
                                updateAssistant((m) => ({
                                    ...m,
                                    reasoning: reasoningBuffer,
                                }));
                                break;
                            }
                            case "reasoning_block_end": {
                                reasoningBuffer = "";
                                break;
                            }
                            case "doc_created":
                            case "doc_created_start": {
                                const filename =
                                    (evt as { filename?: string }).filename ??
                                    "Document.docx";
                                const download_url = (
                                    evt as { download_url?: string }
                                ).download_url;
                                const document_id = (
                                    evt as { document_id?: string }
                                ).document_id;
                                updateAssistant((m) => {
                                    const docs = [...(m.docs ?? [])];
                                    const existing = docs.find(
                                        (d) => d.filename === filename,
                                    );
                                    if (existing) {
                                        if (download_url)
                                            existing.download_url =
                                                download_url;
                                        if (document_id)
                                            existing.document_id =
                                                document_id;
                                    } else {
                                        docs.push({
                                            filename,
                                            download_url,
                                            document_id,
                                        });
                                    }
                                    return { ...m, docs };
                                });
                                break;
                            }
                            case "doc_edited_start": {
                                // Cosmetic — the card list itself is
                                // populated when `doc_edited` arrives.
                                // We could surface a "Preparing
                                // edits…" chip here later if we want
                                // mid-flight feedback inside the
                                // assistant bubble.
                                break;
                            }
                            case "doc_edited": {
                                const e = evt as {
                                    filename: string;
                                    document_id: string;
                                    version_id?: string;
                                    annotations?: DocEditAnnotation[];
                                    edit_mode?: "track" | "comments";
                                };
                                const incoming: EditProposal[] = (
                                    e.annotations ?? []
                                )
                                    .filter(
                                        (a) =>
                                            typeof a?.find === "string" &&
                                            typeof a?.replace === "string",
                                    )
                                    .map((a) => ({
                                        id: a.edit_id,
                                        filename: e.filename,
                                        document_id: e.document_id,
                                        version_id: e.version_id,
                                        find: a.find as string,
                                        replace: a.replace as string,
                                        context_before: a.context_before,
                                        context_after: a.context_after,
                                        reason: a.reason,
                                    }));
                                if (incoming.length === 0) break;
                                updateAssistant((m) => {
                                    const existing = m.edits ?? [];
                                    // Dedupe on edit_id when the
                                    // backend supplies one (it does
                                    // for every annotation since
                                    // they're persisted DB rows). On
                                    // chat reload + re-stream this
                                    // keeps us from doubling cards.
                                    const seen = new Set(
                                        existing
                                            .map((x) => x.id)
                                            .filter(Boolean) as string[],
                                    );
                                    const merged = [...existing];
                                    for (const e of incoming) {
                                        if (e.id && seen.has(e.id)) continue;
                                        if (e.id) seen.add(e.id);
                                        merged.push(e);
                                    }
                                    return {
                                        ...m,
                                        edits: merged,
                                        // Honor whatever editMode the
                                        // server echoes — covers the
                                        // case where the user hadn't
                                        // pinned one client-side.
                                        editMode:
                                            m.editMode ?? e.edit_mode,
                                    };
                                });
                                break;
                            }
                            case "error": {
                                const detail = (evt as { detail?: string })
                                    .detail;
                                throw new Error(detail || "Stream error");
                            }
                            default:
                                break;
                        }
                    }
                }

                updateAssistant((m) => ({ ...m, streaming: false }));
                setState((prev) => ({ ...prev, isStreaming: false }));
            } catch (err) {
                if (
                    err instanceof DOMException &&
                    err.name === "AbortError"
                ) {
                    updateAssistant((m) => ({ ...m, streaming: false }));
                    setState((prev) => ({ ...prev, isStreaming: false }));
                    return;
                }
                const message =
                    err instanceof Error ? err.message : String(err);
                updateAssistant((m) => ({ ...m, streaming: false }));
                setState((prev) => ({
                    ...prev,
                    isStreaming: false,
                    error: message,
                }));
            } finally {
                abortRef.current = null;
            }
        },
        [state.chatId, state.isStreaming, updateAssistant],
    );

    const stop = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    const reset = useCallback(() => {
        abortRef.current?.abort();
        setState({
            messages: [],
            chatId: null,
            isStreaming: false,
            error: null,
        });
    }, []);

    /**
     * Replace the current conversation with a previously persisted one.
     * Used by the chat-history drawer to resume an old conversation —
     * the next `send()` call will keep streaming into the same chat_id.
     */
    const loadChat = useCallback(async (chatId: string) => {
        abortRef.current?.abort();
        setState({
            messages: [],
            chatId,
            isStreaming: false,
            error: null,
        });
        try {
            const detail = await getChat(chatId);
            const messages: ChatMessage[] = (detail.messages ?? [])
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m) => {
                    // Backend persists assistant turns with `content` set
                    // to the events array (not raw text). We pull
                    // `content_delta` text out for display, and lift
                    // `doc_edited` / `doc_created` events back into the
                    // structured `edits` / `docs` shape so reloading a
                    // chat re-shows the Apply cards.
                    if (m.role === "assistant" && Array.isArray(m.content)) {
                        const events = m.content as Record<string, unknown>[];
                        let text = "";
                        const docs: ChatMessage["docs"] = [];
                        const edits: EditProposal[] = [];
                        for (const ev of events) {
                            const t = ev?.type as string | undefined;
                            if (t === "content") {
                                text +=
                                    typeof ev.text === "string" ? ev.text : "";
                            } else if (
                                t === "doc_created" &&
                                typeof ev.filename === "string"
                            ) {
                                docs.push({
                                    filename: ev.filename,
                                    download_url:
                                        typeof ev.download_url === "string"
                                            ? ev.download_url
                                            : undefined,
                                    document_id:
                                        typeof ev.document_id === "string"
                                            ? ev.document_id
                                            : undefined,
                                });
                            } else if (
                                t === "doc_edited" &&
                                Array.isArray(ev.annotations)
                            ) {
                                for (const a of ev.annotations as DocEditAnnotation[]) {
                                    if (
                                        typeof a?.find !== "string" ||
                                        typeof a?.replace !== "string"
                                    )
                                        continue;
                                    edits.push({
                                        id: a.edit_id,
                                        filename:
                                            typeof ev.filename === "string"
                                                ? ev.filename
                                                : undefined,
                                        document_id:
                                            typeof ev.document_id === "string"
                                                ? ev.document_id
                                                : undefined,
                                        version_id:
                                            typeof ev.version_id === "string"
                                                ? ev.version_id
                                                : undefined,
                                        find: a.find,
                                        replace: a.replace,
                                        context_before: a.context_before,
                                        context_after: a.context_after,
                                        reason: a.reason,
                                    });
                                }
                            }
                        }
                        return {
                            id: m.id,
                            role: "assistant" as ChatRole,
                            content: text,
                            docs: docs.length ? docs : undefined,
                            edits: edits.length ? edits : undefined,
                        };
                    }
                    return {
                        id: m.id,
                        role: m.role as ChatRole,
                        content:
                            typeof m.content === "string" ? m.content : "",
                        files: Array.isArray(m.files)
                            ? (m.files as ChatMessage["files"])
                            : undefined,
                    };
                });
            setState({
                messages,
                chatId,
                isStreaming: false,
                error: null,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setState({
                messages: [],
                chatId: null,
                isStreaming: false,
                error: message,
            });
        }
    }, []);

    return { ...state, send, stop, reset, loadChat };
}
