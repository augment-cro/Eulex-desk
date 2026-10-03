"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@/components/ui/tabs";
import {
    addContextSource,
    createContext as apiCreateContext,
    getContext,
    listContextAlerts,
    listContextShares,
    listContextSources,
    removeContextSource,
    updateContext,
    updateContextSource,
    type ContextSourceKind,
    type MikeContextAlertEvent,
    type MikeContextShare,
    type MikeContextSource,
    type MikeContextTask,
} from "@/app/lib/mikeApi";
import { useContexts } from "@/app/contexts/ContextsContext";
import { WorkflowPromptEditor } from "../workflows/WorkflowPromptEditor";
import { SourceRow } from "./SourceRow";
import { SharingPanel } from "./SharingPanel";
import { ContextTasksPanel } from "./ContextTasksPanel";
import { isValidationErrorBody } from "./apiError";
import { SystemContextBadge } from "./SystemContextBadge";
import {
    contextModelLabel,
    groupSources,
    localizedContextDescription,
    localizedContextName,
    type ContextEffort,
} from "./contextLabels";

// Height of the instructions / rules editor inside the dialog.
const EDITOR_HEIGHT = "h-[min(34rem,calc(100dvh-24rem))] min-h-72";

interface Props {
    /** Present when editing an existing context; absent when creating. */
    contextId?: string;
    onClose: () => void;
}

const SOURCE_KINDS: {
    kind: ContextSourceKind;
    labelKey: "kindInstrument" | "kindArticle" | "kindCaselaw" | "kindWeb";
}[] = [
    { kind: "legal_instrument", labelKey: "kindInstrument" },
    { kind: "legal_article", labelKey: "kindArticle" },
    { kind: "caselaw", labelKey: "kindCaselaw" },
    { kind: "web", labelKey: "kindWeb" },
];

export function NewContextModal({ contextId, onClose }: Props) {
    const t = useTranslations("newContext");
    const tPage = useTranslations("contextsPage");
    const tApplied = useTranslations("contextsApplied");
    const tCommon = useTranslations("common");
    const { refresh } = useContexts();

    const [ctxId, setCtxId] = useState<string | null>(contextId ?? null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [instructions, setInstructions] = useState("");
    const [rules, setRules] = useState("");
    // System contexts (published by EULEX) are read-only for users.
    const [isSystem, setIsSystem] = useState(false);
    const [versionLabel, setVersionLabel] = useState<string | null>(null);
    const [answerMode, setAnswerMode] = useState<"strict" | "extended">(
        "strict",
    );
    // The model and reasoning effort a system context answers with.
    const [runModel, setRunModel] = useState<string | null>(null);
    const [runEffort, setRunEffort] = useState<ContextEffort | null>(null);
    const locale = useLocale();
    const [alertsEnabled, setAlertsEnabled] = useState(false);
    const [isOwner, setIsOwner] = useState(true);
    const [allowEdit, setAllowEdit] = useState(true);
    const [sources, setSources] = useState<MikeContextSource[]>([]);
    // A system context's tasks (the "Zadaci" tab), without their steps.
    const [tasks, setTasks] = useState<MikeContextTask[]>([]);
    const [shares, setShares] = useState<MikeContextShare[]>([]);
    const [newKind, setNewKind] =
        useState<ContextSourceKind>("legal_instrument");
    const [newRef, setNewRef] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const isEditing = ctxId !== null;

    // Source-change alerts for this context (contexts-service read model;
    // fails soft to an empty list while alerting is not configured).
    const [alerts, setAlerts] = useState<MikeContextAlertEvent[]>([]);
    useEffect(() => {
        if (!ctxId) return;
        let cancelled = false;
        listContextAlerts(ctxId)
            .then((rows) => { if (!cancelled) setAlerts(rows); })
            .catch(() => { if (!cancelled) setAlerts([]); });
        return () => { cancelled = true; };
    }, [ctxId]);
    // Editing needs the context to have LOADED (a blank, still-loading form
    // must never be saved over stored rules/instructions) and is never
    // offered for an EULEX system context.
    const [loaded, setLoaded] = useState(!contextId);
    const canEdit = loaded && !isSystem && (isOwner || allowEdit);

    useEffect(() => {
        if (!contextId) return;
        let cancelled = false;
        (async () => {
            try {
                const [ctx, srcs] = await Promise.all([
                    getContext(contextId),
                    listContextSources(contextId),
                ]);
                if (cancelled) return;
                const system = ctx.level === "system";
                setIsSystem(system);
                setVersionLabel(ctx.version_label ?? null);
                setAnswerMode(ctx.answer_mode ?? "strict");
                setRunModel(system ? (ctx.model ?? null) : null);
                setRunEffort(system ? (ctx.reasoning_effort ?? null) : null);
                setName(system ? localizedContextName(ctx, locale) : ctx.name);
                setDescription(
                    (system
                        ? localizedContextDescription(ctx, locale)
                        : ctx.description) ?? "",
                );
                setInstructions(ctx.instructions_md ?? "");
                setRules(ctx.rules_md ?? "");
                setAlertsEnabled(ctx.alerts_enabled);
                setIsOwner(ctx.isOwner);
                setAllowEdit(ctx.allowEdit);
                setSources(srcs);
                setTasks(system && Array.isArray(ctx.tasks) ? ctx.tasks : []);
                setLoaded(true);
                // The shares API is owner-only — never call it for a
                // shared editor (it would 403).
                if (ctx.isOwner) {
                    const sh = await listContextShares(contextId);
                    if (!cancelled) setShares(sh);
                }
            } catch (err: unknown) {
                console.error("Failed to load context", err);
                if (!cancelled) setError(t("failedLoad"));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [contextId, t, locale]);

    async function handleSubmit() {
        if (!name.trim()) return;
        setBusy(true);
        setError("");
        try {
            if (isEditing && ctxId) {
                await updateContext(ctxId, {
                    name: name.trim(),
                    description: description.trim() || null,
                    instructions_md: instructions || null,
                    rules_md: rules || null,
                });
                await refresh();
                onClose();
            } else {
                const created = await apiCreateContext({
                    name: name.trim(),
                    description: description.trim() || undefined,
                });
                setCtxId(created.id);
                await refresh();
            }
        } catch (err: unknown) {
            console.error("Failed to save context", err);
            setError(
                isValidationErrorBody(err)
                    ? t("invalidInput")
                    : isEditing
                      ? t("failedUpdate")
                      : t("failedCreate"),
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleAlertsToggle(next: boolean) {
        if (!ctxId) return;
        setAlertsEnabled(next); // optimistic
        try {
            await updateContext(ctxId, { alerts_enabled: next });
        } catch {
            setAlertsEnabled(!next);
        }
    }

    async function handleAddSource(e: React.FormEvent) {
        e.preventDefault();
        if (!ctxId || !newRef.trim()) return;
        setBusy(true);
        setError("");
        try {
            const row = await addContextSource(ctxId, {
                kind: newKind,
                ref: newRef.trim(),
                mode: "retrieved",
            });
            setSources((prev) => [...prev, row]);
            setNewRef("");
        } catch (err: unknown) {
            console.error("Failed to add source", err);
            setError(
                isValidationErrorBody(err)
                    ? t("invalidInput")
                    : t("failedUpdate"),
            );
        } finally {
            setBusy(false);
        }
    }

    async function handlePatchSource(
        sourceId: string,
        patch: {
            mode?: "pinned" | "retrieved";
            retrieval_note?: string;
            tracked_for_alerts?: boolean;
        },
    ) {
        if (!ctxId) return;
        try {
            const row = await updateContextSource(ctxId, sourceId, patch);
            setSources((prev) =>
                prev.map((s) => (s.id === sourceId ? row : s)),
            );
        } catch (err: unknown) {
            console.error("Failed to update source", err);
            setError(t("failedUpdate"));
        }
    }

    async function handleRemoveSource(sourceId: string) {
        if (!ctxId) return;
        try {
            await removeContextSource(ctxId, sourceId);
            setSources((prev) => prev.filter((s) => s.id !== sourceId));
        } catch (err: unknown) {
            console.error("Failed to remove source", err);
            setError(t("failedUpdate"));
        }
    }

    const sourcesTab = (
        <div className="flex flex-col gap-3">
            {/* Context-level alerts toggle (spec §UI). System contexts:
                alerts are out of the MVP, and users cannot edit them. */}
            {isSystem ? (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    <p>
                        {answerMode === "extended"
                            ? tPage("answerModeExtended")
                            : tPage("answerModeStrict")}
                    </p>
                    {sources.some((s) => s.mode === "pinned") && (
                        <p>{t("keySourceHint")}</p>
                    )}
                    {(runModel || runEffort) && (
                        <p>
                            {[
                                runModel
                                    ? tPage("runModel", {
                                          model: contextModelLabel(runModel),
                                      })
                                    : null,
                                runEffort
                                    ? tPage("runEffort", {
                                          level: tApplied(
                                              `effortLevels.${runEffort}`,
                                          ),
                                      })
                                    : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")}
                        </p>
                    )}
                </div>
            ) : (
                <label className="flex items-center gap-2 text-sm text-foreground">
                    <Switch
                        checked={alertsEnabled}
                        disabled={!canEdit}
                        onCheckedChange={(v) => void handleAlertsToggle(v)}
                    />
                    {tPage("alertsToggle")}
                </label>
            )}

            {sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("noSources")}
                </p>
            ) : (
                // Sources by category (legislation, official guidance, case
                // law, documents, other); headings only once there is more
                // than one category.
                groupSources(sources).map(({ group, items }, _i, all) => (
                    <section key={group} className="flex flex-col gap-2">
                        {all.length > 1 && (
                            <h3 className="mt-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                {t(`sourceGroup_${group}`)}
                                <span className="rounded-full bg-secondary px-1.5 text-[11px] tracking-normal">
                                    {items.length}
                                </span>
                            </h3>
                        )}
                        {/* Reading view: one bordered list per category;
                            editing keeps a card per source. */}
                        <div
                            className={
                                canEdit
                                    ? "flex flex-col gap-2"
                                    : "divide-y divide-border overflow-hidden rounded-lg border border-border"
                            }
                        >
                            {items.map((s) => (
                                <SourceRow
                                    key={s.id}
                                    source={s}
                                    readOnly={!canEdit}
                                    hideAlerts={isSystem}
                                    onPatch={(patch) =>
                                        void handlePatchSource(s.id, patch)
                                    }
                                    onRemove={() =>
                                        void handleRemoveSource(s.id)
                                    }
                                />
                            ))}
                        </div>
                    </section>
                ))
            )}

            {canEdit && (
                <form
                    onSubmit={handleAddSource}
                    className="flex flex-col gap-2 rounded-md border border-dashed border-border p-3"
                >
                    <div className="flex flex-wrap gap-2">
                        {SOURCE_KINDS.map(({ kind, labelKey }) => (
                            <button
                                key={kind}
                                type="button"
                                onClick={() => setNewKind(kind)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-xs transition-colors",
                                    newKind === kind
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border text-muted-foreground hover:bg-accent",
                                )}
                            >
                                {t(labelKey)}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2">
                        <Input
                            value={newRef}
                            onChange={(e) => setNewRef(e.target.value)}
                            placeholder={t("refPlaceholder")}
                        />
                        <Button
                            type="submit"
                            size="sm"
                            variant="secondary"
                            disabled={!newRef.trim() || busy}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            {t("addSource")}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-primary/20 backdrop-blur-xs">
            {/* Wide and tall enough to read a context's sources, rules and
                instructions without a cramped scroll area. */}
            <div className="mx-4 flex h-[min(56rem,calc(100dvh-3rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-background">
                {/* Header */}
                <div className="flex shrink-0 items-center justify-between px-8 pt-6 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("breadcrumbRoot")}</span>
                        <span>›</span>
                        <span>
                            {isSystem
                                ? tPage("systemReadOnly")
                                : isEditing
                                  ? t("editContext")
                                  : t("newContext")}
                        </span>
                        {isSystem && (
                            <SystemContextBadge className="ml-1" />
                        )}
                        {isSystem && versionLabel && (
                            <span className="ml-1">{versionLabel}</span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={tCommon("close")}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Not a <form>: the sources and sharing tabs contain their
                    own small forms and forms must not nest. */}
                <div className="flex flex-col flex-1 min-h-0">
                    {/* Body */}
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-3 pb-6">
                        {!canEdit ? (
                            // Reading view: the name and description are
                            // text, so a long description wraps instead of
                            // being cut off in a one-line field.
                            <>
                                <h2 className="font-serif text-2xl text-foreground">
                                    {name}
                                </h2>
                                {description && (
                                    <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                                        {description}
                                    </p>
                                )}
                            </>
                        ) : (
                        <>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("namePlaceholder")}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleSubmit();
                                }
                            }}
                            disabled={!canEdit}
                            className="w-full text-2xl font-serif text-foreground placeholder:text-muted-foreground/70 focus:outline-none bg-transparent"
                            autoFocus={!isEditing}
                        />
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder={t("descriptionPlaceholder")}
                            disabled={!canEdit}
                            className="mt-2 w-full text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none bg-transparent"
                        />
                        </>
                        )}

                        {isEditing && (
                            <Tabs
                                defaultValue="sources"
                                className="mt-5 flex-1 min-h-0"
                            >
                                <TabsList>
                                    <TabsTrigger value="sources">
                                        {tPage("sourcesTab")}
                                    </TabsTrigger>
                                    <TabsTrigger value="instructions">
                                        {tPage("instructionsTab")}
                                    </TabsTrigger>
                                    <TabsTrigger value="rules">
                                        {tPage("rulesTab")}
                                    </TabsTrigger>
                                    {tasks.length > 0 && (
                                        <TabsTrigger value="tasks">
                                            {tPage("tasksTab")}
                                            <span className="ml-1.5 rounded-full bg-secondary px-1.5 text-[11px]">
                                                {tasks.length}
                                            </span>
                                        </TabsTrigger>
                                    )}
                                    {!isSystem && (
                                    <TabsTrigger value="alerts">
                                        {tPage("alertsTab")}
                                        {alerts.length > 0 && (
                                            <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 text-[11px] text-primary">
                                                {alerts.length}
                                            </span>
                                        )}
                                    </TabsTrigger>
                                    )}
                                    {/* Owner-gated: the shares API is
                                        owner-only. */}
                                    {isOwner && !isSystem && (
                                        <TabsTrigger value="sharing">
                                            {tPage("sharingTab")}
                                        </TabsTrigger>
                                    )}
                                </TabsList>
                                <TabsContent
                                    value="sources"
                                    className="min-h-0 overflow-y-auto"
                                >
                                    {sourcesTab}
                                </TabsContent>
                                <TabsContent
                                    value="instructions"
                                    className="min-h-0"
                                >
                                    <div className={EDITOR_HEIGHT}>
                                        <WorkflowPromptEditor
                                            value={instructions}
                                            onChange={setInstructions}
                                            readOnly={!canEdit}
                                        />
                                    </div>
                                </TabsContent>
                                <TabsContent
                                    value="rules"
                                    className="min-h-0"
                                >
                                    {!canEdit && !rules.trim() ? (
                                        <p className="text-sm text-muted-foreground py-6">
                                            {tPage("rulesEmpty")}
                                        </p>
                                    ) : (
                                        <div className={EDITOR_HEIGHT}>
                                            <WorkflowPromptEditor
                                                value={rules}
                                                onChange={setRules}
                                                readOnly={!canEdit}
                                            />
                                        </div>
                                    )}
                                </TabsContent>
                                {tasks.length > 0 && ctxId && (
                                    <TabsContent
                                        value="tasks"
                                        className="min-h-0 overflow-y-auto"
                                    >
                                        <ContextTasksPanel
                                            contextId={ctxId}
                                            tasks={tasks}
                                        />
                                    </TabsContent>
                                )}
                                <TabsContent
                                    value="alerts"
                                    className="min-h-0 overflow-y-auto"
                                >
                                    {alerts.length === 0 ? (
                                        <p className="text-sm text-muted-foreground py-6">
                                            {tPage("alertsEmpty")}
                                        </p>
                                    ) : (
                                        <ul className="divide-y divide-border">
                                            {alerts.map((a) => (
                                                <li key={a.id} className="py-3">
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">
                                                            {tPage(`alertChange_${a.change_type}` as "alertChange_amendment")}
                                                        </span>
                                                        <span>{new Date(a.detected_at).toLocaleDateString()}</span>
                                                        <span className="font-mono">{a.source_id}</span>
                                                    </div>
                                                    <p className="mt-1 text-sm text-foreground">{a.summary}</p>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </TabsContent>
                                {isOwner && !isSystem && ctxId && (
                                    <TabsContent
                                        value="sharing"
                                        className="min-h-0 overflow-y-auto"
                                    >
                                        <SharingPanel
                                            contextId={ctxId}
                                            shares={shares}
                                            onSharesChange={setShares}
                                        />
                                    </TabsContent>
                                )}
                            </Tabs>
                        )}

                        {error && (
                            <p className="mt-4 text-sm text-destructive">
                                {error}
                            </p>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-8 py-4">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onClose}
                        >
                            {canEdit ? tCommon("cancel") : tCommon("close")}
                        </Button>
                        {canEdit && (
                            <Button
                                type="button"
                                onClick={() => void handleSubmit()}
                                disabled={!name.trim() || busy}
                            >
                                {busy
                                    ? isEditing
                                        ? t("saving")
                                        : t("creating")
                                    : isEditing
                                      ? t("saveChanges")
                                      : t("createContext")}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
