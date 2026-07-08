/**
 * Eulex Desk web parity for assistant chat: same Plug affordance + dropdown toggles
 * for built-in and user MCP connectors (see frontend `McpToggleButton.tsx`).
 */

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Plug, Plus } from "lucide-react";
import {
    updateBuiltinMcpServer,
    updateMcpServer,
    type BuiltinMcpServer,
    type McpServer,
} from "../lib/api";
import { getTaskpaneOrigin, openInDefaultBrowser } from "../lib/officeUi";
import { useTranslation } from "../i18n/I18nProvider";

interface Props {
    userServers: McpServer[];
    builtinServers: BuiltinMcpServer[];
    loading: boolean;
    /** Reload lists after a toggle — parent owns hook state. */
    onRefresh: () => Promise<void>;
}

export default function McpToggleButton({
    userServers,
    builtinServers,
    loading,
    onRefresh,
}: Props) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (
                wrapRef.current &&
                !wrapRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const userCount = userServers.length;
    const builtinCount = builtinServers.length;

    if (
        !loading &&
        userCount === 0 &&
        builtinCount === 0
    ) {
        return null;
    }

    const enabledCount =
        userServers.filter((s) => s.enabled).length +
        builtinServers.filter((b) => b.enabled).length;
    const totalCount = userCount + builtinCount;

    const tooltip = loading
        ? t("mcp.loading")
        : t("mcp.status", { enabled: enabledCount, total: totalCount });

    const handleToggleUser = async (server: McpServer) => {
        setBusy((s) => ({ ...s, [server.id]: true }));
        try {
            await updateMcpServer(server.id, { enabled: !server.enabled });
            await onRefresh();
        } catch {
            await onRefresh();
        } finally {
            setBusy((s) => ({ ...s, [server.id]: false }));
        }
    };

    const handleToggleBuiltin = async (server: BuiltinMcpServer) => {
        const key = `builtin:${server.slug}`;
        setBusy((s) => ({ ...s, [key]: true }));
        try {
            await updateBuiltinMcpServer(server.slug, {
                enabled: !server.enabled,
            });
            await onRefresh();
        } catch {
            await onRefresh();
        } finally {
            setBusy((s) => ({ ...s, [key]: false }));
        }
    };

    const manageUrl = `${getTaskpaneOrigin()}/account/mcp`;

    return (
        <div ref={wrapRef} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title={tooltip}
                aria-label={t("mcp.toggleAria")}
                className={`relative inline-flex items-center gap-1.5 rounded-lg px-2 h-7 text-xs transition-colors ${
                    enabledCount > 0
                        ? "text-blue-600 hover:bg-blue-50"
                        : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                } ${open ? "bg-gray-100" : ""}`}
            >
                <Plug className="h-3.5 w-3.5 shrink-0" />
                {enabledCount > 0 && totalCount > 0 && (
                    <span className="text-xs font-medium text-blue-600 tabular-nums">
                        {enabledCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute left-0 bottom-9 z-20 w-72 rounded-md border border-gray-200 bg-white shadow-lg py-1 text-xs">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-gray-400 font-normal">
                        {t("mcp.title")}
                    </div>
                    <div className="border-t border-gray-100" />

                    {loading && userCount === 0 && builtinCount === 0 ? (
                        <div className="px-2 py-2 text-gray-500">
                            {t("mcp.loading")}
                        </div>
                    ) : (
                        <>
                            {builtinServers.map((b) => (
                                <BuiltinRow
                                    key={`builtin:${b.slug}`}
                                    server={b}
                                    busy={
                                        busy[`builtin:${b.slug}`] === true
                                    }
                                    defaultLabel={t("mcp.defaultBadge")}
                                    onToggle={() => handleToggleBuiltin(b)}
                                />
                            ))}
                            {userServers.map((s) => (
                                <UserRow
                                    key={s.id}
                                    server={s}
                                    busy={busy[s.id] === true}
                                    onToggle={() => handleToggleUser(s)}
                                    untitled={t("mcp.untitled")}
                                />
                            ))}
                        </>
                    )}

                    <div className="border-t border-gray-100 mt-0.5 pt-1">
                        <button
                            type="button"
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-50 rounded-sm"
                            onClick={() => {
                                openInDefaultBrowser(manageUrl);
                                setOpen(false);
                            }}
                        >
                            <Plus className="h-3.5 w-3.5 shrink-0" />
                            {t("mcp.manageConnectors")}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function BuiltinRow({
    server,
    busy,
    onToggle,
    defaultLabel,
}: {
    server: BuiltinMcpServer;
    busy: boolean;
    onToggle: () => void;
    defaultLabel: string;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded-sm disabled:opacity-50 text-left"
        >
            <span className="flex items-center gap-2 min-w-0">
                <Plug className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span className="truncate text-gray-800">{server.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-blue-700/70 bg-blue-50 px-1 py-0.5 rounded shrink-0 leading-none">
                    {defaultLabel}
                </span>
            </span>
            <ToggleSwitch on={server.enabled} />
        </button>
    );
}

function UserRow({
    server,
    busy,
    onToggle,
    untitled,
}: {
    server: McpServer;
    busy: boolean;
    onToggle: () => void;
    untitled: string;
}) {
    const name =
        server.name.trim().length > 0 ? server.name.trim() : untitled;
    const errored = !!server.last_error;

    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-gray-50 rounded-sm disabled:opacity-50 text-left"
        >
            <span className="flex items-center gap-2 min-w-0">
                <Plug className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <span className="truncate text-gray-800">{name}</span>
                {errored && (
                    <AlertCircle
                        className="h-3 w-3 text-red-500 shrink-0"
                        aria-label={server.last_error ?? ""}
                    />
                )}
            </span>
            <ToggleSwitch on={server.enabled} />
        </button>
    );
}

function ToggleSwitch({ on }: { on: boolean }) {
    return (
        <span
            className={`shrink-0 inline-flex items-center w-7 h-4 rounded-full transition-colors ${
                on ? "bg-blue-600" : "bg-gray-300"
            }`}
        >
            <span
                className={`inline-block w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                    on ? "translate-x-3.5" : "translate-x-0.5"
                }`}
            />
        </span>
    );
}
