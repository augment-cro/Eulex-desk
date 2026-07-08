"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDot, Layers } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useContexts } from "@/app/contexts/ContextsContext";
import { contextsServiceEnabled } from "@/app/lib/mikeApi";

/**
 * Composer "Contexts" toggle — sits next to `McpToggleButton` with the
 * same dropdown-of-toggles UX. When ≥1 context is active, a persistent
 * named chip renders next to the button (spec R3); clicking the chip
 * opens a small Open / Deactivate menu.
 */
export function ContextsToggleButton() {
    const t = useTranslations("contextsPage");
    const tNew = useTranslations("newContext");
    const router = useRouter();
    const { items, enabled, activeItems, loading, toggle } = useContexts();
    const [open, setOpen] = useState(false);
    const [limitHit, setLimitHit] = useState(false);

    // Feature dormant without a configured contexts service.
    if (!contextsServiceEnabled()) return null;
    // Nothing to toggle — hide, like the connector button does.
    if (!loading && items.length === 0) return null;

    const activeCount = activeItems.length;

    async function handleToggle(id: string, next: boolean) {
        const res = await toggle(id, next);
        setLimitHit(res.limited === true);
    }

    return (
        <div className="flex items-center gap-1.5 min-w-0">
            <DropdownMenu
                onOpenChange={(o) => {
                    setOpen(o);
                    if (!o) setLimitHit(false);
                }}
            >
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={t("composerAria")}
                        title={t("title")}
                        className={cn(
                            "flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors",
                            activeCount > 0
                                ? "bg-brand text-brand-foreground hover:bg-brand/90"
                                : cn(
                                      "text-foreground hover:bg-accent",
                                      open && "bg-secondary",
                                  ),
                        )}
                    >
                        <Layers className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{t("title")}</span>
                        {activeCount > 0 && (
                            <span className="text-xs font-medium text-brand-foreground">
                                {activeCount}
                            </span>
                        )}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72 p-1">
                    <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                        {t("title")}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {items.map(({ context }) => (
                        <label
                            key={context.id}
                            className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                        >
                            <span className="min-w-0 truncate text-foreground">
                                {context.name}
                            </span>
                            <Switch
                                size="sm"
                                checked={!!enabled[context.id]}
                                onCheckedChange={(v) =>
                                    void handleToggle(context.id, v)
                                }
                            />
                        </label>
                    ))}
                    {limitHit && (
                        <p className="px-2 py-1.5 text-xs text-destructive">
                            {tNew("outOfActiveLimit")}
                        </p>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Persistent named chips for active contexts (R3). */}
            {activeItems.map(({ context }) => (
                <DropdownMenu key={context.id}>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            title={context.name}
                            className="inline-flex min-w-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-foreground hover:bg-accent transition-colors"
                        >
                            <CircleDot className="h-3 w-3 shrink-0" />
                            <span className="max-w-32 truncate">
                                {context.name}
                            </span>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuItem
                            onSelect={() =>
                                router.push(`/contexts?edit=${context.id}`)
                            }
                        >
                            {t("openContext")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onSelect={() =>
                                void handleToggle(context.id, false)
                            }
                        >
                            {t("deactivate")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            ))}
        </div>
    );
}
