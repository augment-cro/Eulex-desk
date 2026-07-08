"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat, streamProjectChat } from "@/app/lib/mikeApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useGenerateChatTitle } from "./useGenerateChatTitle";
import { track } from "@/app/lib/analytics";
import { modelTierOf } from "@/app/components/assistant/ModelToggle";
import type {
    AssistantEvent,
    LegalSource,
    MikeAnnotation,
    MikeMessage,
} from "@/app/components/shared/types";

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

/** localStorage key used to detect the account's first-ever message (per browser). */
const FIRST_MESSAGE_FLAG = "mike_sa_first_message";

/**
 * Whether chat_first_message already fired. Cached in-module so the send
 * path does one localStorage read per page load, not per message — and
 * guarded because storage access can throw (Chrome "block site data",
 * Safari private mode); analytics must never break the send flow.
 */
let firstMessageTracked: boolean | null = null;

function trackFirstMessageOnce(surface: string): void {
    if (firstMessageTracked === true) return;
    try {
        if (firstMessageTracked === null) {
            firstMessageTracked = !!localStorage.getItem(FIRST_MESSAGE_FLAG);
            if (firstMessageTracked) return;
        }
        localStorage.setItem(FIRST_MESSAGE_FLAG, "1");
        firstMessageTracked = true;
        track("chat_first_message", { surface });
    } catch {
        // Storage unavailable — skip the event rather than risk the send.
        firstMessageTracked = true;
    }
}

interface UseAssistantChatOptions {
    initialMessages?: MikeMessage[];
    chatId?: string;
    projectId?: string;
}

function findLastContentIndex(events: AssistantEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "content") return i;
    }
    return -1;
}

const PII_OPEN_CHAR = "\u27E6"; // ⟦
const PII_CLOSE_CHAR = "\u27E7"; // ⟧

/**
 * Returns the largest `len <= desiredLen` such that `target.slice(0, len)`
 * doesn't end in the middle of a `⟦PII:…⟧` placeholder. When the desired
 * boundary is mid-placeholder, we back off to the position just before
 * the opening `⟦`, so the next drip tick reveals the whole token at once.
 *
 * Bounded look-back: a placeholder is at most ~64 chars
 * (`⟦PII:` + 50 char entity + `_NNN⟧`), so scanning back 80 chars is
 * always sufficient — keeps the per-tick cost O(1) regardless of message
 * size.
 */
function clampToCompletePlaceholder(target: string, desiredLen: number): number {
    if (desiredLen <= 0 || desiredLen >= target.length) return desiredLen;
    const scanStart = Math.max(0, desiredLen - 80);
    const openIdx = target.lastIndexOf(PII_OPEN_CHAR, desiredLen - 1);
    if (openIdx < scanStart) return desiredLen; // no recent opening bracket
    const closeIdx = target.indexOf(PII_CLOSE_CHAR, openIdx);
    if (closeIdx === -1) {
        // Streaming hasn't received the closing bracket yet — hold the
        // boundary just before `⟦`.
        return openIdx;
    }
    if (closeIdx < desiredLen) return desiredLen; // fully inside window
    return openIdx; // straddles → back off
}

export function useAssistantChat({
    initialMessages = [],
    chatId: initialChatId,
    projectId,
}: UseAssistantChatOptions = {}) {
    const router = useRouter();
    const {
        replaceChatId,
        loadChats,
        setCurrentChatId,
        saveChat,
        setNewChatMessages,
    } = useChatHistoryContext();
    const { generate: generateTitle } = useGenerateChatTitle();

    const [messages, setMessages] = useState<MikeMessage[]>(initialMessages);
    const [isResponseLoading, setIsResponseLoading] = useState(false);
    const [isLoadingCitations, setIsLoadingCitations] = useState(false);
    const [chatId, setChatId] = useState<string | undefined>(initialChatId);

    const abortControllerRef = useRef<AbortController | null>(null);

    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef<string>("");
    const dripDisplayLenRef = useRef<number>(0);
    const eventsRef = useRef<AssistantEvent[]>([]);
    const DRIP_CHARS_PER_TICK = 8;

    const stopDrip = () => {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    };

    const updateLastContentEvent = (
        prev: MikeMessage[],
        text: string,
        isStreaming?: boolean,
    ): MikeMessage[] => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const events = last.events ?? [];
        const idx = findLastContentIndex(events);
        if (idx < 0) return prev;
        const newEvents = [...events];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        updated[updated.length - 1] = { ...last, events: newEvents };
        return updated;
    };

    const flushDrip = () => {
        stopDrip();
        const target = dripTargetRef.current;
        dripDisplayLenRef.current = target.length;
        setMessages((prev) => updateLastContentEvent(prev, target));
    };

    /**
     * Finalize any in-flight streaming content event and reset the drip
     * counters so the next content_delta starts a fresh block. Called
     * before any non-content event is appended, so interleaved content /
     * reasoning / tool events stay in chronological order — without the
     * later content block inheriting the earlier block's accumulated text.
     */
    const finalizeStreamingContent = () => {
        stopDrip();
        const events = eventsRef.current;
        const last = events[events.length - 1];
        if (last?.type === "content" && last.isStreaming) {
            const finalText = dripTargetRef.current;
            eventsRef.current = [
                ...events.slice(0, -1),
                { type: "content", text: finalText },
            ];
            const snapshot = [...eventsRef.current];
            setMessages((prev) => {
                const updated = [...prev];
                const lastMsg = updated[updated.length - 1];
                if (lastMsg?.role === "assistant") {
                    updated[updated.length - 1] = {
                        ...lastMsg,
                        events: snapshot,
                    };
                }
                return updated;
            });
        }
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
    };

    // If the model transitions from reasoning into content/tool without a
    // reasoning_block_end (or the events arrive out of order), the prior
    // reasoning event would otherwise stay flagged isStreaming forever.
    const finalizeStreamingReasoning = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        if (last?.type !== "reasoning" || !last.isStreaming) return;
        eventsRef.current = [
            ...events.slice(0, -1),
            { type: "reasoning", text: last.text },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = {
                    ...lastMsg,
                    events: snapshot,
                };
            }
            return updated;
        });
    };

    const startDrip = () => {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            const target = dripTargetRef.current;
            const displayLen = dripDisplayLenRef.current;
            if (displayLen >= target.length) return;

            const desiredLen = Math.min(
                displayLen + DRIP_CHARS_PER_TICK,
                target.length,
            );
            // PII Shield safety (plan §1.5): when a placeholder
            // `⟦PII:ENTITY_N⟧` straddles the current drip boundary,
            // back off to the character before the opening bracket so
            // the user never sees a half-rendered "⟦PII:" token. The
            // next tick flushes the whole placeholder atomically.
            // Cheap O(n) scan — we only check the last 80 chars.
            const newLen = clampToCompletePlaceholder(target, desiredLen);
            dripDisplayLenRef.current = newLen;
            const visibleText = target.slice(0, newLen);
            const events = eventsRef.current;
            const lastIdx = events.length - 1;
            const last = events[lastIdx];
            if (last?.type === "content" && last.isStreaming) {
                const next = events.slice();
                next[lastIdx] = {
                    type: "content",
                    text: visibleText,
                    isStreaming: true,
                };
                eventsRef.current = next;
            }

            setMessages((prev) =>
                updateLastContentEvent(prev, visibleText, true),
            );
        }, 16);
    };

    const cancel = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
            setIsResponseLoading(false);
            setIsLoadingCitations(false);
        }
    };

    // Transient placeholder events (tool_call_start, thinking) fill the
    // latency gap between real SSE events so the wrapper doesn't look stuck.
    // Anytime a real event arrives, drop any streaming placeholder first.
    const isStreamingPlaceholder = (e: AssistantEvent) =>
        (e.type === "tool_call_start" || e.type === "thinking") &&
        !!e.isStreaming;

    const clearStreamingPlaceholders = () => {
        const before = eventsRef.current;
        const after = before.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === before.length) return;
        eventsRef.current = after;
        const snapshot = [...after];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const pushThinkingPlaceholder = () => {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
        if (last && isStreamingPlaceholder(last)) return;
        eventsRef.current = [
            ...events,
            { type: "thinking" as const, isStreaming: true },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === "assistant") {
                updated[updated.length - 1] = { ...lastMsg, events: snapshot };
            }
            return updated;
        });
    };

    const pushEvent = (event: AssistantEvent) => {
        finalizeStreamingContent();
        finalizeStreamingReasoning();
        // Drop any in-flight placeholder unless we're pushing one ourselves.
        let next = eventsRef.current;
        if (event.type !== "tool_call_start" && event.type !== "thinking") {
            next = next.filter((e) => !isStreamingPlaceholder(e));
        }
        eventsRef.current = [...next, event];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const updateMatchingEvent = (
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ) => {
        const events = eventsRef.current;
        const idx = [...events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(events[i]));
        if (idx === undefined) return;
        const newEvents = [...events];
        newEvents[idx] = updater(events[idx]);
        eventsRef.current = newEvents;
        const snapshot = [...newEvents];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    };

    const handleChat = async (
        message: MikeMessage,
        opts?: {
            displayedDoc?: { filename: string; documentId: string } | null;
        },
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setIsResponseLoading(true);

        const lastMessage = messages[messages.length - 1];
        const isMessageAlreadyAdded =
            lastMessage &&
            lastMessage.role === "user" &&
            lastMessage.content === message.content;

        const newMessages: MikeMessage[] = isMessageAlreadyAdded
            ? messages
            : [...messages, message];

        setMessages([
            ...newMessages,
            { role: "assistant", content: "", annotations: [], events: [] },
        ]);

        // ── Analytics ──────────────────────────────────────────────────────
        // Fire after the message is committed to state, before the network
        // call. `surface` is derived from whether a projectId is in scope;
        // `model_tier` is a coarse label (never the raw model id string);
        // `has_attachment` is a plain boolean (no file names or counts).
        const surface = projectId ? "project" : "assistant";
        const model_tier = modelTierOf(message.model);
        const has_attachment = !!(message.files && message.files.length > 0);

        track("chat_message_sent", { surface, model_tier, has_attachment });

        // `chat_first_message` fires once per browser (localStorage flag).
        // This is a per-browser approximation — noted as a known limitation.
        trackFirstMessageOnce(surface);
        // ───────────────────────────────────────────────────────────────────

        let streamedChatId: string | null = null;

        stopDrip();
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];

        try {
            const controller = new AbortController();
            abortControllerRef.current = controller;

            const apiMessages = newMessages.map((currentMessage) => ({
                role: currentMessage.role,
                content: currentMessage.content,
                files: currentMessage.files,
                workflow: currentMessage.workflow,
            }));

            const model = message.model;
            const effort = message.effort;
            const webSearch = message.webSearch;

            const displayedDoc = opts?.displayedDoc ?? null;

            // Pull the user's attachments from the just-submitted message.
            // These are the files dragged into / picked from the chat input
            // for this turn (separate from the running history of past
            // attachments). Sent as a request-level field so the backend
            // can call them out specifically in the system prompt.
            const attachedDocs = (
                message.files?.filter((f) => !!f.document_id) ?? []
            ).map((f) => ({
                filename: f.filename,
                document_id: f.document_id as string,
            }));

            const response = await (projectId
                ? streamProjectChat({
                      projectId,
                      messages: apiMessages,
                      chat_id: chatId,
                      model,
                      effort,
                      web_search: webSearch,
                      displayed_doc: displayedDoc
                          ? {
                                filename: displayedDoc.filename,
                                document_id: displayedDoc.documentId,
                            }
                          : undefined,
                      attached_documents:
                          attachedDocs.length > 0 ? attachedDocs : undefined,
                      signal: controller.signal,
                  })
                : streamChat({
                      messages: apiMessages,
                      chat_id: chatId,
                      model,
                      effort,
                      web_search: webSearch,
                      signal: controller.signal,
                  }));

            if (!response.ok) {
                // 429 (rate-limited) is owned by the banner — streamFetch
                // has already parsed the body and pushed it into
                // rateLimitStore, so we just need to bail without
                // dumping the raw JSON into the chat as an "answer".
                if (response.status === 429) {
                    const rlError = new Error("RATE_LIMITED") as Error & {
                        rateLimited?: true;
                    };
                    rlError.rateLimited = true;
                    throw rlError;
                }
                const errText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data:")) continue;

                    const dataStr = trimmed.slice(5).trim();
                    if (dataStr === "[DONE]") continue;

                    try {
                        const data = JSON.parse(dataStr);

                        if (data.type === "rate_limited") {
                            // Mid-stream gate (e.g. tool-use loop pushed
                            // the user past their limit while the reply
                            // was already underway). Push the snapshot,
                            // flag the bubble so it renders the in-chat
                            // notice (alongside any partial content), and
                            // stop reading.
                            const { pushFromRateLimitedError } = await import(
                                "../lib/rateLimitStore"
                            );
                            pushFromRateLimitedError(data);
                            setMessages((prev) => {
                                const last = prev[prev.length - 1];
                                if (last?.role === "assistant") {
                                    const updated = [...prev];
                                    updated[updated.length - 1] = {
                                        ...last,
                                        rateLimited: true,
                                    };
                                    return updated;
                                }
                                return prev;
                            });
                            await reader.cancel();
                            break;
                        }

                        if (data.type === "chat_id") {
                            streamedChatId = data.chatId;
                            setChatId(data.chatId);
                            setCurrentChatId(data.chatId);
                            continue;
                        }

                        if (data.type === "message_id") {
                            // Backend emits this once the assistant turn
                            // is persisted. Wire the new chat_messages.id
                            // onto the last assistant message so per-
                            // message actions (flag/unflag, future
                            // analytics) have an id to operate on.
                            const newId = data.messageId as string;
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant" && !last.id) {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        id: newId,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "content_done") {
                            setIsLoadingCitations(true);
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;

                            // Real content is streaming — retire any
                            // "Thinking…" / "Running…" placeholders, and
                            // finalize any in-flight reasoning block so it
                            // doesn't get stuck rendering as streaming.
                            clearStreamingPlaceholders();
                            finalizeStreamingReasoning();

                            // Ensure a streaming content event exists. If
                            // the last event isn't already a streaming
                            // content block, start a fresh one — and reset
                            // the drip so we don't inherit a previous
                            // block's accumulated text.
                            const events = eventsRef.current;
                            const lastEvent = events[events.length - 1];
                            if (
                                lastEvent?.type !== "content" ||
                                !lastEvent.isStreaming
                            ) {
                                dripTargetRef.current = text;
                                dripDisplayLenRef.current = 0;
                                eventsRef.current = [
                                    ...events,
                                    {
                                        type: "content" as const,
                                        text: "",
                                        isStreaming: true,
                                    },
                                ];
                                const snapshot = [...eventsRef.current];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            } else {
                                dripTargetRef.current += text;
                            }

                            startDrip();
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            let events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — finalize any in-flight
                                // content event first so the next content_delta
                                // starts a fresh block at the correct position.
                                finalizeStreamingContent();
                                clearStreamingPlaceholders();
                                events = eventsRef.current;
                                eventsRef.current = [
                                    ...events,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "tool_call_start") {
                            // Transient placeholder so the client immediately
                            // shows activity after Claude ends a turn with
                            // tool_use. Replaced by the real tool event
                            // (doc_edited_start, doc_read_start, …) if one
                            // arrives; otherwise it lingers as a "Working…"
                            // indicator until the next iteration streams.
                            pushEvent({
                                type: "tool_call_start",
                                name: (data.name as string) ?? "",
                                display_name:
                                    (data.display_name as string | undefined) ??
                                    undefined,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "workflow_applied") {
                            pushEvent({
                                type: "workflow_applied",
                                workflow_id: data.workflow_id as string,
                                title: data.title as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_find_start") {
                            pushEvent({
                                type: "doc_find",
                                filename: data.filename as string,
                                query: (data.query as string) ?? "",
                                total_matches: 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "web_search_started") {
                            // Surface the "Searching the web…" affordance
                            // immediately. Matched by `query` to the
                            // follow-up `web_search_result` event so we can
                            // upgrade in place rather than render twice.
                            pushEvent({
                                type: "web_search_started",
                                query: (data.query as string) ?? "",
                                provider: (data.provider as string) ?? "auto",
                                kind: (data.kind as
                                    | "official"
                                    | "web"
                                    | "news"
                                    | undefined),
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "web_search_result") {
                            const query = (data.query as string) ?? "";
                            const provider = (data.provider as string) ?? "auto";
                            const results = Array.isArray(data.results)
                                ? (data.results as Array<{
                                      title?: string;
                                      url?: string;
                                      snippet?: string;
                                      published_date?: string | null;
                                  }>).map((r) => ({
                                      title: r.title ?? "",
                                      url: r.url ?? "",
                                      snippet: r.snippet ?? "",
                                      published_date: r.published_date ?? null,
                                  }))
                                : [];
                            const error =
                                typeof data.error === "string" && data.error
                                    ? data.error
                                    : null;
                            // Replace the in-flight `web_search_started`
                            // placeholder for this query with the final
                            // result event. If no placeholder exists (e.g.
                            // race), append a fresh result.
                            const events = eventsRef.current;
                            const idx = events.findIndex(
                                (e) =>
                                    e.type === "web_search_started" &&
                                    e.query === query &&
                                    e.isStreaming,
                            );
                            const finalEvent = {
                                type: "web_search_result" as const,
                                query,
                                provider,
                                kind: (data.kind as
                                    | "official"
                                    | "web"
                                    | "news"
                                    | undefined),
                                results,
                                error,
                            };
                            if (idx >= 0) {
                                const next = [...events];
                                next[idx] = finalEvent;
                                eventsRef.current = next;
                                const snapshot = [...next];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            } else {
                                pushEvent(finalEvent);
                            }
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "web_extract_started") {
                            // "Reading link…" affordance, matched to the
                            // follow-up web_extract_result by `url`.
                            pushEvent({
                                type: "web_extract_started",
                                url: (data.url as string) ?? "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "web_extract_result") {
                            const url = (data.url as string) ?? "";
                            const finalEvent = {
                                type: "web_extract_result" as const,
                                url,
                                title:
                                    typeof data.title === "string"
                                        ? (data.title as string)
                                        : null,
                                snippet:
                                    typeof data.snippet === "string"
                                        ? (data.snippet as string)
                                        : "",
                                is_pdf: data.is_pdf === true,
                                full: data.full === true,
                                error:
                                    typeof data.error === "string" && data.error
                                        ? (data.error as string)
                                        : null,
                            };
                            // Replace the in-flight started placeholder for
                            // this url; append if there's no match (race).
                            const events = eventsRef.current;
                            const idx = events.findIndex(
                                (e) =>
                                    e.type === "web_extract_started" &&
                                    e.url === url &&
                                    e.isStreaming,
                            );
                            if (idx >= 0) {
                                const next = [...events];
                                next[idx] = finalEvent;
                                eventsRef.current = next;
                                const snapshot = [...next];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            } else {
                                pushEvent(finalEvent);
                            }
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_find") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_find" &&
                                    e.filename === data.filename &&
                                    e.query === (data.query as string) &&
                                    !!e.isStreaming,
                                (e) => ({
                                    ...e,
                                    isStreaming: false,
                                    total_matches:
                                        typeof data.total_matches === "number"
                                            ? (data.total_matches as number)
                                            : (
                                                  e as {
                                                      type: "doc_find";
                                                      total_matches: number;
                                                  }
                                              ).total_matches,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_created_start") {
                            pushEvent({
                                type: "doc_created",
                                filename: data.filename as string,
                                download_url: "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_download") {
                            pushEvent({
                                type: "doc_download",
                                filename: data.filename as string,
                                download_url: data.download_url as string,
                            });
                            continue;
                        }

                        if (data.type === "doc_created") {
                            // Analytics: a generated document finished
                            // streaming. Fired here — the hook owns the
                            // stream loop, sees completion definitively
                            // (a component effect loses the event when the
                            // user navigates away mid-stream) and knows the
                            // real surface. No filename/id in metadata.
                            track("document_generated", { surface });
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_created" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => {
                                    const next: Extract<
                                        AssistantEvent,
                                        { type: "doc_created" }
                                    > = {
                                        type: "doc_created",
                                        filename: (e as { filename: string })
                                            .filename,
                                        download_url:
                                            data.download_url as string,
                                        isStreaming: false,
                                    };
                                    if (typeof data.document_id === "string") {
                                        next.document_id =
                                            data.document_id as string;
                                    }
                                    if (typeof data.version_id === "string") {
                                        next.version_id =
                                            data.version_id as string;
                                    }
                                    if (
                                        typeof data.version_number === "number"
                                    ) {
                                        next.version_number =
                                            data.version_number as number;
                                    }
                                    return next;
                                },
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_replicate_start") {
                            pushEvent({
                                type: "doc_replicated",
                                filename: data.filename as string,
                                count:
                                    typeof data.count === "number"
                                        ? (data.count as number)
                                        : 1,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_replicated") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_replicated" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_replicated",
                                    filename: data.filename as string,
                                    count:
                                        typeof data.count === "number"
                                            ? (data.count as number)
                                            : Array.isArray(data.copies)
                                              ? (data.copies as unknown[])
                                                    .length
                                              : 1,
                                    copies: Array.isArray(data.copies)
                                        ? (data.copies as {
                                              new_filename: string;
                                              document_id: string;
                                              version_id: string;
                                          }[])
                                        : undefined,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "doc_edited_start") {
                            pushEvent({
                                type: "doc_edited",
                                filename: data.filename as string,
                                document_id: "",
                                version_id: "",
                                download_url: "",
                                annotations: [],
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_edited") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_edited" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "doc_edited",
                                    filename: data.filename as string,
                                    document_id:
                                        (data.document_id as string) ?? "",
                                    version_id:
                                        (data.version_id as string) ?? "",
                                    version_number:
                                        typeof data.version_number === "number"
                                            ? (data.version_number as number)
                                            : null,
                                    download_url:
                                        (data.download_url as string) ?? "",
                                    annotations: Array.isArray(data.annotations)
                                        ? (data.annotations as import("@/app/components/shared/types").MikeEditAnnotation[])
                                        : [],
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "mcp_tool_result") {
                            pushEvent({
                                type: "mcp_tool_result",
                                server: (data.server as string) ?? "",
                                tool: (data.tool as string) ?? "",
                                ok: data.ok !== false,
                                args: (data.args as string) ?? "",
                                output: (data.output as string) ?? "",
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "legal_sources") {
                            // Per-turn legal-source registry — drives the
                            // "Izvori" list and the right-side panel.
                            pushEvent({
                                type: "legal_sources",
                                sources: (data.sources as LegalSource[]) ?? [],
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citations") {
                            // End-of-stream signal — scrub any lingering
                            // placeholders so they don't persist into the
                            // finalised message.
                            clearStreamingPlaceholders();
                            const incoming = (data.citations ??
                                []) as MikeAnnotation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        annotations: incoming,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                    } catch (e) {
                        console.warn(
                            "[useAssistantChat] failed to parse SSE line:",
                            trimmed,
                            e,
                        );
                    }
                }
            }

            flushDrip();
            finalizeStreamingReasoning();
            setIsResponseLoading(false);
            setIsLoadingCitations(false);

            const finalChatId = streamedChatId || chatId || null;
            if (finalChatId && finalChatId !== chatId) {
                if (chatId) {
                    replaceChatId(
                        chatId,
                        finalChatId,
                        // Undefined fallback — let the backend title
                        // generator pick a proper localized title on the
                        // first exchange. Hard-coding "New Chat" here
                        // baked an untranslated English string into HR
                        // users' chat lists; undefined preserves the
                        // null title until the real one arrives.
                        message.content.trim().slice(0, 120) || undefined,
                    );
                }
                setCurrentChatId(finalChatId);
                const chatBasePath = projectId
                    ? `/projects/${projectId}/assistant/chat`
                    : `/assistant/chat`;
                router.replace(`${chatBasePath}/${finalChatId}`);
            }

            await loadChats();

            const finalChatIdForTitle = streamedChatId || chatId || null;
            if (finalChatIdForTitle && newMessages.length === 1) {
                const titleParts = [message.content];
                if (message.workflow)
                    titleParts.push(`Workflow: ${message.workflow.title}`);
                if (message.files?.length)
                    titleParts.push(
                        `Files: ${message.files.map((f) => f.filename).join(", ")}`,
                    );
                void generateTitle(finalChatIdForTitle, titleParts.join("\n"));
            }

            return streamedChatId || null;
        } catch (error: any) {
            if (error.name === "AbortError") {
                flushDrip();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        const events = last.events ?? [];
                        const idx = findLastContentIndex(events);
                        const cancelText = "Cancelled by user";
                        if (idx >= 0) {
                            const newEvents = [...events];
                            const existing = newEvents[idx] as {
                                type: "content";
                                text: string;
                            };
                            newEvents[idx] = {
                                type: "content",
                                text: existing.text
                                    ? `${existing.text}\n\nCancelled by user`
                                    : cancelText,
                            };
                            updated[updated.length - 1] = {
                                ...last,
                                events: newEvents,
                            };
                        } else {
                            updated[updated.length - 1] = {
                                ...last,
                                events: [
                                    ...events,
                                    { type: "content", text: cancelText },
                                ],
                            };
                        }
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            events: [
                                { type: "content", text: "Cancelled by user" },
                            ],
                        },
                    ];
                });
            } else if (error?.rateLimited) {
                // Daily limit hit before the reply started. Keep the
                // assistant bubble but flag it so it renders an in-chat
                // notice (limit reached + CTA to pick a larger plan)
                // instead of a blank/red bubble. The composer banner
                // still mirrors the same state above the input.
                stopDrip();
                flushDrip();
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            ...last,
                            rateLimited: true,
                        };
                        return updated;
                    }
                    return prev;
                });
            } else {
                stopDrip();
                const errorMessage =
                    typeof error?.message === "string" && error.message
                        ? error.message
                        : "Sorry, something went wrong.";
                setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant") {
                        const updated = [...prev];
                        updated[updated.length - 1] = {
                            ...last,
                            error: errorMessage,
                        };
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            error: errorMessage,
                        },
                    ];
                });
            }

            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            return null;
        } finally {
            abortControllerRef.current = null;
        }
    };

    const handleNewChat = async (
        message: MikeMessage,
        projectId?: string,
    ): Promise<string | null> => {
        if (!message.content.trim()) return null;

        setMessages([message]);
        setNewChatMessages([message]);

        const newChatId = await saveChat(projectId);
        if (newChatId) {
            setChatId(newChatId);
            setCurrentChatId(newChatId);
        }

        return newChatId;
    };

    return {
        messages,
        isResponseLoading,
        setIsResponseLoading,
        isLoadingCitations,
        handleChat,
        handleNewChat,
        setMessages,
        cancel,
        chatId,
    };
}
