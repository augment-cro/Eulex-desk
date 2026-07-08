"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
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
    listContextShares,
    listContextSources,
    removeContextSource,
    updateContext,
    updateContextSource,
    type ContextSourceKind,
    type MikeContextShare,
    type MikeContextSource,
} from "@/app/lib/mikeApi";
import { useContexts } from "@/app/contexts/ContextsContext";
import { WorkflowPromptEditor } from "../workflows/WorkflowPromptEditor";
import { SourceRow } from "./SourceRow";
import { SharingPanel } from "./SharingPanel";
import { isValidationErrorBody } from "./apiError";

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
    const tCommon = useTranslations("common");
    const { refresh } = useContexts();

    const [ctxId, setCtxId] = useState<string | null>(contextId ?? null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [instructions, setInstructions] = useState("");
    const [alertsEnabled, setAlertsEnabled] = useState(false);
    const [isOwner, setIsOwner] = useState(true);
    const [allowEdit, setAllowEdit] = useState(true);
    const [sources, setSources] = useState<MikeContextSource[]>([]);
    const [shares, setShares] = useState<MikeContextShare[]>([]);
    const [newKind, setNewKind] =
        useState<ContextSourceKind>("legal_instrument");
    const [newRef, setNewRef] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const isEditing = ctxId !== null;
    const canEdit = isOwner || allowEdit;

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
                setName(ctx.name);
                setDescription(ctx.description ?? "");
                setInstructions(ctx.instructions_md ?? "");
                setAlertsEnabled(ctx.alerts_enabled);
                setIsOwner(ctx.isOwner);
                setAllowEdit(ctx.allowEdit);
                setSources(srcs);
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
    }, [contextId, t]);

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
            {/* Context-level alerts toggle (spec §UI). */}
            <label className="flex items-center gap-2 text-sm text-foreground">
                <Switch
                    checked={alertsEnabled}
                    disabled={!canEdit}
                    onCheckedChange={(v) => void handleAlertsToggle(v)}
                />
                {tPage("alertsToggle")}
            </label>

            {sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("noSources")}
                </p>
            ) : (
                sources.map((s) => (
                    <SourceRow
                        key={s.id}
                        source={s}
                        readOnly={!canEdit}
                        onPatch={(patch) => void handlePatchSource(s.id, patch)}
                        onRemove={() => void handleRemoveSource(s.id)}
                    />
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
            <div
                className="w-full max-w-2xl rounded-2xl bg-background border border-border overflow-hidden flex flex-col"
                style={{ height: 640 }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2 shrink-0">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("breadcrumbRoot")}</span>
                        <span>›</span>
                        <span>
                            {isEditing ? t("editContext") : t("newContext")}
                        </span>
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
                    <div className="px-6 pt-3 pb-5 flex-1 min-h-0 overflow-y-auto flex flex-col">
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
                                    {/* Owner-gated: the shares API is
                                        owner-only. */}
                                    {isOwner && (
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
                                    <div className="h-72">
                                        <WorkflowPromptEditor
                                            value={instructions}
                                            onChange={setInstructions}
                                            readOnly={!canEdit}
                                        />
                                    </div>
                                </TabsContent>
                                {isOwner && ctxId && (
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
                    <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4 shrink-0">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onClose}
                        >
                            {tCommon("cancel")}
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
