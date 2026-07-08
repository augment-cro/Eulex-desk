"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Plus,
    Library,
    Table2,
    MessageSquare,
    User,
    ChevronDown,
    Check,
    Download,
} from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";
import {
    listWorkflows,
    deleteWorkflow,
    listHiddenWorkflows,
    hideWorkflow,
    unhideWorkflow,
} from "@/app/lib/mikeApi";
import type { MikeWorkflow } from "../shared/types";
import {
    useBuiltinWorkflows,
    isBuiltinWorkflowId,
    getLocalizedPractice,
    getLocalizedWorkflowTitle,
} from "./builtinWorkflows";
import { DisplayWorkflowModal } from "./DisplayWorkflowModal";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { UploadWorkflowButton } from "./UploadWorkflowButton";
import { downloadWorkflow } from "@/app/lib/workflowFile";
import { ToolbarTabs } from "../shared/ToolbarTabs";
import { RowActions } from "../shared/RowActions";
import { MikeIcon } from "@/components/chat/mike-icon";
import { useAuth } from "@/contexts/AuthContext";
import { useTranslations } from "next-intl";

type Tab = "all" | "builtin" | "custom" | "hidden";

const CHECK_W = "w-8 shrink-0";
const NAME_COL_W = "w-[300px] shrink-0";

export function WorkflowList() {
    const t = useTranslations("workflowsPage");
    const tCommon = useTranslations("common");
    const tRowActions = useTranslations("rowActions");
    const tBuiltinTitles = useTranslations("builtinWorkflows");
    const tBuiltinPractices = useTranslations("builtinPractices");
    
    const tabs: { id: Tab; label: string }[] = [
        { id: "all", label: t("tabs.all") },
        { id: "builtin", label: t("tabs.builtin") },
        { id: "custom", label: t("tabs.custom") },
        { id: "hidden", label: t("tabs.hidden") },
    ];
    const router = useRouter();
    const { user } = useAuth();
    const builtIns = useBuiltinWorkflows();
    const [custom, setCustom] = useState<MikeWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<MikeWorkflow | null>(null);
    const [activeTab, setActiveTab] = useState<Tab>("all");
    const [newModalOpen, setNewModalOpen] = useState(false);
    const [hiddenBuiltinIds, setHiddenBuiltinIds] = useState<string[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [practiceFilterOpen, setPracticeFilterOpen] = useState(false);
    const [typeFilter, setTypeFilter] = useState<MikeWorkflow["type"] | null>(
        null,
    );
    const [typeFilterOpen, setTypeFilterOpen] = useState(false);
    const [search, setSearch] = useState("");
    const actionsRef = useRef<HTMLDivElement>(null);
    const practiceFilterRef = useRef<HTMLDivElement>(null);
    const typeFilterRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        Promise.all([
            listWorkflows("assistant"),
            listWorkflows("tabular"),
            listHiddenWorkflows(),
        ])
            .then(([assistant, tabular, hidden]) => {
                setCustom([...assistant, ...tabular]);
                setHiddenBuiltinIds(hidden);
            })
            .catch(() => setCustom([]))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        setSelectedIds([]);
        setActionsOpen(false);
    }, [activeTab, practiceFilter, typeFilter]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            ) {
                setActionsOpen(false);
            }
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                practiceFilterRef.current &&
                !practiceFilterRef.current.contains(e.target as Node)
            ) {
                setPracticeFilterOpen(false);
            }
            if (
                typeFilterRef.current &&
                !typeFilterRef.current.contains(e.target as Node)
            ) {
                setTypeFilterOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, []);

    const hiddenBuiltins = builtIns.filter((wf) =>
        hiddenBuiltinIds.includes(wf.id),
    );
    const visibleBuiltins = builtIns.filter(
        (wf) => !hiddenBuiltinIds.includes(wf.id),
    );
    const all = [...visibleBuiltins, ...custom];
    const byTab =
        activeTab === "builtin"
            ? visibleBuiltins
            : activeTab === "custom"
              ? custom
              : activeTab === "hidden"
                ? hiddenBuiltins
                : all;
    const practices = Array.from(
        new Set(byTab.map((wf) => wf.practice).filter((p): p is string => !!p)),
    ).sort();
    const q = search.toLowerCase();
    const filtered = byTab
        .filter((wf) => !practiceFilter || wf.practice === practiceFilter)
        .filter((wf) => !typeFilter || wf.type === typeFilter)
        .filter(
            (wf) =>
                !q ||
                getLocalizedWorkflowTitle(wf, tBuiltinTitles)
                    .toLowerCase()
                    .includes(q),
        );

    const allSelected =
        filtered.length > 0 &&
        filtered.every((wf) => selectedIds.includes(wf.id));
    const someSelected =
        !allSelected && filtered.some((wf) => selectedIds.includes(wf.id));

    function toggleAll() {
        if (allSelected) setSelectedIds([]);
        else setSelectedIds(filtered.map((wf) => wf.id));
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    async function handleHideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => [...prev, id]);
        await hideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        });
    }

    async function handleUnhideWorkflow(id: string) {
        setHiddenBuiltinIds((prev) => prev.filter((x) => x !== id));
        await unhideWorkflow(id).catch(() => {
            setHiddenBuiltinIds((prev) => [...prev, id]);
        });
    }

    async function handleBulkRemove() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        const builtinIds = ids.filter((id) => isBuiltinWorkflowId(id));
        const customIds = ids.filter((id) => !isBuiltinWorkflowId(id));
        if (builtinIds.length > 0) {
            setHiddenBuiltinIds((prev) => [
                ...prev,
                ...builtinIds.filter((id) => !prev.includes(id)),
            ]);
            await Promise.all(
                builtinIds.map((id) => hideWorkflow(id).catch(() => {})),
            );
        }
        if (customIds.length > 0) {
            await Promise.all(
                customIds.map((id) => deleteWorkflow(id).catch(() => {})),
            );
            setCustom((prev) => prev.filter((w) => !customIds.includes(w.id)));
        }
    }

    async function handleBulkUnhide() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setSelectedIds([]);
        setHiddenBuiltinIds((prev) => prev.filter((id) => !ids.includes(id)));
        await Promise.all(ids.map((id) => unhideWorkflow(id).catch(() => {})));
    }

    const getTypeMeta = (type: MikeWorkflow["type"]) =>
        type === "tabular"
            ? { label: t("typeTabular"), Icon: Table2, className: "text-foreground" }
            : {
                  label: t("typeAssistant"),
                  Icon: MessageSquare,
                  className: "text-foreground",
              };

    const typeFilterButton = (
        <div className="relative" ref={typeFilterRef}>
            <button
                onClick={() => setTypeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    typeFilter
                        ? "text-foreground hover:text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                }`}
            >
                {typeFilter
                    ? typeFilter === "tabular"
                        ? t("typeTabular")
                        : t("typeAssistant")
                    : t("filterByType")}
                <ChevronDown className="h-3 w-3" />
            </button>
            {typeFilterOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-40 rounded-xl border border-border bg-surface-elevated overflow-hidden">
                    <button
                        onClick={() => {
                            setTypeFilter(null);
                            setTypeFilterOpen(false);
                        }}
                        className="flex items-center justify-between w-full px-3 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                    >
                        {t("allTypes")}
                        {!typeFilter && (
                            <Check className="h-3.5 w-3.5 text-muted-foreground/70" />
                        )}
                    </button>
                    <div className="border-t border-border" />
                    {(["assistant", "tabular"] as const).map((t) => {
                        const { label, Icon, className } = getTypeMeta(t);
                        return (
                            <button
                                key={t}
                                onClick={() => {
                                    setTypeFilter(t);
                                    setTypeFilterOpen(false);
                                }}
                                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent transition-colors"
                            >
                                <span
                                    className={`inline-flex items-center gap-1.5 font-medium ${className}`}
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {label}
                                </span>
                                {typeFilter === t && (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const practiceFilterButton = (
        <div className="relative" ref={practiceFilterRef}>
            <button
                onClick={() => setPracticeFilterOpen((o) => !o)}
                className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                    practiceFilter
                        ? "text-foreground hover:text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                }`}
            >
                {practiceFilter
                    ? getLocalizedPractice(practiceFilter, tBuiltinPractices)
                    : t("filterByPractice")}
                <ChevronDown className="h-3 w-3" />
            </button>
            {practiceFilterOpen && (
                <div className="absolute right-0 top-full mt-1.5 z-20 w-52 rounded-xl border border-border bg-surface-elevated overflow-hidden">
                    <button
                        onClick={() => {
                            setPracticeFilter(null);
                            setPracticeFilterOpen(false);
                        }}
                        className="flex items-center justify-between w-full px-3 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                    >
                        {t("allPractices")}
                        {!practiceFilter && (
                            <Check className="h-3.5 w-3.5 text-muted-foreground/70" />
                        )}
                    </button>
                    {practices.length > 0 && (
                        <div className="border-t border-border" />
                    )}
                    {practices.map((p) => (
                        <button
                            key={p}
                            onClick={() => {
                                setPracticeFilter(p);
                                setPracticeFilterOpen(false);
                            }}
                            className="flex items-center justify-between w-full px-3 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                        >
                            <span className="truncate pr-2">
                                {getLocalizedPractice(p, tBuiltinPractices)}
                            </span>
                            {practiceFilter === p && (
                                <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const toolbarActions = (
        <div className="flex items-center gap-2">
            {selectedIds.length > 0 && (
                <div ref={actionsRef} className="relative">
                    <button
                        onClick={() => setActionsOpen((v) => !v)}
                        className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-foreground transition-colors"
                    >
                        {tCommon("actions")}
                        <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {actionsOpen && (
                        <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-border bg-surface-elevated z-50 overflow-hidden">
                            {activeTab === "hidden" ? (
                                <button
                                    onClick={handleBulkUnhide}
                                    className="w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent transition-colors"
                                >
                                    {tRowActions("unhide")}
                                </button>
                            ) : (
                                <button
                                    onClick={handleBulkRemove}
                                    className="w-full px-3 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                    {tCommon("delete")}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
            {typeFilterButton}
            {practiceFilterButton}
        </div>
    );

    return (
        <div className="flex flex-col h-full flex-1 overflow-hidden bg-background">
            {/* Page header */}
            <div className="flex items-center justify-between px-8 py-4 shrink-0">
                <h1 className="text-2xl font-medium font-serif text-foreground">
                    {t("title")}
                </h1>
                <div className="flex items-center gap-2">
                    <HeaderSearchBtn
                        value={search}
                        onChange={setSearch}
                        placeholder={t("searchPlaceholder")}
                    />
                    <UploadWorkflowButton
                        onUploaded={(wf) => {
                            setCustom((prev) => [wf, ...prev]);
                        }}
                    />
                    <button
                        onClick={() => setNewModalOpen(true)}
                        className="flex items-center justify-center p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
            </div>

            <ToolbarTabs
                tabs={tabs}
                active={activeTab}
                onChange={setActiveTab}
                actions={toolbarActions}
            />

            {/* Table */}
            <div className="flex-1 overflow-auto">
                <div className="min-w-max">
                    {/* Column headers */}
                    <div className="flex items-center h-8 pr-8 border-b border-border text-xs text-muted-foreground font-medium select-none">
                        <div className={`sticky left-0 z-[60] ${CHECK_W} relative bg-background flex items-center justify-center self-stretch before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-background`}>
                            {!loading && (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className="h-2.5 w-2.5 rounded border-input cursor-pointer accent-primary"
                                />
                            )}
                        </div>
                        <div className={`sticky left-8 z-[60] ${NAME_COL_W} bg-background pl-2 text-left`}>
                            {t("columns.name")}
                        </div>
                        <div className="ml-auto w-28 shrink-0">{t("columns.type")}</div>
                        <div className="w-40 shrink-0">{t("columns.practice")}</div>
                        <div className="w-28 shrink-0">{t("columns.source")}</div>
                        <div className="w-16 shrink-0" />
                    </div>

                    {loading && activeTab !== "builtin" ? (
                        <div>
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="flex items-center h-10 pr-8 border-b border-border"
                                >
                                    <div className="w-8 shrink-0" />
                                    <div className="flex-1 min-w-0 pl-3 pr-4">
                                        <div className="h-3.5 w-48 rounded bg-muted animate-pulse" />
                                    </div>
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                                    </div>
                                    <div className="w-40 shrink-0">
                                        <div className="h-3 w-24 rounded bg-muted animate-pulse" />
                                    </div>
                                    <div className="w-28 shrink-0">
                                        <div className="h-3 w-14 rounded bg-muted animate-pulse" />
                                    </div>
                                    <div className="w-16 shrink-0" />
                                </div>
                            ))}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-start py-24 w-full max-w-xs mx-auto">
                            {activeTab === "custom" ? (
                                <>
                                    <Library className="h-8 w-8 text-muted-foreground/70 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-foreground">
                                        {t("empty.customTitle")}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground/70 text-left">
                                        {t("empty.customDesc")}
                                    </p>
                                    <button
                                        onClick={() => setNewModalOpen(true)}
                                        className="mt-4 inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                                    >
                                        {t("empty.createNew")}
                                    </button>
                                </>
                            ) : activeTab === "hidden" ? (
                                <>
                                    <Library className="h-8 w-8 text-muted-foreground/70 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-foreground">
                                        {t("empty.hiddenTitle")}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground/70 text-left">
                                        {t("empty.hiddenDesc")}
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Library className="h-8 w-8 text-muted-foreground/70 mb-4" />
                                    <p className="text-2xl font-medium font-serif text-foreground">
                                        {t("empty.allTitle")}
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground/70 text-left">
                                        {t("empty.allDesc")}
                                    </p>
                                </>
                            )}
                        </div>
                    ) : (
                        filtered.map((wf) => {
                            const rowBg = selectedIds.includes(wf.id)
                                ? "bg-secondary"
                                : "bg-background";
                            return (
                            <div
                                key={wf.id}
                                onClick={() => setSelected(wf)}
                                className="group flex items-center h-10 pr-8 border-b border-border hover:bg-accent cursor-pointer transition-colors"
                            >
                                <div
                                    className={`sticky left-0 z-[60] ${CHECK_W} p-2 flex items-center justify-center ${rowBg} group-hover:bg-accent`}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selectedIds.includes(wf.id)}
                                        onChange={() => toggleOne(wf.id)}
                                        className="h-2.5 w-2.5 rounded border-input cursor-pointer accent-primary"
                                    />
                                </div>
                                <div className={`sticky left-8 z-[60] ${NAME_COL_W} p-2 ${rowBg} group-hover:bg-accent`}>
                                    <span className="text-sm text-foreground truncate block">
                                        {getLocalizedWorkflowTitle(wf, tBuiltinTitles)}
                                    </span>
                                </div>
                                <div className="ml-auto w-28 shrink-0">
                                    {(() => {
                                        const { label, Icon, className } =
                                            getTypeMeta(wf.type);
                                        return (
                                            <span
                                                className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}
                                            >
                                                <Icon className="h-3.5 w-3.5" />
                                                {label}
                                            </span>
                                        );
                                    })()}
                                </div>
                                <div className="w-40 shrink-0">
                                    {wf.practice ? (
                                        <span className="text-xs font-medium text-muted-foreground">
                                            {getLocalizedPractice(wf.practice, tBuiltinPractices)}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-muted-foreground/70">
                                            —
                                        </span>
                                    )}
                                </div>
                                <div className="w-28 shrink-0">
                                    {wf.is_system ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                            <MikeIcon size={14} />
                                            {t("source.mike")}
                                        </span>
                                    ) : wf.user_id === user?.id ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                                            {t("source.myself")}
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground truncate max-w-full">
                                            <User className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                                            <span className="truncate">
                                                {wf.shared_by_name ? t("source.sharedBy", { name: wf.shared_by_name }) : t("source.shared")}
                                            </span>
                                        </span>
                                    )}
                                </div>
                                <div
                                    className="w-16 shrink-0 flex items-center justify-end gap-1"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {activeTab !== "hidden" && (
                                        <button
                                            onClick={() => downloadWorkflow(wf)}
                                            aria-label={t("downloadAria")}
                                            title={t("downloadAria")}
                                            className="flex items-center justify-center p-1 text-muted-foreground/70 hover:text-foreground transition-colors"
                                        >
                                            <Download className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                    {wf.is_system ? (
                                        activeTab === "hidden" ? (
                                            <RowActions
                                                onUnhide={() =>
                                                    handleUnhideWorkflow(wf.id)
                                                }
                                            />
                                        ) : (
                                            <RowActions
                                                onHide={() =>
                                                    handleHideWorkflow(wf.id)
                                                }
                                            />
                                        )
                                    ) : wf.is_owner === false ? null : (
                                        <RowActions
                                            onDelete={async () => {
                                                await deleteWorkflow(wf.id);
                                                setCustom((prev) =>
                                                    prev.filter(
                                                        (w) => w.id !== wf.id,
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                            );
                        })
                    )}
                </div>
            </div>

            <DisplayWorkflowModal
                workflows={all}
                workflow={selected}
                onClose={() => setSelected(null)}
            />

            <NewWorkflowModal
                open={newModalOpen}
                onClose={() => setNewModalOpen(false)}
                onCreated={(wf) => {
                    setCustom((prev) => [wf, ...prev]);
                    setNewModalOpen(false);
                    router.push(`/workflows/${wf.id}`);
                }}
            />
        </div>
    );
}
