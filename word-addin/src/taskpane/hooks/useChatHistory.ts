/**
 * Loads the user's chat list (GET /chat). The drawer view in
 * ChatHistoryList.tsx consumes this — kept in a hook so future surfaces
 * (e.g. project-scoped chat history) can reuse it.
 */

import { useCallback, useEffect, useState } from "react";
import { listChats, type MikeChat } from "../lib/api";

export function useChatHistory(enabled: boolean = true) {
    const [chats, setChats] = useState<MikeChat[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await listChats();
            setChats(list);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load chats");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (enabled) refresh();
    }, [enabled, refresh]);

    return { chats, loading, error, refresh };
}
