"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
    Archive,
    ArchiveRestore,
    Check,
    ChevronDown,
    Folder,
    MoreHorizontal,
    Pencil,
    Trash2,
    X,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useConfirmDialog } from "@/app/components/modals/confirm-dialog";
import type { MikeChatGroup } from "@/app/components/shared/types";

interface Props {
    group: MikeChatGroup;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    /** The group's SidebarChatItem rows. */
    children: ReactNode;
}

/**
 * Collapsible sidebar section for one conversation group (tracker #13):
 * heading with chevron + hover "…" menu (rename inline, archive, delete —
 * both cascade actions confirm with a warning that they apply to every
 * conversation in the group).
 */
export function SidebarChatGroup({
    group,
    collapsed,
    onToggleCollapsed,
    children,
}: Props) {
    const { renameGroup, archiveGroup, deleteGroup } =
        useChatHistoryContext();
    const t = useTranslations("sidebar");
    const tc = useTranslations("common");
    const ti = useTranslations("chatItem");
    const tDelete = useTranslations("confirmDelete");
    const { confirm: confirmDialog, dialog: confirmDialogEl } =
        useConfirmDialog();
    const [isRenaming, setIsRenaming] = useState(false);
    const [editName, setEditName] = useState(group.name);
    const editInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editName.trim();
        if (trimmed && trimmed !== group.name)
            await renameGroup(group.id, trimmed);
        setIsRenaming(false);
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditName(group.name);
    };

    const handleArchive = async () => {
        const ok = await confirmDialog({
            title: tDelete("groupArchiveTitle"),
            message: tDelete("groupArchiveBody", { name: group.name }),
            confirmLabel: tDelete("archiveAction"),
        });
        if (ok) void archiveGroup(group.id);
    };

    const handleDelete = async () => {
        const ok = await confirmDialog({
            title: tDelete("groupDeleteTitle"),
            message: tDelete("groupDeleteBody", { name: group.name }),
            confirmLabel: tDelete("deleteAction"),
            destructive: true,
        });
        if (ok) void deleteGroup(group.id);
    };

    return (
        <div>
            {isRenaming ? (
                <div className="flex items-center px-2.5 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        value={editName}
                        maxLength={100}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className="flex-1 min-w-0 bg-surface-elevated rounded px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleRenameSave()}
                        aria-label={tc("save")}
                        className="ml-1 h-6 w-6 text-success"
                    >
                        <Check className="h-3 w-3" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleRenameCancel}
                        aria-label={tc("cancel")}
                        className="h-6 w-6 text-destructive"
                    >
                        <X className="h-3 w-3" />
                    </Button>
                </div>
            ) : (
                <div className="group/heading flex items-center">
                    {/* px-3 lines the heading text up with the chat rows
                        below (SidebarChatItem's title button is px-3). */}
                    <button
                        onClick={onToggleCollapsed}
                        className="flex-1 min-w-0 flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors text-left"
                        title={group.name}
                    >
                        <span className="truncate">{group.name}</span>
                        <ChevronDown
                            className={cn(
                                "h-3 w-3 flex-shrink-0 transition-transform",
                                collapsed && "-rotate-90",
                            )}
                        />
                    </button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                aria-label={t("groupOptions")}
                                className="p-1 mr-1 text-muted-foreground hover:text-foreground opacity-0 group-hover/heading:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-101">
                            <DropdownMenuItem
                                onClick={() => {
                                    setEditName(group.name);
                                    setIsRenaming(true);
                                }}
                            >
                                <Pencil className="h-4 w-4" />
                                {tc("rename")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => void handleArchive()}
                            >
                                <Archive className="h-4 w-4" />
                                {ti("archive")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => void handleDelete()}
                                className="text-destructive focus:text-destructive"
                            >
                                <Trash2 className="h-4 w-4" />
                                {tc("delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
            {!collapsed && <div className="space-y-1">{children}</div>}
            {confirmDialogEl}
        </div>
    );
}

/**
 * Row for an archived group in the sidebar's archived view: name + "…"
 * menu with Restore (group only — its chats stay archived, spec §8.3)
 * and Delete (cascade, confirmed).
 */
export function SidebarArchivedGroupRow({ group }: { group: MikeChatGroup }) {
    const { restoreGroup, deleteGroup } = useChatHistoryContext();
    const t = useTranslations("sidebar");
    const tc = useTranslations("common");
    const ti = useTranslations("chatItem");
    const tDelete = useTranslations("confirmDelete");
    const { confirm: confirmDialog, dialog: confirmDialogEl } =
        useConfirmDialog();

    const handleDelete = async () => {
        const ok = await confirmDialog({
            title: tDelete("groupDeleteTitle"),
            message: tDelete("groupDeleteBody", { name: group.name }),
            confirmLabel: tDelete("deleteAction"),
            destructive: true,
        });
        if (ok) void deleteGroup(group.id);
    };

    return (
        <div className="group/heading flex items-center h-9 rounded-md hover:bg-accent transition-colors">
            <div
                className="flex-1 min-w-0 flex items-center gap-2 px-3 text-sm text-muted-foreground"
                title={group.name}
            >
                <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{group.name}</span>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        aria-label={t("groupOptions")}
                        className="p-1 mr-1 text-muted-foreground hover:text-foreground opacity-0 group-hover/heading:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                    >
                        <MoreHorizontal className="h-4 w-4" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-101">
                    <DropdownMenuItem
                        onClick={() => void restoreGroup(group.id)}
                    >
                        <ArchiveRestore className="h-4 w-4" />
                        {ti("restore")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => void handleDelete()}
                        className="text-destructive focus:text-destructive"
                    >
                        <Trash2 className="h-4 w-4" />
                        {tc("delete")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {confirmDialogEl}
        </div>
    );
}
