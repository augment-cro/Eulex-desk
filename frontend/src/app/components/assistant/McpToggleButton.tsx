"use client";

import { useState } from "react";
import { AlertCircle, Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
    McpServer,
    BuiltinMcpServer,
} from "@/app/lib/mikeApi";
import { useMcpServers } from "@/app/contexts/McpServersContext";
import { CountryFlag, connectorFlagCode } from "@/app/components/shared/CountryFlag";

/**
 * Sit next to "Documents" / "Workflows" in the chat input. Opens a popover
 * where the user toggles each connector on/off. The toggle flips the
 * effective `enabled` state, which the chat backend honors at the start
 * of the next request.
 *
 * Built-in MCP servers (from mike/mcp.json) are mixed into the same list
 * as user-defined connectors with the same plug icon and toggle. They
 * default to enabled for every user; a per-user opt-out is persisted in
 * `user_mcp_builtin_prefs` server-side. URL/headers stay server-side and
 * are not surfaced here.
 *
 * State (list + busy flags + toggling) lives in `McpServersContext` so
 * the initial chat view can show an honest "still loading" indicator on
 * the composer while these lists are in flight — see InitialView.
 */
export function McpToggleButton() {
    const t = useTranslations("mcpToggle");
    const { servers, builtins, busy, toggleUser, toggleBuiltin } =
        useMcpServers();
    const [open, setOpen] = useState(false);

    const builtinCount = builtins?.length ?? 0;
    const userCount = servers?.length ?? 0;

    if (
        servers !== null &&
        builtins !== null &&
        userCount === 0 &&
        builtinCount === 0
    )
        return null;

    const enabledCount =
        (servers?.filter((s) => s.enabled).length ?? 0) +
        (builtins?.filter((b) => b.enabled).length ?? 0);
    const totalCount = userCount + builtinCount;

    return (
        <DropdownMenu onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label="Manage context for this chat"
                    title={
                        servers === null
                            ? t("loadingConnectors")
                            : t("connectorStatus", { enabled: enabledCount, total: totalCount })
                    }
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors ${
                        enabledCount > 0
                            ? "bg-brand text-brand-foreground hover:bg-brand/90"
                            : `text-foreground hover:bg-accent ${open ? "bg-secondary" : ""}`
                    }`}
                >
                    <Plug className="h-3.5 w-3.5" />
                    {enabledCount > 0 && totalCount > 0 && (
                        <span className="text-xs font-medium text-brand-foreground">
                            {enabledCount}
                        </span>
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 p-1">
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                    {t("legislation")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                {/* Built-in connectors first — they're "preset defaults". */}
                {builtins?.map((b) => (
                    <BuiltinRow
                        key={`builtin:${b.slug}`}
                        server={b}
                        busy={busy[`builtin:${b.slug}`] === true}
                        onToggle={() => toggleBuiltin(b)}
                        defaultLabel={t("defaultBadge")}
                    />
                ))}

                {/* User-configured connectors */}
                {servers?.map((s) => (
                    <McpRow
                        key={s.id}
                        server={s}
                        busy={busy[s.id] === true}
                        onToggle={() => toggleUser(s)}
                        t={t}
                    />
                ))}


            </DropdownMenuContent>
        </DropdownMenu>
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
    const flag = connectorFlagCode(server.slug);
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded-sm disabled:opacity-50"
        >
            <span className="flex items-center gap-2 min-w-0">
                {flag ? (
                    <CountryFlag code={flag} label={server.name} />
                ) : (
                    <Plug className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                )}
                <span className="truncate">
                    {flag ? flag.toUpperCase() : server.name}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-foreground/70 bg-accent px-1 py-0.5 rounded shrink-0 leading-none">
                    {defaultLabel}
                </span>
            </span>
            <ToggleSwitch on={server.enabled} />
        </button>
    );
}

function McpRow({
    server,
    busy,
    onToggle,
    t,
}: {
    server: McpServer;
    busy: boolean;
    onToggle: () => void;
    t: (key: string) => string;
}) {
    const safeName =
        server.name.trim().length > 0 ? server.name.trim() : t("untitled");
    return (
        <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-sm hover:bg-accent rounded-sm disabled:opacity-50"
        >
            <span className="flex items-center gap-2 min-w-0">
                <Plug className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                <span className="truncate">{safeName}</span>
                {server.last_error && (
                    <AlertCircle
                        className="h-3 w-3 text-destructive shrink-0"
                        aria-label={`Error: ${server.last_error}`}
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
                on ? "bg-primary" : "bg-secondary"
            }`}
        >
            <span
                className={`inline-block w-3 h-3 rounded-full bg-background transition-transform ${
                    on ? "translate-x-3.5" : "translate-x-0.5"
                }`}
            />
        </span>
    );
}
