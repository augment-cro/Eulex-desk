"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    type ReactNode,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
    contextsReducer,
    initialContextsState,
    activeCount,
    MAX_ACTIVE,
} from "@/app/lib/contextsState";
import {
    contextsServiceEnabled,
    listContexts,
    listContextToggles,
    setContextToggle,
    deleteContext,
    type MikeContextListItem,
} from "@/app/lib/mikeApi";

/**
 * Owns the user's Custom Contexts list plus the per-user active-toggle
 * state used by the composer Contexts button and the /contexts page.
 * Mirrors `McpServersContext`: loaded once at app boot, optimistic
 * toggling with rollback, and a client-side guard for the ≤{MAX_ACTIVE}
 * simultaneously-active limit (the backend enforces the same cap).
 */

interface ContextsContextType {
    items: MikeContextListItem[];
    enabled: Record<string, boolean>;
    loading: boolean;
    /** Items whose toggle is currently on. */
    activeItems: MikeContextListItem[];
    refresh: () => Promise<void>;
    /**
     * Flip a context's active state. Resolves `{ ok: false, limited: true }`
     * when enabling would exceed the active limit (no request is made).
     */
    toggle: (
        id: string,
        enabled: boolean,
    ) => Promise<{ ok: boolean; limited?: boolean }>;
    remove: (id: string) => Promise<void>;
}

const ContextsCtx = createContext<ContextsContextType | undefined>(undefined);

export function ContextsProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [state, dispatch] = useReducer(contextsReducer, initialContextsState);

    const refresh = useCallback(async () => {
        // Feature dormant without a configured contexts service — settle to
        // the empty state with no network calls so every consumer hides.
        if (!contextsServiceEnabled() || !isAuthenticated || !user) {
            dispatch({ type: "loaded", items: [], toggles: [] });
            return;
        }
        try {
            const [items, toggles] = await Promise.all([
                listContexts(),
                listContextToggles(),
            ]);
            dispatch({ type: "loaded", items, toggles });
        } catch {
            dispatch({ type: "loaded", items: [], toggles: [] });
        }
    }, [isAuthenticated, user]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const toggle = useCallback<ContextsContextType["toggle"]>(
        async (id, enabled) => {
            if (
                enabled &&
                !state.enabled[id] &&
                activeCount(state) >= MAX_ACTIVE
            ) {
                return { ok: false, limited: true };
            }
            dispatch({ type: "setEnabled", id, enabled }); // optimistic
            try {
                await setContextToggle(id, enabled);
                return { ok: true };
            } catch {
                dispatch({ type: "setEnabled", id, enabled: !enabled });
                return { ok: false };
            }
        },
        [state],
    );

    const remove = useCallback(async (id: string) => {
        await deleteContext(id);
        dispatch({ type: "removed", id });
    }, []);

    const activeItems = useMemo(
        () => state.items.filter((i) => state.enabled[i.context.id]),
        [state.items, state.enabled],
    );

    const value = useMemo<ContextsContextType>(
        () => ({
            items: state.items,
            enabled: state.enabled,
            loading: state.loading,
            activeItems,
            refresh,
            toggle,
            remove,
        }),
        [state, activeItems, refresh, toggle, remove],
    );

    return (
        <ContextsCtx.Provider value={value}>{children}</ContextsCtx.Provider>
    );
}

export function useContexts(): ContextsContextType {
    const ctx = useContext(ContextsCtx);
    if (ctx === undefined) {
        throw new Error("useContexts must be used within a ContextsProvider");
    }
    return ctx;
}
