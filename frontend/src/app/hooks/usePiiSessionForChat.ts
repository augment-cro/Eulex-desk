"use client";

/**
 * Resolves `chat.id → pii_sessions.id` for the currently rendered chat.
 *
 * Used by `AssistantMessage` to feed `usePiiRenderedText`. Without a
 * session id the lazy de-anonymisation hook cannot call `/render`, so
 * the placeholders `⟦PII:PERSON_1⟧` would stay visible.
 *
 * Behaviour:
 *  - Returns `null` (no session yet) on first render — most chats start
 *    that way until the first /chat call hits the sidecar.
 *  - Re-fetches on `chatId` change.
 *  - Re-fetches when `bumpCounter` ticks (so the parent can trigger a
 *    refetch after a streaming reply that just created a session).
 *
 * The hook is intentionally tiny — caching is the renderer's job (see
 * `usePiiRenderedText` which keeps a per-text cache).
 */

import { useCallback, useEffect, useState } from "react";
import { piiSessionByChatId } from "@/app/lib/mikeApi";

export function usePiiSessionForChat(
    chatId: string | null | undefined,
    bumpCounter: number = 0,
): {
    sessionId: string | null;
    loading: boolean;
    refresh: () => Promise<void>;
} {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);

    const refresh = useCallback(async () => {
        if (!chatId) {
            setSessionId(null);
            return;
        }
        setLoading(true);
        try {
            const res = await piiSessionByChatId(chatId);
            setSessionId(res.session_id);
        } catch {
            // Fail open — leave whatever we had. The render hook is
            // tolerant: when sessionId is null it just returns the
            // raw placeholder text.
        } finally {
            setLoading(false);
        }
    }, [chatId]);

    useEffect(() => {
        void refresh();
    }, [refresh, bumpCounter]);

    return { sessionId, loading, refresh };
}
