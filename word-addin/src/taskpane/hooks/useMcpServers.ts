/**
 * Loads user MCP connectors + built-ins from Eulex Desk backend — mirrors web agent
 * `McpToggleButton` data needs. No silent mass-enable here (removed): toggles
 * in the prompt toolbar control what ships on each chat request.
 */

import { useCallback, useEffect, useState } from "react";
import {
    listBuiltinMcpServers,
    listMcpServers,
    type BuiltinMcpServer,
    type McpServer,
} from "../lib/api";

export interface UseMcpServersResult {
    userServers: McpServer[];
    builtinServers: BuiltinMcpServer[];
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
}

export function useMcpServers(enabled: boolean): UseMcpServersResult {
    const [userServers, setUserServers] = useState<McpServer[]>([]);
    const [builtinServers, setBuiltinServers] = useState<BuiltinMcpServer[]>(
        [],
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [user, builtin] = await Promise.all([
                listMcpServers(),
                listBuiltinMcpServers(),
            ]);
            setUserServers(user);
            setBuiltinServers(builtin);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setUserServers([]);
            setBuiltinServers([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!enabled) {
            setUserServers([]);
            setBuiltinServers([]);
            setError(null);
            return;
        }
        void refresh();
    }, [enabled, refresh]);

    return {
        userServers,
        builtinServers,
        loading,
        error,
        refresh,
    };
}
