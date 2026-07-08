"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS, formatLabelT, formatIcon } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import { getPresetConfig, PROMPT_PRESETS } from "./columnPresets";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ColumnDraft {
    name: string;
    prompt: string;
    format: ColumnFormat;
    tags: string[];
    tagInput: string;
}

const EMPTY_DRAFT: ColumnDraft = {
    name: "",
    prompt: "",
    format: "text",
    tags: [],
    tagInput: "",
};

interface Props {
    open: boolean;
    existingCount: number;
    onClose: () => void;
    onAdd: (cols: ColumnConfig[]) => void;
    editingColumn?: ColumnConfig;
    onSave?: (col: ColumnConfig) => void;
    onDelete?: () => void;
}

export function AddColumnModal({ open, existingCount, onClose, onAdd, editingColumn, onSave, onDelete }: Props) {
    const t = useTranslations("addColumn");
    const tFmt = useTranslations("columnFormats");
    const isEditing = !!editingColumn;
    const [columns, setColumns] = useState<ColumnDraft[]>([{ ...EMPTY_DRAFT }]);
    const [generatingIndices, setGeneratingIndices] = useState<number[]>([]);
    const [presetsOpenIndex, setPresetsOpenIndex] = useState<number | null>(
        null,
    );
    const presetsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        if (editingColumn) {
            setColumns([{
                name: editingColumn.name,
                prompt: editingColumn.prompt,
                format: editingColumn.format ?? "text",
                tags: editingColumn.tags ?? [],
                tagInput: "",
            }]);
        } else {
            setColumns([{ ...EMPTY_DRAFT }]);
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (presetsOpenIndex === null) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                presetsRef.current &&
                !presetsRef.current.contains(e.target as Node)
            ) {
                setPresetsOpenIndex(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [presetsOpenIndex]);

    if (!open) return null;

    function resetForm() {
        setColumns([{ ...EMPTY_DRAFT }]);
        setGeneratingIndices([]);
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    function updateColumn(index: number, patch: Partial<ColumnDraft>) {
        setColumns((prev) =>
            prev.map((col, i) => (i === index ? { ...col, ...patch } : col)),
        );
    }

    function addAnotherColumn() {
        setColumns((prev) => [...prev, { ...EMPTY_DRAFT }]);
    }

    function removeColumn(index: number) {
        setColumns((prev) =>
            prev.length === 1
                ? [{ ...EMPTY_DRAFT }]
                : prev.filter((_, i) => i !== index),
        );
    }

    function commitTag(index: number) {
        setColumns((prev) => {
            const col = prev[index]!;
            const tag = col.tagInput.trim();
            if (!tag || col.tags.includes(tag)) {
                return prev.map((c, i) =>
                    i === index ? { ...c, tagInput: "" } : c,
                );
            }
            return prev.map((c, i) =>
                i === index
                    ? { ...c, tags: [...c.tags, tag], tagInput: "" }
                    : c,
            );
        });
    }

    function handleTagKeyDown(
        e: React.KeyboardEvent<HTMLInputElement>,
        index: number,
    ) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag(index);
        } else if (
            e.key === "Backspace" &&
            columns[index]!.tagInput === "" &&
            columns[index]!.tags.length > 0
        ) {
            updateColumn(index, {
                tags: columns[index]!.tags.slice(0, -1),
            });
        }
    }

    async function autoGeneratePrompt(index: number) {
        const title = columns[index]?.name?.trim() ?? "";
        if (!title) return;
        setGeneratingIndices((prev) => [...prev, index]);
        try {
            const col = columns[index]!;
            const { prompt } = await generateTabularColumnPrompt(title, {
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            });
            updateColumn(index, { prompt });
        } finally {
            setGeneratingIndices((prev) => prev.filter((v) => v !== index));
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (columns.some((col) => !col.name.trim() || !col.prompt.trim()))
            return;
        if (isEditing && onSave && editingColumn) {
            const col = columns[0]!;
            onSave({
                index: editingColumn.index,
                name: col.name.trim(),
                prompt: col.prompt.trim(),
                format: col.format,
                tags: col.format === "tag" ? col.tags : undefined,
            });
        } else {
            onAdd(
                columns.map((col, i) => ({
                    index: existingCount + i,
                    name: col.name.trim(),
                    prompt: col.prompt.trim(),
                    format: col.format,
                    tags: col.format === "tag" ? col.tags : undefined,
                })),
            );
        }
        resetForm();
        onClose();
    }

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-primary/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-surface-elevated border border-border flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("tabularReview")}</span>
                        <span>›</span>
                        <span>{isEditing ? t("editColumn") : t("newColumn")}</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="flex flex-col min-h-0 flex-1"
                >
                    {/* Body */}
                    <div className="px-6 pt-3 pb-5 space-y-5 overflow-y-auto flex-1">
                        {columns.map((column, index) => (
                            <div
                                key={index}
                                className="rounded-xl border border-border p-4"
                            >
                                {/* Name row */}
                                <div className="flex items-start gap-2">
                                    {/* Input + preset dropdown anchored to this wrapper */}
                                    <div
                                        className="relative flex flex-1 items-start"
                                        ref={
                                            presetsOpenIndex === index
                                                ? presetsRef
                                                : null
                                        }
                                    >
                                        <input
                                            type="text"
                                            value={column.name}
                                            onChange={(e) => {
                                                const name = e.target.value;
                                                const preset =
                                                    getPresetConfig(name);
                                                updateColumn(index, {
                                                    name,
                                                    ...(preset
                                                        ? {
                                                              prompt: preset.prompt,
                                                              format: preset.format,
                                                              tags:
                                                                  preset.tags ??
                                                                  [],
                                                              tagInput: "",
                                                          }
                                                        : {}),
                                                });
                                            }}
                                            placeholder={t("columnName")}
                                            className="flex-1 text-2xl font-serif text-foreground placeholder-muted-foreground/70 focus:outline-none bg-transparent"
                                            autoFocus={index === 0}
                                        />
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPresetsOpenIndex(
                                                    presetsOpenIndex === index
                                                        ? null
                                                        : index,
                                                )
                                            }
                                            title={t("columnPresets")}
                                            className="mt-1.5 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                        >
                                            <ChevronDown
                                                className={`h-4 w-4 transition-transform ${presetsOpenIndex === index ? "rotate-180" : ""}`}
                                            />
                                        </button>
                                        {presetsOpenIndex === index && (
                                            <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border border-border bg-surface-elevated overflow-y-auto max-h-64">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        updateColumn(index, { ...EMPTY_DRAFT });
                                                        setPresetsOpenIndex(null);
                                                    }}
                                                    className="w-full px-3 py-2 text-left text-sm text-muted-foreground/70 hover:bg-accent transition-colors border-b border-border"
                                                >
                                                    {t("noPreset")}
                                                </button>
                                                {PROMPT_PRESETS.map(
                                                    (preset) => (
                                                        <button
                                                            key={preset.name}
                                                            type="button"
                                                            onClick={() => {
                                                                updateColumn(
                                                                    index,
                                                                    {
                                                                        name: preset.name,
                                                                        prompt: preset.prompt,
                                                                        format: preset.format,
                                                                        tags:
                                                                            preset.tags ??
                                                                            [],
                                                                        tagInput:
                                                                            "",
                                                                    },
                                                                );
                                                                setPresetsOpenIndex(
                                                                    null,
                                                                );
                                                            }}
                                                            className="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-accent transition-colors"
                                                        >
                                                            {preset.name}
                                                        </button>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    {columns.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => removeColumn(index)}
                                            className="mt-1.5 rounded-lg p-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-muted-foreground"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>

                                {/* Format */}
                                <div className="mt-4">
                                    <label className="text-sm font-medium text-muted-foreground">
                                        {t("format")}
                                    </label>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button className="mt-1 flex items-center justify-between rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground hover:border-ring focus:outline-none">
                                                <span className="flex items-center gap-2">
                                                    {(() => {
                                                        const Icon = formatIcon(
                                                            column.format,
                                                        );
                                                        return (
                                                            <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />
                                                        );
                                                    })()}
                                                    {formatLabelT(column.format, tFmt)}
                                                </span>
                                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" />
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent
                                            align="start"
                                            className="z-[200]"
                                        >
                                            <DropdownMenuRadioGroup
                                                value={column.format}
                                                onValueChange={(v) =>
                                                    updateColumn(index, {
                                                        format: v as ColumnFormat,
                                                        tags: [],
                                                        tagInput: "",
                                                    })
                                                }
                                            >
                                                {FORMAT_OPTIONS.map((o) => (
                                                    <DropdownMenuRadioItem
                                                        key={o.value}
                                                        value={o.value}
                                                    >
                                                        <o.icon className="h-3.5 w-3.5 text-muted-foreground/70" />
                                                        {tFmt(o.labelKey)}
                                                    </DropdownMenuRadioItem>
                                                ))}
                                            </DropdownMenuRadioGroup>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>

                                {/* Tag input */}
                                {column.format === "tag" && (
                                    <div className="mt-3">
                                        <label className="text-sm font-medium text-muted-foreground">
                                            {t("tags")}
                                        </label>
                                        <div className="mt-1 flex flex-wrap gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:border-ring">
                                            {column.tags.map((tag, tagIdx) => (
                                                <span
                                                    key={tag}
                                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                                >
                                                    {tag}
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            updateColumn(
                                                                index,
                                                                {
                                                                    tags: column.tags.filter(
                                                                        (t) =>
                                                                            t !==
                                                                            tag,
                                                                    ),
                                                                },
                                                            )
                                                        }
                                                        className="text-muted-foreground/70 hover:text-muted-foreground"
                                                    >
                                                        <X className="h-2.5 w-2.5" />
                                                    </button>
                                                </span>
                                            ))}
                                            <input
                                                type="text"
                                                value={column.tagInput}
                                                onChange={(e) =>
                                                    updateColumn(index, {
                                                        tagInput:
                                                            e.target.value,
                                                    })
                                                }
                                                onKeyDown={(e) =>
                                                    handleTagKeyDown(e, index)
                                                }
                                                onBlur={() => commitTag(index)}
                                                placeholder={t("addTag")}
                                                className="min-w-[80px] flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground/70 focus:outline-none"
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground/70">
                                            {t("pressEnterToAddTag")}
                                        </p>
                                    </div>
                                )}

                                {/* Prompt */}
                                <div className="mt-4 flex items-center justify-between">
                                    <label className="text-sm font-medium text-muted-foreground">
                                        {t("prompt")}
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            autoGeneratePrompt(index)
                                        }
                                        disabled={
                                            !column.name.trim() ||
                                            generatingIndices.includes(index)
                                        }
                                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:text-muted-foreground/70"
                                    >
                                        {generatingIndices.includes(index) ? (
                                            <span className="h-4 w-4 rounded-full border-2 border-border border-t-muted-foreground animate-spin block" />
                                        ) : (
                                            <Plus className="h-4 w-4" />
                                        )}
                                        {t("autoGeneratePrompt")}
                                    </button>
                                </div>
                                <textarea
                                    rows={6}
                                    value={column.prompt}
                                    onChange={(e) =>
                                        updateColumn(index, {
                                            prompt: e.target.value,
                                        })
                                    }
                                    placeholder={t("promptPlaceholder")}
                                    className="mt-2 w-full rounded-md border border-input px-3 py-2 text-sm text-foreground placeholder-muted-foreground/70 focus:border-ring focus:outline-none bg-transparent resize-none leading-relaxed"
                                />
                            </div>
                        ))}

                        {!isEditing && (
                            <button
                                type="button"
                                onClick={addAnotherColumn}
                                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <Plus className="h-4 w-4" />
                                {t("addAnotherColumn")}
                            </button>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-border px-6 py-4">
                        <div>
                            {isEditing && onDelete && (
                                <button
                                    type="button"
                                    onClick={onDelete}
                                    className="rounded-lg px-4 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                                >
                                    {t("delete")}
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors"
                            >
                                {t("cancel")}
                            </button>
                            <button
                                type="submit"
                                disabled={columns.some(
                                    (col) => !col.name.trim() || !col.prompt.trim(),
                                )}
                                className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                            >
                                {isEditing ? t("saveChanges") : t("addColumns")}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>,
        document.body,
    );
}
