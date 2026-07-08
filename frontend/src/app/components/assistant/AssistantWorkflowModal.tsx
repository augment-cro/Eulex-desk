"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MikeWorkflow } from "../shared/types";
import { listWorkflows } from "@/app/lib/mikeApi";
import {
    fetchBuiltinWorkflows,
    getLocalizedWorkflowTitle,
} from "../workflows/builtinWorkflows";

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (workflow: MikeWorkflow) => void;
    projectName?: string;
    projectCmNumber?: string | null;
    initialWorkflowId?: string;
}

export function AssistantWorkflowModal({
    open,
    onClose,
    onSelect,
    projectName,
    projectCmNumber,
    initialWorkflowId,
}: Props) {
    const t = useTranslations("workflowPicker");
    const tBuiltinTitles = useTranslations("builtinWorkflows");
    const [workflows, setWorkflows] = useState<MikeWorkflow[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<MikeWorkflow | null>(null);
    const [search, setSearch] = useState("");
    const [rightVisible, setRightVisible] = useState(false);

    // Resolve a workflow's display title once. Built-in titles come from
    // i18n via getLocalizedWorkflowTitle; user-created workflows keep
    // their original `title` field unchanged.
    const resolveTitle = (wf: MikeWorkflow): string =>
        getLocalizedWorkflowTitle(wf, tBuiltinTitles);

    useEffect(() => {
        if (!selected) {
            setRightVisible(false);
            return;
        }
        const frame = requestAnimationFrame(() => setRightVisible(true));
        return () => cancelAnimationFrame(frame);
    }, [selected]);

    useEffect(() => {
        if (!open) {
            setSelected(null);
            setSearch("");
            return;
        }
        setLoading(true);
        // Built-ins come from the backend (governance pack); [] when no
        // pack is configured. Customs fail soft so the built-ins still show.
        Promise.all([
            fetchBuiltinWorkflows(),
            listWorkflows("assistant").catch(() => [] as MikeWorkflow[]),
        ])
            .then(([allBuiltins, custom]) => {
                const builtins = allBuiltins.filter(
                    (w) => w.type === "assistant",
                );
                const all = [...builtins, ...custom];
                setWorkflows(all);
                if (initialWorkflowId) {
                    const match = all.find((w) => w.id === initialWorkflowId);
                    if (match) setSelected(match);
                }
            })
            .finally(() => setLoading(false));
    }, [open, initialWorkflowId]);

    if (!open) return null;

    const filteredWorkflows = search
        ? workflows.filter((w) =>
              resolveTitle(w)
                  .toLowerCase()
                  .includes(search.toLowerCase()),
          )
        : workflows;

    function handleUse() {
        if (!selected) return;
        onSelect(selected);
        onClose();
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-foreground/10 backdrop-blur-xs">
            <div
                className={`w-full rounded-2xl bg-background border border-border flex flex-col h-[600px] font-sans [&_button]:font-sans ${selected ? "max-w-4xl" : "max-w-2xl"}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 shrink-0 border-b border-border">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        {projectName ? (
                            <>
                                <span>{t("breadcrumbs.projects")}</span>
                                <span>›</span>
                                <span>
                                    {projectName}
                                    {projectCmNumber
                                        ? ` (#${projectCmNumber})`
                                        : ""}
                                </span>
                                <span>›</span>
                                <span>{t("breadcrumbs.assistant")}</span>
                                <span>›</span>
                                <span>{t("breadcrumbs.addWorkflow")}</span>
                            </>
                        ) : (
                            <>
                                <span>{t("breadcrumbs.assistant")}</span>
                                <span>›</span>
                                <span>{t("breadcrumbs.addWorkflow")}</span>
                            </>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex flex-row flex-1 min-h-0 overflow-hidden">
                    {/* Left panel — workflow list */}
                    <div
                        className={`overflow-y-auto ${selected ? "w-80 shrink-0" : "flex-1"}`}
                    >
                        {/* Search — širinu i stil držimo identično ProjectPickeru
                             (SelectAssistantProjectModal) da modali budu vizualno
                             usklađeni. */}
                        <div className="px-4 pt-1 pb-2 shrink-0">
                            <div className="flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2">
                                <Search className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                                <input
                                    type="text"
                                    placeholder={t("searchPlaceholder")}
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                                />
                                {search && (
                                    <button onClick={() => setSearch("")} className="text-muted-foreground/70 hover:text-muted-foreground">
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {loading ? (
                            <div className="space-y-px px-4 pt-1">
                                {[60, 45, 75, 50, 65, 40, 55].map((w, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between gap-3 py-3 border-b border-border"
                                    >
                                        <div
                                            className="h-3 rounded bg-muted animate-pulse"
                                            style={{ width: `${w}%` }}
                                        />
                                        <div className="h-3 w-10 rounded bg-muted animate-pulse shrink-0" />
                                    </div>
                                ))}
                            </div>
                        ) : filteredWorkflows.length === 0 ? (
                            <p className="px-4 py-8 text-sm text-center text-muted-foreground/70">
                                {search
                                    ? t("noMatches")
                                    : t("noAssistantWorkflows")}
                            </p>
                        ) : (
                            filteredWorkflows.map((wf) => (
                                <button
                                    key={wf.id}
                                    type="button"
                                    onClick={() =>
                                        setSelected((prev) =>
                                            prev?.id === wf.id ? null : wf,
                                        )
                                    }
                                    className={`w-full flex items-center gap-3 px-4 py-3 text-xs text-left transition-colors border-b border-border ${
                                        selected?.id === wf.id
                                            ? "bg-secondary"
                                            : "hover:bg-accent"
                                    }`}
                                >
                                    <span className="flex-1 truncate text-foreground">
                                        {resolveTitle(wf)}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground/70">
                                        {wf.is_system
                                            ? t("badgeBuiltin")
                                            : t("badgeCustom")}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>

                    {/* Right panel — prompt preview */}
                    {selected && (
                        <div className={`flex-1 border-l border-border flex flex-col overflow-hidden px-3 pb-3 transition-opacity duration-200 ${rightVisible ? "opacity-100" : "opacity-0"}`}>
                            <div className="flex items-center justify-between py-3 shrink-0">
                                <p className="text-xs font-medium text-foreground">
                                    {t("workflowPrompt")}
                                </p>
                                <button
                                    onClick={() => setSelected(null)}
                                    className="rounded-lg p-1 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3 text-sm border border-border rounded-md text-muted-foreground leading-relaxed font-serif bg-muted">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        h1: ({ children }) => (
                                            <h1 className="text-base font-semibold text-foreground mt-4 mb-1 first:mt-0">
                                                {children}
                                            </h1>
                                        ),
                                        h2: ({ children }) => (
                                            <h2 className="text-sm font-semibold text-foreground mt-3 mb-1 first:mt-0">
                                                {children}
                                            </h2>
                                        ),
                                        h3: ({ children }) => (
                                            <h3 className="text-xs font-semibold text-foreground mt-2 mb-0.5 first:mt-0">
                                                {children}
                                            </h3>
                                        ),
                                        p: ({ children }) => (
                                            <p className="mb-2 last:mb-0">
                                                {children}
                                            </p>
                                        ),
                                        ul: ({ children }) => (
                                            <ul className="list-disc pl-4 mb-2 space-y-0.5">
                                                {children}
                                            </ul>
                                        ),
                                        ol: ({ children }) => (
                                            <ol className="list-decimal pl-4 mb-2 space-y-0.5">
                                                {children}
                                            </ol>
                                        ),
                                        li: ({ children }) => (
                                            <li>{children}</li>
                                        ),
                                        strong: ({ children }) => (
                                            <strong className="font-semibold text-foreground">
                                                {children}
                                            </strong>
                                        ),
                                        em: ({ children }) => (
                                            <em className="italic">
                                                {children}
                                            </em>
                                        ),
                                    }}
                                >
                                    {selected.prompt_md ??
                                        `_${t("noPromptDefined")}_`}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
                    >
                        {t("cancel")}
                    </button>
                    <button
                        type="button"
                        onClick={handleUse}
                        disabled={!selected}
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                        {t("use")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
