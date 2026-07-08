"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Layers, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useContexts } from "@/app/contexts/ContextsContext";
import { listContextAlertCounts } from "@/app/lib/mikeApi";
import { NewContextModal } from "./NewContextModal";

export function ContextsList() {
    const t = useTranslations("contextsPage");
    const tNew = useTranslations("newContext");
    const { items, enabled, loading, toggle, remove } = useContexts();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [creating, setCreating] = useState(false);
    const [editId, setEditId] = useState<string | null>(
        searchParams.get("edit"),
    );
    const [limitHit, setLimitHit] = useState(false);
    const [alertCounts, setAlertCounts] = useState<Record<string, number>>({});

    useEffect(() => {
        // Plan 4 read model; fails soft while alerting is unshipped
        // (503 → no badges).
        listContextAlertCounts()
            .then((rows) =>
                setAlertCounts(
                    Object.fromEntries(rows.map((r) => [r.contextId, r.count])),
                ),
            )
            .catch(() => setAlertCounts({}));
    }, []);

    async function handleToggle(id: string, next: boolean) {
        const res = await toggle(id, next);
        setLimitHit(res.limited === true);
    }

    function closeEditor() {
        setEditId(null);
        // Drop a stale ?edit= deep link so a refresh doesn't reopen it.
        if (searchParams.get("edit")) router.replace("/contexts");
    }

    return (
        <div className="flex flex-col h-full flex-1 overflow-hidden bg-background">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <h1 className="text-2xl font-medium font-serif text-foreground">
                    {t("title")}
                </h1>
                <Button size="sm" onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" />
                    {t("new")}
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto px-8 pb-8">
                {limitHit && (
                    <p className="mb-3 text-sm text-destructive">
                        {tNew("outOfActiveLimit")}
                    </p>
                )}

                {loading ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {[1, 2, 3, 4].map((i) => (
                            <div
                                key={i}
                                className="h-24 rounded-lg border border-border p-4"
                            >
                                <div className="h-4 w-40 rounded bg-muted animate-pulse" />
                                <div className="mt-2 h-3 w-56 rounded bg-muted animate-pulse" />
                            </div>
                        ))}
                    </div>
                ) : items.length === 0 ? (
                    <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                        <Layers className="h-8 w-8 text-muted-foreground/70 mb-4" />
                        <p className="text-2xl font-medium font-serif text-foreground">
                            {t("empty")}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground/70 text-left">
                            {t("emptyDesc")}
                        </p>
                        <Button
                            size="sm"
                            className="mt-4"
                            onClick={() => setCreating(true)}
                        >
                            <Plus className="h-4 w-4" />
                            {t("new")}
                        </Button>
                    </div>
                ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                        {items.map(({ context, isOwner }) => (
                            <div
                                key={context.id}
                                className={cn(
                                    "rounded-lg border border-border p-4 transition-colors",
                                    enabled[context.id] && "bg-secondary",
                                )}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 text-left"
                                        onClick={() => setEditId(context.id)}
                                    >
                                        <div className="flex items-center gap-2 font-medium text-foreground">
                                            <span className="truncate">
                                                {context.name}
                                            </span>
                                            {alertCounts[context.id] ? (
                                                <span
                                                    className="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-xs text-warning"
                                                    title={t("recentAlerts", {
                                                        count: alertCounts[
                                                            context.id
                                                        ],
                                                    })}
                                                >
                                                    {alertCounts[context.id]}
                                                </span>
                                            ) : null}
                                        </div>
                                        {context.description && (
                                            <div className="mt-0.5 text-sm text-muted-foreground line-clamp-2">
                                                {context.description}
                                            </div>
                                        )}
                                    </button>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <Switch
                                            checked={!!enabled[context.id]}
                                            onCheckedChange={(v) =>
                                                void handleToggle(
                                                    context.id,
                                                    v,
                                                )
                                            }
                                            aria-label={t("toggleAria")}
                                        />
                                        {isOwner && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    void remove(context.id)
                                                }
                                                aria-label={t("deleteAria")}
                                                title={t("deleteAria")}
                                                className="rounded-md p-1 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {creating && (
                <NewContextModal onClose={() => setCreating(false)} />
            )}
            {editId && (
                <NewContextModal contextId={editId} onClose={closeEditor} />
            )}
        </div>
    );
}
