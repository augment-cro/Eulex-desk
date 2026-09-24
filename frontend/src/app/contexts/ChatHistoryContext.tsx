"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
    createChat,
    createChatGroup,
    deleteChat,
    deleteChatGroup,
    listChatGroups,
    listChats,
    renameChat,
    updateChat,
    updateChatGroup,
} from "@/app/lib/mikeApi";
import type {
    MikeChat,
    MikeChatGroup,
    MikeMessage,
} from "@/app/components/shared/types";

interface ChatHistoryContextType {
    chats: MikeChat[] | null;
    currentChatId: string | null;
    setCurrentChatId: (chatId: string | null) => void;
    loadChats: () => Promise<void>;
    saveChat: (projectId?: string) => Promise<string | null>;
    renameChat: (chatId: string, title: string) => Promise<void>;
    newChatMessages: MikeMessage[] | null;
    setNewChatMessages: (messages: MikeMessage[] | null) => void;
    replaceChatId: (
        oldChatId: string,
        newChatId: string,
        title?: string,
    ) => void;
    deleteChat: (chatId: string) => Promise<void>;
    // Sidebar history management (groups / pin / archive — tracker #13).
    groups: MikeChatGroup[] | null;
    archivedChats: MikeChat[] | null;
    historyView: "active" | "archived";
    setHistoryView: (view: "active" | "archived") => void;
    createGroup: (name: string) => Promise<MikeChatGroup | null>;
    renameGroup: (groupId: string, name: string) => Promise<void>;
    archiveGroup: (groupId: string) => Promise<void>;
    restoreGroup: (groupId: string) => Promise<void>;
    deleteGroup: (groupId: string) => Promise<void>;
    moveChatToGroup: (
        chatId: string,
        groupId: string | null,
    ) => Promise<void>;
    setChatPinned: (chatId: string, pinned: boolean) => Promise<void>;
    setChatStatus: (
        chatId: string,
        status: "active" | "archived",
    ) => Promise<void>;
}

const ChatHistoryContext = createContext<ChatHistoryContextType | undefined>(
    undefined,
);

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
    const { user } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [chats, setChats] = useState<MikeChat[] | null>(null);
    const [groups, setGroups] = useState<MikeChatGroup[] | null>(null);
    const [archivedChats, setArchivedChats] = useState<MikeChat[] | null>(
        null,
    );
    const [historyView, setHistoryViewState] = useState<
        "active" | "archived"
    >("active");
    const [currentChatId, setCurrentChatId] = useState<string | null>(null);
    const [newChatMessages, setNewChatMessages] = useState<
        MikeMessage[] | null
    >(null);

    const loadChats = useCallback(async () => {
        if (!user) {
            setChats([]);
            return;
        }

        try {
            const data = await listChats();
            setChats(data);
        } catch {
            // Transient refresh failure (loadChats reruns after every
            // completed turn) must not wipe an already-loaded sidebar —
            // keep the previous list; only seed [] on first load (#91).
            setChats((prev) => prev ?? []);
        }
    }, [user]);

    const loadGroups = useCallback(async () => {
        if (!user) {
            setGroups([]);
            return;
        }
        try {
            const data = await listChatGroups();
            setGroups(data);
        } catch {
            setGroups((prev) => prev ?? []);
        }
    }, [user]);

    const loadArchivedChats = useCallback(async () => {
        if (!user) {
            setArchivedChats([]);
            return;
        }
        try {
            const data = await listChats("archived");
            setArchivedChats(data);
        } catch {
            setArchivedChats((prev) => prev ?? []);
        }
    }, [user]);

    useEffect(() => {
        if (!user) {
            setChats([]);
            setGroups([]);
            setArchivedChats(null);
            setHistoryViewState("active");
            setCurrentChatId(null);
            return;
        }

        void loadChats();
        void loadGroups();
    }, [user, loadChats, loadGroups]);

    // Archived list is fetched lazily, and refreshed on every re-entry so
    // it can't drift far from the server.
    const setHistoryView = useCallback(
        (view: "active" | "archived") => {
            setHistoryViewState(view);
            if (view === "archived") void loadArchivedChats();
        },
        [loadArchivedChats],
    );

    const replaceChatId = useCallback(
        (oldChatId: string, newChatId: string, title?: string) => {
            if (!oldChatId || !newChatId || oldChatId === newChatId) {
                setCurrentChatId(newChatId || oldChatId || null);
                return;
            }

            setChats((prev) => {
                if (!prev) return prev;

                const nextChats = prev.map((chat) =>
                    chat.id === oldChatId
                        ? { ...chat, id: newChatId, title: title ?? chat.title }
                        : chat,
                );

                const seen = new Set<string>();
                return nextChats.filter((chat) => {
                    if (seen.has(chat.id)) return false;
                    seen.add(chat.id);
                    return true;
                });
            });
            setCurrentChatId(newChatId);
        },
        [],
    );

    const saveChat = useCallback(
        async (projectId?: string): Promise<string | null> => {
            try {
                const { id } = await createChat(
                    projectId ? { project_id: projectId } : undefined,
                );
                const now = new Date().toISOString();
                const newChat: MikeChat = {
                    id,
                    project_id: projectId ?? null,
                    user_id: user?.id ?? "",
                    title: null,
                    created_at: now,
                    group_id: null,
                    pinned: false,
                    status: "active",
                };
                setChats((prev) => [newChat, ...(prev ?? [])]);
                return id;
            } catch {
                return null;
            }
        },
        [user],
    );

    const renameChatFn = useCallback(
        async (chatId: string, title: string) => {
            setChats((prev) =>
                (prev ?? []).map((c) =>
                    c.id === chatId ? { ...c, title } : c,
                ),
            );
            setArchivedChats((prev) =>
                prev
                    ? prev.map((c) => (c.id === chatId ? { ...c, title } : c))
                    : prev,
            );
            try {
                await renameChat(chatId, title);
            } catch {
                void loadChats();
            }
        },
        [loadChats],
    );

    const deleteChatFn = useCallback(
        async (chatId: string) => {
            const chat =
                chats?.find((c) => c.id === chatId) ??
                archivedChats?.find((c) => c.id === chatId);
            setChats((prev) => (prev ?? []).filter((c) => c.id !== chatId));
            setArchivedChats((prev) =>
                prev ? prev.filter((c) => c.id !== chatId) : prev,
            );
            if (currentChatId === chatId) setCurrentChatId(null);
            // Deleting the conversation that's on screen must also leave
            // it — otherwise the dead transcript stays up with a live
            // composer and the next send silently forks a new chat via
            // the backend's stale-id fallthrough (issue #87).
            if (pathname?.includes(`/chat/${chatId}`)) {
                router.push(
                    chat?.project_id
                        ? `/projects/${chat.project_id}`
                        : "/assistant",
                );
            }
            try {
                await deleteChat(chatId);
            } catch {
                void loadChats();
            }
        },
        [chats, archivedChats, currentChatId, loadChats, pathname, router],
    );

    const createGroup = useCallback(
        async (name: string): Promise<MikeChatGroup | null> => {
            try {
                const group = await createChatGroup(name);
                setGroups((prev) =>
                    [...(prev ?? []), group].sort((a, b) =>
                        a.name.localeCompare(b.name),
                    ),
                );
                return group;
            } catch {
                return null;
            }
        },
        [],
    );

    const renameGroup = useCallback(
        async (groupId: string, name: string) => {
            setGroups((prev) =>
                (prev ?? [])
                    .map((g) => (g.id === groupId ? { ...g, name } : g))
                    .sort((a, b) => a.name.localeCompare(b.name)),
            );
            try {
                await updateChatGroup(groupId, { name });
            } catch {
                void loadGroups();
            }
        },
        [loadGroups],
    );

    // Archiving a group also archives its active chats (server cascade —
    // mirror it locally so the section disappears without a refetch).
    const archiveGroup = useCallback(
        async (groupId: string) => {
            setGroups((prev) =>
                (prev ?? []).map((g) =>
                    g.id === groupId
                        ? { ...g, status: "archived" as const }
                        : g,
                ),
            );
            setChats((prev) =>
                (prev ?? []).filter((c) => c.group_id !== groupId),
            );
            try {
                await updateChatGroup(groupId, { status: "archived" });
            } catch {
                void loadGroups();
                void loadChats();
            }
        },
        [loadGroups, loadChats],
    );

    // Restoring only flips the group back to active — its chats stay
    // archived and are restored individually (spec §8.3).
    const restoreGroup = useCallback(
        async (groupId: string) => {
            setGroups((prev) =>
                (prev ?? []).map((g) =>
                    g.id === groupId
                        ? { ...g, status: "active" as const }
                        : g,
                ),
            );
            try {
                await updateChatGroup(groupId, { status: "active" });
            } catch {
                void loadGroups();
            }
        },
        [loadGroups],
    );

    // Deleting a group soft-deletes every chat in it (server cascade).
    const deleteGroup = useCallback(
        async (groupId: string) => {
            // Same dead-transcript hazard as deleteChat (#87): if the chat
            // that's open on screen belongs to the deleted group, leave it.
            const openDeleted = (chats ?? []).find(
                (c) =>
                    c.group_id === groupId &&
                    pathname?.includes(`/chat/${c.id}`),
            );
            setGroups((prev) =>
                (prev ?? []).filter((g) => g.id !== groupId),
            );
            setChats((prev) =>
                (prev ?? []).filter((c) => c.group_id !== groupId),
            );
            setArchivedChats((prev) =>
                prev ? prev.filter((c) => c.group_id !== groupId) : prev,
            );
            if (openDeleted) {
                setCurrentChatId(null);
                router.push(
                    openDeleted.project_id
                        ? `/projects/${openDeleted.project_id}`
                        : "/assistant",
                );
            }
            try {
                await deleteChatGroup(groupId);
            } catch {
                void loadGroups();
                void loadChats();
            }
        },
        [chats, loadGroups, loadChats, pathname, router],
    );

    const moveChatToGroup = useCallback(
        async (chatId: string, groupId: string | null) => {
            setChats((prev) =>
                (prev ?? []).map((c) =>
                    c.id === chatId ? { ...c, group_id: groupId } : c,
                ),
            );
            try {
                await updateChat(chatId, { group_id: groupId });
            } catch {
                void loadChats();
            }
        },
        [loadChats],
    );

    const setChatPinned = useCallback(
        async (chatId: string, pinned: boolean) => {
            setChats((prev) =>
                (prev ?? []).map((c) =>
                    c.id === chatId ? { ...c, pinned } : c,
                ),
            );
            try {
                await updateChat(chatId, { pinned });
            } catch {
                void loadChats();
            }
        },
        [loadChats],
    );

    // Moves the chat between the active and archived lists. The open chat
    // stays open when archived — only the sidebar placement changes.
    // Reads come from the state values in scope (never setState inside a
    // sibling updater — updaters must stay pure; StrictMode runs them
    // twice). Seeding an unfetched archived list is fine: entering the
    // archived view always refetches, so a partial list is display-only.
    const setChatStatus = useCallback(
        async (chatId: string, status: "active" | "archived") => {
            if (status === "archived") {
                const chat = chats?.find((c) => c.id === chatId);
                setChats((prev) =>
                    (prev ?? []).filter((c) => c.id !== chatId),
                );
                if (chat)
                    setArchivedChats((arch) => [
                        { ...chat, status: "archived" },
                        ...(arch ?? []),
                    ]);
            } else {
                const chat = archivedChats?.find((c) => c.id === chatId);
                setArchivedChats((prev) =>
                    prev ? prev.filter((c) => c.id !== chatId) : prev,
                );
                if (chat)
                    setChats((act) => [
                        { ...chat, status: "active" },
                        ...(act ?? []),
                    ]);
            }
            try {
                await updateChat(chatId, { status });
            } catch {
                void loadChats();
                void loadArchivedChats();
            }
        },
        [chats, archivedChats, loadChats, loadArchivedChats],
    );

    const value = useMemo(
        () => ({
            chats,
            currentChatId,
            setCurrentChatId,
            loadChats,
            saveChat,
            renameChat: renameChatFn,
            newChatMessages,
            setNewChatMessages,
            replaceChatId,
            deleteChat: deleteChatFn,
            groups,
            archivedChats,
            historyView,
            setHistoryView,
            createGroup,
            renameGroup,
            archiveGroup,
            restoreGroup,
            deleteGroup,
            moveChatToGroup,
            setChatPinned,
            setChatStatus,
        }),
        [
            chats,
            currentChatId,
            loadChats,
            saveChat,
            renameChatFn,
            newChatMessages,
            replaceChatId,
            deleteChatFn,
            groups,
            archivedChats,
            historyView,
            setHistoryView,
            createGroup,
            renameGroup,
            archiveGroup,
            restoreGroup,
            deleteGroup,
            moveChatToGroup,
            setChatPinned,
            setChatStatus,
        ],
    );

    return (
        <ChatHistoryContext.Provider value={value}>
            {children}
        </ChatHistoryContext.Provider>
    );
}

export function useChatHistoryContext() {
    const context = useContext(ChatHistoryContext);
    if (!context) {
        throw new Error(
            "useChatHistoryContext must be used within a ChatHistoryProvider",
        );
    }
    return context;
}
