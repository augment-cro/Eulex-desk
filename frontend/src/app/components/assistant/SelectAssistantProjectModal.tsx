"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useDirectoryData } from "../shared/useDirectoryData";
import { ProjectPicker } from "../shared/ProjectPicker";

interface Props {
    open: boolean;
    onClose: () => void;
}

export function SelectAssistantProjectModal({ open, onClose }: Props) {
    const t = useTranslations("projectPicker");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const router = useRouter();
    const { saveChat } = useChatHistoryContext();
    const { loading, projects } = useDirectoryData(open);

    useEffect(() => {
        if (!open) return;
        setSelectedId(null);
    }, [open]);

    if (!open) return null;

    async function handleContinue() {
        if (!selectedId) return;
        setCreating(true);
        try {
            const chatId = await saveChat(selectedId);
            if (!chatId) return;
            onClose();
            router.push(`/projects/${selectedId}/assistant/chat/${chatId}`);
        } finally {
            setCreating(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-foreground/10 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-background border border-border flex flex-col h-[600px] font-sans [&_button]:font-sans">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("breadcrumbAssistant")}</span>
                        <span>›</span>
                        <span>{t("breadcrumbStartChat")}</span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <ProjectPicker
                    projects={projects}
                    loading={loading}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                />

                {/* Footer */}
                <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                    >
                        {t("cancel")}
                    </button>
                    <button
                        onClick={handleContinue}
                        disabled={!selectedId || creating}
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                    >
                        {creating ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            t("continue")
                        )}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
