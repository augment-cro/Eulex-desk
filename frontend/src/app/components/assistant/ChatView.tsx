"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { ArrowDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import {
    AssistantSidePanel,
    type AssistantSidePanelTab,
} from "./AssistantSidePanel";
import { AssistantWorkflowModal } from "./AssistantWorkflowModal";
import { ShareChatModal } from "../shared/ShareChatModal";
import { SaveAsContextModal } from "../contexts/SaveAsContextModal";
import type {
    LegalSource,
    MikeCitationAnnotation,
    MikeEditAnnotation,
    MikeLegalSourceAnnotation,
    MikeMessage,
} from "../shared/types";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { contextsServiceEnabled } from "@/app/lib/mikeApi";
import { invalidateDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { usePiiSessionForChat } from "@/app/hooks/usePiiSessionForChat";

interface Props {
    messages: MikeMessage[];
    isResponseLoading: boolean;
    handleChat: (message: MikeMessage) => Promise<string | null>;
    cancel: () => void;
    /**
     * Optional — present on `/assistant/chat/[id]` but not on the
     * landing `/assistant` route (no chat exists yet). When set, we
     * surface a small Share button in the chat header.
     */
    chatId?: string;
    chatTitle?: string | null;
    /**
     * Notifier for the "Not appropriate answer" flag — fires after a
     * successful toggle so the parent can persist the new state into
     * its message list (which is the source of truth for re-renders).
     */
    onFlagChange?: (messageId: string, flagged: boolean) => void;
}

export function ChatView({
    messages,
    isResponseLoading,
    handleChat,
    cancel,
    chatId,
    chatTitle,
    onFlagChange,
}: Props) {
    const tShare = useTranslations("shareChat");
    const t = useTranslations("assistant");
    const [shareOpen, setShareOpen] = useState(false);
    const [tabs, setTabs] = useState<AssistantSidePanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [panelMounted, setPanelMounted] = useState(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    // "Save as context" — the cited sources of the answer being saved, or
    // null when the modal is closed.
    const [saveCtxSources, setSaveCtxSources] = useState<LegalSource[] | null>(
        null,
    );
    const [workflowModalInitialId, setWorkflowModalInitialId] = useState<
        string | undefined
    >();
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );
    // Per-edit in-flight set — disables Accept/Reject on only the one
    // edit currently being resolved, so sibling edits in the same message
    // (and their twins in DocPanel) stay clickable.
    const [reloadingEditIds, setReloadingEditIds] = useState<Set<string>>(
        () => new Set(),
    );
    const { setSidebarOpen } = useSidebar();

    // PII Shield session for this chat. Used by every AssistantMessage so
    // the lazy `usePiiRenderedText` hook can resolve ⟦PII:…⟧ placeholders
    // back to their original values on the client. The bump counter is
    // ticked when a streaming reply ends so a brand-new session (created
    // mid-turn by /chat → /anonymize) is picked up without a page reload.
    const piiSessionBumpRef = useRef(0);
    // Monotonic counter for legal-source clicks — see openLegalSource.
    const legalFocusNonceRef = useRef(0);
    const [piiSessionBump, setPiiSessionBump] = useState(0);
    const { sessionId: piiSessionId } = usePiiSessionForChat(
        chatId ?? null,
        piiSessionBump,
    );

    // When the last message just finished streaming and there's no
    // session yet, kick the resolver — the backend may have just
    // created the session row.
    useEffect(() => {
        if (!chatId) return;
        if (isResponseLoading) return;
        if (piiSessionId) return;
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant") return;
        piiSessionBumpRef.current += 1;
        setPiiSessionBump(piiSessionBumpRef.current);
        // No-op deps lint — refresh is stable per chatId via useCallback
        // inside the hook, but we don't want it to retrigger this effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isResponseLoading, chatId, messages.length, piiSessionId]);

    const showPanel = useCallback(() => {
        setPanelMounted(true);
        setSidebarOpen(false);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => setPanelVisible(true)),
        );
    }, [setSidebarOpen]);

    const closeAllTabs = useCallback(() => {
        setPanelVisible(false);
        setTimeout(() => {
            setTabs([]);
            setActiveTabId(null);
            setPanelMounted(false);
            setSidebarOpen(true);
        }, 300);
    }, [setSidebarOpen]);

    const closeTab = useCallback(
        (id: string) => {
            setTabs((prev) => {
                const next = prev.filter((t) => t.id !== id);
                if (next.length === 0) {
                    setPanelVisible(false);
                    setTimeout(() => {
                        setActiveTabId(null);
                        setPanelMounted(false);
                        setSidebarOpen(true);
                    }, 300);
                    return next;
                }
                if (activeTabId === id) {
                    const idx = prev.findIndex((t) => t.id === id);
                    const neighbour = next[idx] ?? next[idx - 1] ?? next[0];
                    setActiveTabId(neighbour?.id ?? null);
                }
                return next;
            });
        },
        [activeTabId, setSidebarOpen],
    );

    // ─── Faza 2.2: streaming tracked changes u SuperDoc (standalone chat) ─
    //
    // Kad Mike završi `edit_document` tool poziv, backend već INSERT-a redove
    // u `document_edits` prije SSE emit-a `doc_edited`. Ako je odgovarajući
    // dokument otvoren u side-panelu, ažuriramo tab-ovu `versionId` na
    // novu verziju i evictamo bytes cache; DocPanel → DocxViewer →
    // SuperDocView prosljeđuju novi versionId, useFetchDocxBytes refetcha
    // svježe bytes (već uključuje w:ins/w:del), a SuperDocView's
    // `handleReady` automatski poziva `refreshDbEdits()` koji pulsira novi
    // bubble panel s prijedlozima — sve bez korisničke interakcije.
    //
    // Bez `consumedEditEventsRef` set-a, dodavanje novog message-a u listu
    // re-okinulo bi cijelu iteraciju i bumpalo versionId u petlji.
    const consumedEditEventsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if (ev.type !== "doc_edited") continue;
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.error) continue;
                if (!ev.document_id || !ev.version_id) continue;
                const key = `${ev.document_id}:${ev.version_id}`;
                if (consumedEditEventsRef.current.has(key)) continue;
                consumedEditEventsRef.current.add(key);
                // Bytes cache je keyed po (docId, versionId, refetchKey) —
                // ovdje se versionId mijenja, pa novi key neće biti hit;
                // ali ako tab već bio na novoj versionId-u (npr. preko
                // accept/reject), evict osigurava svježi GET.
                invalidateDocxBytes(ev.document_id);
                setTabs((prev) =>
                    prev.map((t) =>
                        t.documentId === ev.document_id
                            ? {
                                  ...t,
                                  versionId: ev.version_id,
                                  versionNumber:
                                      ev.version_number ??
                                      t.versionNumber ??
                                      null,
                              }
                            : t,
                    ),
                );
            }
        }
    }, [messages]);

    /**
     * One tab per document. If a tab for `tab.documentId` already exists,
     * the panel stays mounted and only the header-relevant fields swap
     * (kind, citation/edit, version, filename). Per-tab UI state — the
     * dismissable warning and the saved scroll position — is preserved
     * so switching headers doesn't blow away viewer state. If no tab
     * exists for the document, a new one is appended.
     */
    const upsertTab = useCallback(
        (tab: AssistantSidePanelTab) => {
            setTabs((prev) => {
                const idx = prev.findIndex(
                    (t) => t.documentId === tab.documentId,
                );
                if (idx >= 0) {
                    const existing = prev[idx];
                    const copy = prev.slice();
                    copy[idx] = {
                        ...tab,
                        id: existing.id,
                        warning: existing.warning,
                        initialScrollTop: existing.initialScrollTop,
                    };
                    return copy;
                }
                return [...prev, tab];
            });
            setActiveTabId(tab.id);
            showPanel();
        },
        [showPanel],
    );

    /**
     * Open a tab showing a single citation quote. Called from
     * AssistantMessage when the user clicks a numbered citation pill.
     */
    const openCitation = useCallback(
        (citation: MikeCitationAnnotation) => {
            upsertTab({
                kind: "citation",
                id: citation.document_id,
                documentId: citation.document_id,
                filename: citation.filename,
                versionId: citation.version_id ?? null,
                versionNumber: citation.version_number ?? null,
                citation,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a legal source (EU/HR/FR) document. Called from
     * AssistantMessage when the user clicks a black citation pill or an
     * "Izvori" chip. Deduped by source id via `upsertTab`.
     */
    const openLegalSource = useCallback(
        (ann: MikeLegalSourceAnnotation, citedArticleNumbers?: string[]) => {
            upsertTab({
                kind: "legal-source",
                id: ann.source.id,
                documentId: ann.source.id,
                filename: ann.source.title,
                versionId: null,
                versionNumber: null,
                source: ann.source,
                quote: ann.quote,
                citedArticleNumbers,
                // Stavak/točka parsed from the clicked reference's prose —
                // drives the magenta pinpoint highlight in the panel.
                pinpoint: ann.pinpoint ?? null,
                // Bump on every click so an already-open tab re-scrolls to the
                // clicked article instead of staying where the user left off.
                focusNonce: ++legalFocusNonceRef.current,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a single tracked change. Called from
     * AssistantMessage when the user clicks an EditCard's View button.
     */
    const openEditor = useCallback(
        (ann: MikeEditAnnotation, filename: string) => {
            upsertTab({
                kind: "edit",
                id: ann.document_id,
                documentId: ann.document_id,
                filename,
                versionId: ann.version_id ?? null,
                versionNumber: ann.version_number ?? null,
                edit: ann,
            });
        },
        [upsertTab],
    );

    /**
     * Open a tab showing a document without targeting a specific
     * citation/edit — used by the download-card click.
     */
    const openDocument = useCallback(
        (args: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => {
            upsertTab({
                kind: "document",
                id: args.documentId,
                documentId: args.documentId,
                filename: args.filename,
                versionId: args.versionId,
                versionNumber: args.versionNumber,
            });
        },
        [upsertTab],
    );

    const [resolvedEditStatuses, setResolvedEditStatuses] = useState<
        Record<string, "accepted" | "rejected">
    >({});

    const handleEditResolveStart = useCallback(
        (args: {
            editId: string;
            documentId: string;
            verb: "accept" | "reject";
        }) => {
            setReloadingDocIds((prev) => {
                if (prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.add(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.add(args.editId);
                return next;
            });
        },
        [],
    );

    const handleEditResolved = useCallback(
        (args: {
            editId: string;
            documentId: string;
            status: "accepted" | "rejected";
            versionId: string | null;
            downloadUrl: string | null;
        }) => {
            setResolvedEditStatuses((prev) => ({
                ...prev,
                [args.editId]: args.status,
            }));
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            setReloadingEditIds((prev) => {
                if (!prev.has(args.editId)) return prev;
                const next = new Set(prev);
                next.delete(args.editId);
                return next;
            });
            // Accept/reject mutates bytes for this document's current
            // version; drop the cache so the next DocxView render (or an
            // explicit re-open) fetches the fresh file.
            invalidateDocxBytes(args.documentId);
            // Two updates on the matching tabs:
            //  1) Repoint `versionId` (the backend returns the new version
            //     after accept/reject) on EVERY tab for this document — that
            //     changes DocxViewer's remount key (documentId:versionId:…),
            //     forcing SuperDoc to reload the resolved bytes instead of
            //     showing the stale pre-accept render. Same mechanism as the
            //     `doc_edited` SSE handler above. Without this, a resolve from
            //     the inline EditCard/BulkEditActions evicts the cache but the
            //     already-mounted editor never remounts.
            //  2) Propagate the new status onto the open edit-tab for this
            //     edit so DocPanel's Accept/Reject buttons flip and disable
            //     (their sync effect keys off edit.status).
            setTabs((prev) =>
                prev.map((t) => {
                    const isSameDoc = t.documentId === args.documentId;
                    const isSameEdit =
                        t.kind === "edit" && t.edit.edit_id === args.editId;
                    if (!isSameDoc && !isSameEdit) return t;
                    return {
                        ...t,
                        ...(isSameDoc && args.versionId
                            ? { versionId: args.versionId }
                            : {}),
                        ...(isSameEdit
                            ? { edit: { ...t.edit, status: args.status } }
                            : {}),
                    };
                }),
            );
        },
        [],
    );


    // Bug 1 fix: kad SuperDoc spremi novu verziju, prebacimo tab na nju i
    // evictamo byte cache da reload prikaže SPREMLJENI sadržaj umjesto
    // stare prikvačene verzije. Isti mehanizam kao za Mike `doc_edited`.
    const handleDocSaved = useCallback(
        (args: {
            documentId: string;
            versionId: string;
            versionNumber: number | null;
        }) => {
            invalidateDocxBytes(args.documentId);
            setTabs((prev) =>
                prev.map((t) =>
                    t.documentId === args.documentId
                        ? {
                              ...t,
                              versionId: args.versionId,
                              versionNumber:
                                  args.versionNumber ?? t.versionNumber ?? null,
                          }
                        : t,
                ),
            );
        },
        [],
    );

    const patchTab = useCallback(
        (
            tabId: string,
            patch: Partial<Pick<AssistantSidePanelTab, "warning" | "initialScrollTop">>,
        ) => {
            setTabs((prev) => {
                const idx = prev.findIndex((t) => t.id === tabId);
                if (idx < 0) return prev;
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], ...patch };
                return copy;
            });
        },
        [],
    );

    const handleEditError = useCallback(
        (args: {
            editId?: string;
            documentId: string;
            versionId?: string | null;
            message: string;
        }) => {
            // Surface the warning on every tab tied to this document.
            setTabs((prev) =>
                prev.map((t) =>
                    t.documentId === args.documentId
                        ? { ...t, warning: args.message }
                        : t,
                ),
            );
            setReloadingDocIds((prev) => {
                if (!prev.has(args.documentId)) return prev;
                const next = new Set(prev);
                next.delete(args.documentId);
                return next;
            });
            if (args.editId) {
                setReloadingEditIds((prev) => {
                    if (!prev.has(args.editId!)) return prev;
                    const next = new Set(prev);
                    next.delete(args.editId!);
                    return next;
                });
            }
        },
        [],
    );

    const handleWarningDismiss = useCallback(
        (tabId: string) => {
            patchTab(tabId, { warning: null });
        },
        [patchTab],
    );

    const handleScrollChange = useCallback(
        (tabId: string, scrollTop: number) => {
            patchTab(tabId, { initialScrollTop: scrollTop });
        },
        [patchTab],
    );

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<HTMLDivElement>(null);
    const hasScrolledRef = useRef(false);
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [inputHeight, setInputHeight] = useState(0);
    const [minHeight, setMinHeight] = useState("0px");

    useEffect(() => {
        const el = chatInputRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() =>
            setInputHeight(el.offsetHeight),
        );
        observer.observe(el);
        setInputHeight(el.offsetHeight);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (latestUserMessageRef.current) {
            const headerHeight = window.innerWidth < 768 ? 56 : 0;
            const gap = window.innerWidth < 768 ? 16 : 24;
            // Mirror the dynamic paddingBottom applied to the messages wrapper
            // so the "scroll latest user message to top" math stays correct as
            // the input grows.
            const paddingBottom = (inputHeight || 104) + 24;
            const marginBottom = 48;
            const userMessageHeight = latestUserMessageRef.current.offsetHeight;
            setMinHeight(
                `calc(100dvh - ${headerHeight + gap + userMessageHeight + paddingBottom + marginBottom}px)`,
            );
        }
    }, [messages.length, inputHeight, latestUserMessageRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

    const updateScrollButton = useCallback(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        const isScrolledUp = c.scrollHeight - c.scrollTop - c.clientHeight > 10;
        setShowScrollButton(isScrolledUp && c.scrollHeight > c.clientHeight);
    }, []);

    useEffect(() => {
        const c = messagesContainerRef.current;
        if (!c) return;
        c.addEventListener("scroll", updateScrollButton);
        updateScrollButton();
        return () => c.removeEventListener("scroll", updateScrollButton);
    }, [messages, updateScrollButton]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                setTimeout(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (container && element) {
                        container.scrollTo({
                            top: element.offsetTop - 24,
                            behavior: "instant",
                        });
                    }
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
            } else {
                hasScrolledRef.current = true;
                setMessagesVisible(true);
            }
        }
    }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (panelMounted && window.innerWidth < 768) {
            document.body.style.overflow = "hidden";
        } else {
            document.body.style.overflow = "unset";
        }
        return () => {
            document.body.style.overflow = "unset";
        };
    }, [panelMounted]);

    return (
        <div className="h-full w-full flex relative">
            {/* Chat column */}
            <div className="flex flex-col h-full flex-1 relative">
                {/* Scrollable messages */}
                <div
                    ref={messagesContainerRef}
                    className="flex-1 w-full overflow-y-auto"
                    style={{ scrollbarGutter: "stable both-edges" }}
                >
                    {/* paddingBottom tracks the live input height (the input is
                        absolutely positioned and grows upward as the textarea /
                        inline suggestion expand). Without this, a tall input
                        covered the last message and toolbar icons. +24px breathing
                        room. Falls back to 128px before the first measure. */}
                    <div
                        className="w-full max-w-4xl mx-auto px-6 md:px-8 pt-4 md:pt-6 min-h-full flex flex-col relative"
                        style={{ paddingBottom: (inputHeight || 104) + 24 }}
                    >
                        {!messagesVisible && (
                            <div className="space-y-6 w-full">
                                <div className="flex justify-end">
                                    <div className="bg-muted rounded-2xl p-4 w-2/5">
                                        <div className="h-4 bg-gradient-to-r from-secondary via-border to-secondary bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                    </div>
                                </div>
                                <div className="space-y-3">
                                    {[1, 2, 3, 4].map((i) => (
                                        <div
                                            key={i}
                                            className={`h-4 bg-gradient-to-r from-secondary via-border to-secondary bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                        <div
                            className="space-y-6 transition-opacity duration-150"
                            style={{ opacity: messagesVisible ? 1 : 0 }}
                        >
                            {(() => {
                                const lastUserIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIndex = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) => (
                                    <div
                                        key={i}
                                        ref={
                                            i === lastUserIndex
                                                ? latestUserMessageRef
                                                : null
                                        }
                                    >
                                        {msg.role === "user" ? (
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={(msg as any).files}
                                                workflow={(msg as any).workflow}
                                            />
                                        ) : (
                                            <AssistantMessage
                                                content={msg.content ?? ""}
                                                events={msg.events}
                                                isStreaming={
                                                    i === messages.length - 1 &&
                                                    isResponseLoading
                                                }
                                                isError={!!(msg as any).error}
                                                errorMessage={
                                                    typeof (msg as any).error ===
                                                    "string"
                                                        ? (msg as any).error
                                                        : undefined
                                                }
                                                rateLimited={
                                                    !!(msg as any).rateLimited
                                                }
                                                annotations={msg.annotations}
                                                onCitationClick={openCitation}
                                                onLegalSourceClick={
                                                    openLegalSource
                                                }
                                                minHeight={
                                                    i === lastAssistantIndex
                                                        ? minHeight
                                                        : "0px"
                                                }
                                                onWorkflowClick={(id) => {
                                                    setWorkflowModalInitialId(
                                                        id,
                                                    );
                                                    setWorkflowModalOpen(true);
                                                }}
                                                onEditViewClick={openEditor}
                                                onOpenDocument={openDocument}
                                                onEditResolveStart={
                                                    handleEditResolveStart
                                                }
                                                onEditResolved={
                                                    handleEditResolved
                                                }
                                                onEditError={handleEditError}
                                                isDocReloading={(docId) =>
                                                    reloadingDocIds.has(docId)
                                                }
                                                isEditReloading={(editId) =>
                                                    reloadingEditIds.has(editId)
                                                }
                                                resolvedEditStatuses={
                                                    resolvedEditStatuses
                                                }
                                                isLast={
                                                    i === lastAssistantIndex
                                                }
                                                onShareClick={
                                                    chatId
                                                        ? () =>
                                                              setShareOpen(true)
                                                        : undefined
                                                }
                                                onSaveAsContext={
                                                    contextsServiceEnabled()
                                                        ? setSaveCtxSources
                                                        : undefined
                                                }
                                                messageId={msg.id}
                                                flagged={!!msg.flagged}
                                                onFlagChange={onFlagChange}
                                                piiSessionId={piiSessionId}
                                            />
                                        )}
                                    </div>
                                ));
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>

                {/* Scroll to bottom button */}
                {showScrollButton && (
                    <div
                        className="absolute left-1/2 -translate-x-1/2 z-19"
                        style={{ bottom: inputHeight + 12 }}
                    >
                        <button
                            onClick={scrollToBottom}
                            className="p-2 rounded-full bg-background/70 backdrop-blur-xs cursor-pointer border border-border"
                        >
                            <ArrowDown className="h-6 w-6 text-muted-foreground" />
                        </button>
                    </div>
                )}

                {/* Chat input */}
                <div
                    ref={chatInputRef}
                    className="absolute bottom-0 left-0 right-0 w-full z-30"
                >
                    <div className="w-full max-w-4xl mx-auto px-4 md:px-6">
                        <div className="w-full rounded-t-xl bg-background">
                            <ChatInput
                                onSubmit={handleChat}
                                onCancel={cancel}
                                isLoading={isResponseLoading}
                                chatId={chatId ?? null}
                            />
                            <div className="py-3 text-center">
                                <p className="text-xs text-muted-foreground">
                                    {t("disclaimer")}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <AssistantWorkflowModal
                open={workflowModalOpen}
                onClose={() => setWorkflowModalOpen(false)}
                onSelect={() => setWorkflowModalOpen(false)}
                initialWorkflowId={workflowModalInitialId}
            />

            {shareOpen && chatId && (
                <ShareChatModal
                    chatId={chatId}
                    chatTitle={chatTitle ?? null}
                    onClose={() => setShareOpen(false)}
                />
            )}

            {saveCtxSources && (
                <SaveAsContextModal
                    sources={saveCtxSources}
                    messages={messages}
                    onClose={() => setSaveCtxSources(null)}
                />
            )}

            {panelMounted && (
                <div
                    className={`fixed md:relative inset-0 md:inset-auto md:h-full md:flex-shrink-0 z-40 md:z-auto transition-transform duration-300 ease-in-out ${panelVisible ? "translate-x-0" : "translate-x-full"}`}
                >
                    <AssistantSidePanel
                        tabs={tabs}
                        activeTabId={activeTabId}
                        onActivateTab={setActiveTabId}
                        onCloseTab={closeTab}
                        onCloseAll={closeAllTabs}
                        isEditorReloading={(documentId) =>
                            reloadingDocIds.has(documentId)
                        }
                        isEditReloading={(editId) =>
                            reloadingEditIds.has(editId)
                        }
                        onEditResolveStart={handleEditResolveStart}
                        onEditResolved={handleEditResolved}
                        onEditError={handleEditError}
                        onWarningDismiss={handleWarningDismiss}
                        onScrollChange={handleScrollChange}
                        onSaved={handleDocSaved}
                        onDraftEditApplied={handleDocSaved}
                    />
                </div>
            )}
        </div>
    );
}
