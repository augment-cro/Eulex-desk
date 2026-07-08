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
import { useAuth } from "@/contexts/AuthContext";
import {
    listMcpServers,
    listBuiltinMcpServers,
    updateMcpServer,
    updateBuiltinMcpServer,
    type McpServer,
    type BuiltinMcpServer,
} from "@/app/lib/mikeApi";

/**
 * Pulls the user's MCP connector list (both user-defined and built-in
 * ones from `mike/mcp.json`) once at app boot so the initial chat view
 * can show an honest "still loading" state on the composer while the
 * lists are in flight. Previously these were fetched lazily inside
 * `McpToggleButton` the first time the dropdown opened, which meant
 * the send button was instantly active even though the connector
 * picker had nothing to populate yet.
 *
 * The provider also owns optimistic toggle state so consumers (the
 * dropdown today; potentially other surfaces tomorrow) don't end up
 * each maintaining their own copy of the list.
 */

interface McpServersContextType {
    servers: McpServer[] | null;
    builtins: BuiltinMcpServer[] | null;
    /** True until both lists have resolved at least once. */
    loading: boolean;
    /** Per-row mutation flags so the toggle UI can disable individual rows. */
    busy: Record<string, boolean>;
    reload: () => Promise<void>;
    toggleUser: (server: McpServer) => Promise<void>;
    toggleBuiltin: (server: BuiltinMcpServer) => Promise<void>;
}

const McpServersContext = createContext<McpServersContextType | undefined>(
    undefined,
);

export function McpServersProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [servers, setServers] = useState<McpServer[] | null>(null);
    const [builtins, setBuiltins] = useState<BuiltinMcpServer[] | null>(null);
    const [busy, setBusy] = useState<Record<string, boolean>>({});

    const reload = useCallback(async () => {
        if (!isAuthenticated || !user) {
            // Anonymous / signed-out: nothing to fetch but we still
            // resolve to empty arrays so consumers can treat the load
            // as completed.
            setServers([]);
            setBuiltins([]);
            return;
        }
        try {
            const [userList, builtinList] = await Promise.all([
                listMcpServers(),
                listBuiltinMcpServers(),
            ]);
            setServers(userList);
            setBuiltins(builtinList);
        } catch {
            setServers([]);
            setBuiltins([]);
        }
    }, [isAuthenticated, user]);

    useEffect(() => {
        if (isAuthenticated && user) {
            setServers(null);
            setBuiltins(null);
            void reload();
        } else {
            setServers([]);
            setBuiltins([]);
        }
    }, [isAuthenticated, user, reload]);

    const toggleUser = useCallback(async (server: McpServer) => {
        const id = server.id;
        setBusy((s) => ({ ...s, [id]: true }));
        setServers((prev) =>
            prev
                ? prev.map((s) =>
                      s.id === id ? { ...s, enabled: !s.enabled } : s,
                  )
                : prev,
        );
        try {
            await updateMcpServer(id, { enabled: !server.enabled });
        } catch {
            // Roll back by reloading fresh state from the server.
            try {
                const fresh = await listMcpServers();
                setServers(fresh);
            } catch {
                // Leave optimistic state; user can retry.
            }
        } finally {
            setBusy((s) => ({ ...s, [id]: false }));
        }
    }, []);

    const toggleBuiltin = useCallback(async (server: BuiltinMcpServer) => {
        const key = `builtin:${server.slug}`;
        setBusy((s) => ({ ...s, [key]: true }));
        setBuiltins((prev) =>
            prev
                ? prev.map((b) =>
                      b.slug === server.slug ? { ...b, enabled: !b.enabled } : b,
                  )
                : prev,
        );
        try {
            await updateBuiltinMcpServer(server.slug, {
                enabled: !server.enabled,
            });
        } catch {
            try {
                const fresh = await listBuiltinMcpServers();
                setBuiltins(fresh);
            } catch {
                // Leave optimistic state.
            }
        } finally {
            setBusy((s) => ({ ...s, [key]: false }));
        }
    }, []);

    const loading = servers === null || builtins === null;

    const value = useMemo<McpServersContextType>(
        () => ({
            servers,
            builtins,
            loading,
            busy,
            reload,
            toggleUser,
            toggleBuiltin,
        }),
        [servers, builtins, loading, busy, reload, toggleUser, toggleBuiltin],
    );

    return (
        <McpServersContext.Provider value={value}>
            {children}
        </McpServersContext.Provider>
    );
}

export function useMcpServers() {
    const ctx = useContext(McpServersContext);
    if (ctx === undefined) {
        throw new Error(
            "useMcpServers must be used within an McpServersProvider",
        );
    }
    return ctx;
}
