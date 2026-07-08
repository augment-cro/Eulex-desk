"use client";

import { useCallback, useState } from "react";
import { Layers } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
    attachContextToProject,
    attachContextToWorkflow,
    contextsServiceEnabled,
    detachContextFromProject,
    detachContextFromWorkflow,
    listContextLinks,
} from "@/app/lib/mikeApi";
import { useContexts } from "@/app/contexts/ContextsContext";

interface Props {
    /** What the contexts get attached to. */
    target: "workflow" | "project";
    targetId: string;
}

/**
 * Header button + dropdown of the user's contexts with attach toggles for
 * the current workflow/project. Attaching requires edit access to the
 * context (backend-enforced); at run time each attached context applies
 * only for people who can access it, so attaching never widens access —
 * the footer hint spells that out.
 */
export function AttachContextsButton({ target, targetId }: Props) {
    const t = useTranslations("attachContexts");
    const { items, loading } = useContexts();

    // context id → attached to this target. Loaded lazily on first open.
    const [attached, setAttached] = useState<Record<string, boolean>>({});
    const [linksLoaded, setLinksLoaded] = useState(false);
    const [error, setError] = useState(false);

    const loadLinks = useCallback(async () => {
        try {
            const entries = await Promise.all(
                items.map(async ({ context }) => {
                    const links = await listContextLinks(context.id);
                    const ids =
                        target === "workflow" ? links.workflows : links.projects;
                    return [context.id, ids.includes(targetId)] as const;
                }),
            );
            setAttached(Object.fromEntries(entries));
            setLinksLoaded(true);
        } catch {
            setError(true);
        }
    }, [items, target, targetId]);

    async function handleToggle(contextId: string, next: boolean) {
        setError(false);
        setAttached((prev) => ({ ...prev, [contextId]: next })); // optimistic
        try {
            if (target === "workflow") {
                if (next) await attachContextToWorkflow(contextId, targetId);
                else await detachContextFromWorkflow(contextId, targetId);
            } else {
                if (next) await attachContextToProject(contextId, targetId);
                else await detachContextFromProject(contextId, targetId);
            }
        } catch {
            setAttached((prev) => ({ ...prev, [contextId]: !next }));
            setError(true);
        }
    }

    // Feature dormant without a configured contexts service.
    if (!contextsServiceEnabled()) return null;
    // Nothing to attach — hide, like the composer contexts button does.
    if (!loading && items.length === 0) return null;

    const attachedCount = Object.values(attached).filter(Boolean).length;

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                // Re-fetch on every open — links may have changed elsewhere.
                if (open) void loadLinks();
                else setError(false);
            }}
        >
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={t("aria")}
                    title={t("title")}
                    className={cn(
                        "flex h-8 items-center justify-center gap-1.5 px-2 text-sm transition-colors cursor-pointer",
                        attachedCount > 0
                            ? "text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                    )}
                >
                    <Layers className="h-4 w-4" />
                    {attachedCount > 0 && (
                        <span className="text-xs font-medium">
                            {attachedCount}
                        </span>
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 p-1">
                <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                    {target === "workflow"
                        ? t("descriptionWorkflow")
                        : t("descriptionProject")}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {items.map(({ context, allowEdit }) => (
                    <label
                        key={context.id}
                        title={allowEdit ? undefined : t("noEditHint")}
                        className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm",
                            allowEdit
                                ? "hover:bg-accent"
                                : "opacity-60 cursor-not-allowed",
                        )}
                    >
                        <span className="min-w-0 truncate text-foreground">
                            {context.name}
                        </span>
                        <Switch
                            size="sm"
                            checked={!!attached[context.id]}
                            disabled={!allowEdit || !linksLoaded}
                            onCheckedChange={(v) =>
                                void handleToggle(context.id, v)
                            }
                        />
                    </label>
                ))}
                {error && (
                    <p className="px-2 py-1.5 text-xs text-destructive">
                        {t("failed")}
                    </p>
                )}
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t("accessHint")}
                </p>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
