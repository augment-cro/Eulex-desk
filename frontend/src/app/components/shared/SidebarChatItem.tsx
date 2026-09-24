"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
    Archive,
    ArchiveRestore,
    Check,
    FolderInput,
    FolderMinus,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Trash2,
    X,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/contexts/AuthContext";
import { OwnerOnlyModal } from "@/app/components/shared/OwnerOnlyModal";
import { NewChatGroupDialog } from "@/app/components/shared/NewChatGroupDialog";
import { useConfirmDialog } from "@/app/components/modals/confirm-dialog";
import type { MikeChat } from "@/app/components/shared/types";

interface Props {
    chat: MikeChat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
    /** Which history list this row is rendered in (defaults to active). */
    view?: "active" | "archived";
}

export function SidebarChatItem({
    chat,
    isActive,
    onSelect,
    projectName,
    view = "active",
}: Props) {
    const {
        renameChat,
        deleteChat,
        groups,
        createGroup,
        moveChatToGroup,
        setChatPinned,
        setChatStatus,
    } = useChatHistoryContext();
    const { user } = useAuth();
    const t = useTranslations("chatItem");
    const tc = useTranslations("common");
    const tDelete = useTranslations("confirmDelete");
    const { confirm: confirmDialog, dialog: confirmDialogEl } =
        useConfirmDialog();
    const [isRenaming, setIsRenaming] = useState(false);
    // Legacy chats created via the upstream `implement workflow`
    // placeholder (and any other chats whose first message was too
    // generic for the title model) ended up with the literal English
    // title "New Chat". Treat that exact value as "no title" at the
    // display layer so HR users see "Neimenovani razgovor" instead.
    const displayTitle =
        chat.title && chat.title.trim() !== "" && chat.title !== "New Chat"
            ? chat.title
            : null;
    const [editTitle, setEditTitle] = useState(displayTitle ?? "");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [showNewGroupDialog, setShowNewGroupDialog] = useState(false);
    const editInputRef = useRef<HTMLInputElement>(null);
    // Sidebar can show collaborator chats from projects the user owns;
    // rename/delete/pin/move/archive are still creator-only on the
    // backend, so guard here.
    const isChatOwner = !!user?.id && chat.user_id === user.id;

    // Groups a chat can be moved into (never archived ones).
    const activeGroups = (groups ?? []).filter((g) => g.status === "active");

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        if (trimmed) await renameChat(chat.id, trimmed);
        setIsRenaming(false);
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(displayTitle ?? "");
    };

    /** Runs `action` if the user owns the chat; otherwise shows the
     *  owner-only modal with the given action phrase. */
    const ownerGate = (actionPhrase: string, action: () => void) => {
        if (!isChatOwner) {
            setOwnerOnlyAction(actionPhrase);
            return;
        }
        action();
    };

    const handleDelete = async () => {
        const trimmed = chat.title?.trim();
        const ok = await confirmDialog({
            title: tDelete("chatTitle"),
            message: trimmed
                ? tDelete("chatBodyNamed", { title: trimmed })
                : tDelete("chatBody"),
            confirmLabel: tDelete("deleteAction"),
            destructive: true,
        });
        if (!ok) return;
        void deleteChat(chat.id);
    };

    return (
        <div
            className={`group relative flex items-center w-full h-9 rounded-md transition-colors ${
                isActive ? "bg-secondary" : "hover:bg-accent"
            }`}
        >
            {isRenaming ? (
                <div className="flex items-center w-full px-2 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className="flex-1 bg-surface-elevated rounded px-1 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                        onClick={() => void handleRenameSave()}
                        aria-label={tc("save")}
                        className="ml-1.5 py-2 hover:bg-secondary rounded text-success"
                    >
                        <Check className="h-3 w-3" />
                    </button>
                    <button
                        onClick={handleRenameCancel}
                        aria-label={tc("cancel")}
                        className="ml-1 py-2 hover:bg-secondary rounded text-destructive"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ) : (
                <>
                    <button
                        data-testid="sidebar-conversation"
                        onClick={onSelect}
                        onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            const overflow = el.scrollWidth - el.clientWidth;
                            if (overflow > 0) el.scrollTo({ left: overflow, behavior: "smooth" });
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.scrollTo({ left: 0, behavior: "smooth" });
                        }}
                        className="sidebar-chat-title flex-1 min-w-0 text-left px-3 py-2 overflow-x-hidden whitespace-nowrap scrollbar-none text-foreground"
                        title={projectName ? `${projectName}: ${displayTitle ?? t("untitledChat")}` : (displayTitle ?? t("untitledChat"))}
                    >
                        {projectName && (
                            <span className="text-muted-foreground/70 font-normal">{projectName}: </span>
                        )}
                        {displayTitle ?? t("untitledChat")}
                    </button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={`p-1 mr-1 text-muted-foreground transition-opacity hover:text-foreground ${
                                    isActive
                                        ? "opacity-100"
                                        : "opacity-0 group-hover:opacity-100"
                                }`}
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-101">
                            {view === "archived" ? (
                                <DropdownMenuItem
                                    onClick={() =>
                                        ownerGate(t("restoreThisChat"), () =>
                                            void setChatStatus(
                                                chat.id,
                                                "active",
                                            ),
                                        )
                                    }
                                >
                                    <ArchiveRestore className="h-4 w-4" />
                                    {t("restore")}
                                </DropdownMenuItem>
                            ) : (
                                <>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            ownerGate(
                                                t("renameThisChat"),
                                                () => {
                                                    setEditTitle(
                                                        displayTitle ?? "",
                                                    );
                                                    setIsRenaming(true);
                                                },
                                            )
                                        }
                                    >
                                        <Pencil className="h-4 w-4" />
                                        {tc("rename")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            ownerGate(t("pinThisChat"), () =>
                                                void setChatPinned(
                                                    chat.id,
                                                    !chat.pinned,
                                                ),
                                            )
                                        }
                                    >
                                        {chat.pinned ? (
                                            <PinOff className="h-4 w-4" />
                                        ) : (
                                            <Pin className="h-4 w-4" />
                                        )}
                                        {chat.pinned ? t("unpin") : t("pin")}
                                    </DropdownMenuItem>
                                    <DropdownMenuSub>
                                        <DropdownMenuSubTrigger>
                                            <FolderInput className="h-4 w-4" />
                                            {t("moveToGroup")}
                                        </DropdownMenuSubTrigger>
                                        <DropdownMenuSubContent className="z-101">
                                            {activeGroups.map((g) => (
                                                <DropdownMenuItem
                                                    key={g.id}
                                                    disabled={
                                                        g.id === chat.group_id
                                                    }
                                                    onClick={() =>
                                                        ownerGate(
                                                            t("moveThisChat"),
                                                            () =>
                                                                void moveChatToGroup(
                                                                    chat.id,
                                                                    g.id,
                                                                ),
                                                        )
                                                    }
                                                >
                                                    <span className="truncate">
                                                        {g.name}
                                                    </span>
                                                </DropdownMenuItem>
                                            ))}
                                            {activeGroups.length > 0 && (
                                                <DropdownMenuSeparator />
                                            )}
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    ownerGate(
                                                        t("moveThisChat"),
                                                        () =>
                                                            setShowNewGroupDialog(
                                                                true,
                                                            ),
                                                    )
                                                }
                                            >
                                                <Plus className="h-4 w-4" />
                                                {t("newGroup")}
                                            </DropdownMenuItem>
                                            {chat.group_id && (
                                                <DropdownMenuItem
                                                    onClick={() =>
                                                        ownerGate(
                                                            t("moveThisChat"),
                                                            () =>
                                                                void moveChatToGroup(
                                                                    chat.id,
                                                                    null,
                                                                ),
                                                        )
                                                    }
                                                >
                                                    <FolderMinus className="h-4 w-4" />
                                                    {t("removeFromGroup")}
                                                </DropdownMenuItem>
                                            )}
                                        </DropdownMenuSubContent>
                                    </DropdownMenuSub>
                                    <DropdownMenuItem
                                        onClick={() =>
                                            ownerGate(
                                                t("archiveThisChat"),
                                                () =>
                                                    void setChatStatus(
                                                        chat.id,
                                                        "archived",
                                                    ),
                                            )
                                        }
                                    >
                                        <Archive className="h-4 w-4" />
                                        {t("archive")}
                                    </DropdownMenuItem>
                                </>
                            )}
                            <DropdownMenuItem
                                onClick={() =>
                                    ownerGate(t("deleteThisChat"), () =>
                                        void handleDelete(),
                                    )
                                }
                                className="text-destructive focus:text-destructive"
                            >
                                <Trash2 className="h-4 w-4" />
                                {tc("delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </>
            )}
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <NewChatGroupDialog
                open={showNewGroupDialog}
                onClose={() => setShowNewGroupDialog(false)}
                onCreate={async (name) => {
                    const group = await createGroup(name);
                    if (!group) return false; // keep dialog open to retry
                    await moveChatToGroup(chat.id, group.id);
                    return true;
                }}
            />
            {confirmDialogEl}
        </div>
    );
}
