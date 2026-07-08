import React, { useEffect, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import {
    requestTabSwitch,
    useChatContext,
} from "../contexts/ChatContextStore";
import ChatInput from "./ChatInput";
import ChatHistoryList from "./ChatHistoryList";
import ChatMessageView from "./ChatMessage";
import MikeLogo from "./MikeLogo";
import type { BuiltinMcpServer, McpServer } from "../lib/api";
import { useTranslation } from "../i18n/I18nProvider";

interface Props {
    mcpUserServers: McpServer[];
    mcpBuiltinServers: BuiltinMcpServer[];
    mcpLoading: boolean;
    mcpRefresh: () => Promise<void>;
}

export default function ChatPanel({
    mcpUserServers,
    mcpBuiltinServers,
    mcpLoading,
    mcpRefresh,
}: Props) {
    const { messages, chatId, isStreaming, error, send, stop, reset, loadChat } =
        useChat();
    const {
        activeProjectId,
        setActiveProjectId,
        pendingWorkflow,
        consumePendingWorkflow,
    } = useChatContext();
    const [historyOpen, setHistoryOpen] = useState(false);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const t = useTranslation();

    // Keep the viewport pinned to the bottom while a turn streams in.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [messages]);

    // Reset the chat when the user swaps to a different project, so the
    // server doesn't try to associate this conversation with two projects.
    const lastProjectRef = useRef<string | null>(activeProjectId);
    useEffect(() => {
        if (lastProjectRef.current !== activeProjectId) {
            lastProjectRef.current = activeProjectId;
            reset();
        }
    }, [activeProjectId, reset]);

    return (
        <div className="flex flex-col h-full">
            <div
                ref={scrollerRef}
                className="flex-1 overflow-y-auto p-3 space-y-3 chat-scroll-anchor"
            >
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center text-sm text-gray-500 px-4">
                        <MikeLogo size={36} className="mb-3" />
                        <p className="font-medium text-gray-700 mb-1">
                            {t("chat.ready")}
                        </p>
                        <p className="text-xs">{t("chat.intro")}</p>
                        <button
                            type="button"
                            onClick={() => requestTabSwitch("workflows")}
                            className="text-[11px] mt-3 text-mike-600 hover:text-mike-700"
                        >
                            {t("chat.browseWorkflows")}
                        </button>
                    </div>
                ) : (
                    messages.map((m) => <ChatMessageView key={m.id} msg={m} />)
                )}

                {error ? (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                        {error}
                    </div>
                ) : null}
            </div>

            <ChatInput
                activeProjectId={activeProjectId}
                onChangeProject={setActiveProjectId}
                isStreaming={isStreaming}
                // First message in a fresh chat triggers an auto-attach of
                // the currently open Word document, so the agent can read
                // it without the user having to remember to click Attach.
                isFirstMessageInChat={messages.length === 0}
                onSend={(text, opts) =>
                    send(text, {
                        projectId: activeProjectId,
                        files: opts.files,
                        selection: opts.selection,
                        editMode: opts.editMode,
                        model: opts.model,
                        workflow: opts.workflow,
                        trackedChangesContext: opts.trackedChangesContext,
                    })
                }
                onStop={stop}
                onOpenHistory={() => setHistoryOpen(true)}
                onNewChat={reset}
                pendingWorkflow={pendingWorkflow}
                onClearPendingWorkflow={() => consumePendingWorkflow()}
                mcpUserServers={mcpUserServers}
                mcpBuiltinServers={mcpBuiltinServers}
                mcpLoading={mcpLoading}
                mcpRefresh={mcpRefresh}
            />

            <ChatHistoryList
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                activeChatId={chatId ?? undefined}
                onPick={(id) => {
                    void loadChat(id);
                }}
                onNewChat={reset}
            />
        </div>
    );
}
