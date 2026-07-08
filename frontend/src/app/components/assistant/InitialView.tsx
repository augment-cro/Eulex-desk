"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useMcpServers } from "@/app/contexts/McpServersContext";
import { ChatInput } from "./ChatInput";
import { SelectAssistantProjectModal } from "./SelectAssistantProjectModal";
import type { MikeMessage } from "../shared/types";

interface InitialViewProps {
    onSubmit: (message: MikeMessage) => void;
}

const GAP = 16; // gap-4 = 1rem = 16px

export function InitialView({ onSubmit }: InitialViewProps) {
    const { user } = useAuth();
    const { profile, loading: profileLoading } = useUserProfile();
    const { chats } = useChatHistoryContext();
    const { loading: mcpLoading } = useMcpServers();
    const t = useTranslations("assistant");
    const [loaded, setLoaded] = useState(false);
    const [projectModalOpen, setProjectModalOpen] = useState(false);

    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    // Composer stays disabled and the compass icon stays spinning until
    // all the boot-time dependent data is in memory: the user profile
    // (for model/effort defaults), chat history (sidebar render +
    // currentChatId routing) and the MCP connector lists (so the
    // toggle button next to the composer has something to show on
    // first open). Without this, the user could type and submit a
    // request before the connector list is even known, which would
    // either fire without their just-opted-in connector enabled, or
    // race against the connector PATCH below.
    const isInitialLoading =
        profileLoading || chats === null || mcpLoading;

    useEffect(() => {
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, []);

    return (
        <div className="flex flex-col h-full w-full px-6">
            <div className="flex-1 flex flex-col items-center justify-center">
                <div className="flex-col items-center w-full max-w-4xl relative px-0 xl:px-8">
                    <div className="mb-10 flex items-center justify-center h-[50px]">
                        <div
                            className="flex items-center justify-center transition-all duration-[900ms] ease-in-out"
                            style={{
                                gap: loaded ? `${GAP}px` : "0px",
                            }}
                        >
                            <div
                                className="transition-all duration-[900ms] ease-in-out overflow-hidden flex items-center"
                                style={{
                                    maxWidth: loaded ? "800px" : "0px",
                                    opacity: loaded ? 1 : 0,
                                }}
                            >
                                <h1 className="text-4xl font-serif font-light text-foreground whitespace-nowrap pt-1">
                                    {t("greeting", { username })}
                                </h1>
                            </div>
                        </div>
                    </div>

                    <ChatInput
                        onSubmit={onSubmit}
                        onCancel={() => {}}
                        isLoading={false}
                        disabled={isInitialLoading}
                        onProjectsClick={() => setProjectModalOpen(true)}
                    />

                    <div className="text-center">
                        <p className="text-xs py-3 mb-3 text-muted-foreground">
                            {t("disclaimer")}
                        </p>
                    </div>
                </div>
            </div>

            <SelectAssistantProjectModal
                open={projectModalOpen}
                onClose={() => setProjectModalOpen(false)}
            />
        </div>
    );
}
