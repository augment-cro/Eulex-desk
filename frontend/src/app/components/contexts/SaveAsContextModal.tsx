"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    createContextFromChat,
    updateContext,
    type MikeContext,
} from "@/app/lib/mikeApi";
import {
    buildTranscript,
    toContextSourceInputs,
} from "@/app/lib/saveAsContext";
import type { LegalSource, MikeMessage } from "../shared/types";
import { useContexts } from "@/app/contexts/ContextsContext";
import { WorkflowPromptEditor } from "../workflows/WorkflowPromptEditor";
import { isValidationErrorBody } from "./apiError";

interface Props {
    /** The legal sources cited in the answer being saved. */
    sources: LegalSource[];
    /** The whole chat — flattened into the transcript Eulex Desk drafts from. */
    messages: MikeMessage[];
    onClose: () => void;
}

/**
 * "Save as context" from a chat answer. Step 1: name the context — the
 * cited sources are seeded and Eulex Desk drafts the instructions from the
 * conversation. Step 2: the draft comes back for the user to edit and
 * confirm before finishing.
 */
export function SaveAsContextModal({ sources, messages, onClose }: Props) {
    const t = useTranslations("saveAsContext");
    const tCommon = useTranslations("common");
    const { refresh } = useContexts();

    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [created, setCreated] = useState<MikeContext | null>(null);
    const [instructions, setInstructions] = useState("");

    const sourceInputs = toContextSourceInputs(sources);

    async function handleCreate() {
        if (!name.trim()) return;
        setBusy(true);
        setError("");
        try {
            const { context } = await createContextFromChat({
                name: name.trim(),
                transcript: buildTranscript(messages),
                sources: sourceInputs,
            });
            setCreated(context);
            setInstructions(context.instructions_md ?? "");
            await refresh();
        } catch (err: unknown) {
            console.error("Failed to create context from chat", err);
            setError(
                isValidationErrorBody(err)
                    ? t("invalidInput")
                    : t("failedCreate"),
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleSaveInstructions() {
        if (!created) return;
        setBusy(true);
        setError("");
        try {
            await updateContext(created.id, {
                instructions_md: instructions || null,
            });
            await refresh();
            onClose();
        } catch (err: unknown) {
            console.error("Failed to save instructions", err);
            setError(
                isValidationErrorBody(err)
                    ? t("invalidInput")
                    : t("failedSave"),
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-primary/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-background border border-border overflow-hidden flex flex-col max-h-[85vh]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2 shrink-0">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("breadcrumbRoot")}</span>
                        <span>›</span>
                        <span>{t("title")}</span>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label={tCommon("close")}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="px-6 pt-3 pb-5 flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
                    {created === null ? (
                        <>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t("namePlaceholder")}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        void handleCreate();
                                    }
                                }}
                                autoFocus
                                className="w-full text-2xl font-serif text-foreground placeholder:text-muted-foreground/70 focus:outline-none bg-transparent"
                            />
                            <div>
                                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    {t("seededSources", {
                                        count: sourceInputs.length,
                                    })}
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {sourceInputs.map((s) => (
                                        <Badge
                                            key={s.ref}
                                            variant="secondary"
                                            className="max-w-[280px]"
                                        >
                                            <span className="truncate">
                                                {s.label ?? s.ref}
                                            </span>
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                {t("draftExplainer")}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-sm text-muted-foreground">
                                {t("reviewExplainer", { name: created.name })}
                            </p>
                            <div className="h-64">
                                <WorkflowPromptEditor
                                    value={instructions}
                                    onChange={(v) => setInstructions(v ?? "")}
                                />
                            </div>
                        </>
                    )}
                    {error && (
                        <p className="text-sm text-destructive">{error}</p>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4 shrink-0">
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {tCommon("cancel")}
                    </Button>
                    {created === null ? (
                        <Button
                            type="button"
                            onClick={() => void handleCreate()}
                            disabled={!name.trim() || busy}
                        >
                            {busy ? t("drafting") : t("createDraft")}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            onClick={() => void handleSaveInstructions()}
                            disabled={busy}
                        >
                            {busy ? t("saving") : t("saveContext")}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
