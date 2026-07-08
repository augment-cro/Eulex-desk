"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ColumnConfig, ColumnFormat } from "../shared/types";
import { generateTabularColumnPrompt } from "@/app/lib/mikeApi";
import { FORMAT_OPTIONS, formatLabelT, formatIcon } from "./columnFormat";
import { TAG_COLORS } from "./pillUtils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirmDialog } from "@/app/components/modals/confirm-dialog";

export interface TREditColumnMenuProps {
    column: ColumnConfig;
    disabled?: boolean;
    onSave: (column: ColumnConfig) => void | Promise<void>;
    onDelete: (columnIndex: number) => void | Promise<void>;
}

export function TREditColumnMenu({
    column,
    disabled,
    onSave,
    onDelete,
}: TREditColumnMenuProps) {
    const t = useTranslations("addColumn");
    const tFmt = useTranslations("columnFormats");
    const { confirm, dialog: confirmDialogEl } = useConfirmDialog();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState(column.name);
    const [prompt, setPrompt] = useState(column.prompt);
    const [format, setFormat] = useState<ColumnFormat>(column.format ?? "text");
    const [tags, setTags] = useState<string[]>(column.tags ?? []);
    const [tagInput, setTagInput] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [generating, setGenerating] = useState(false);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState<{
        top: number;
        right: number;
    } | null>(null);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        if (!open) {
            setName(column.name);
            setPrompt(column.prompt);
            setFormat(column.format ?? "text");
            setTags(column.tags ?? []);
            setTagInput("");
        }
    }, [column.name, column.prompt, column.format, column.tags, open]);

    // Compute popover position relative to the kebab button. Using
    // position: fixed + a portal sidesteps any ancestor stacking
    // context (sticky table headers, transformed sidebars, etc.)
    // that would otherwise clip the menu or push it under chrome.
    useLayoutEffect(() => {
        if (!open) {
            setPos(null);
            return;
        }
        const updatePos = () => {
            const btn = buttonRef.current;
            if (!btn) return;
            const rect = btn.getBoundingClientRect();
            setPos({
                top: rect.bottom + 6,
                right: Math.max(8, window.innerWidth - rect.right),
            });
        };
        updatePos();
        window.addEventListener("resize", updatePos);
        window.addEventListener("scroll", updatePos, true);
        return () => {
            window.removeEventListener("resize", updatePos);
            window.removeEventListener("scroll", updatePos, true);
        };
    }, [open]);

    // Close on outside click / Escape — required because the popover
    // now lives in a portal so the parent's stopPropagation no longer
    // covers it implicitly.
    //
    // NOTE: the Format <DropdownMenu> inside us is Radix, and Radix
    // renders its menu content into ITS OWN portal (also attached to
    // document.body). A click on a Format option therefore lands
    // outside both `buttonRef` and `popoverRef` — and a naive
    // outside-click listener would close the whole edit popover
    // before the radio-group has a chance to flush the new value.
    // To preserve nested portals we treat anything inside a Radix
    // popper container as "inside" too. The selectors below cover
    // all current Radix primitives we use here (DropdownMenu,
    // Popover, Tooltip) — Radix tags every floating element with
    // `data-radix-popper-content-wrapper`, and the menu content
    // also carries `data-radix-menu-content`. Either match means
    // the click belongs to a child UI we opened on purpose.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (!target) return;
            if (buttonRef.current?.contains(target)) return;
            if (popoverRef.current?.contains(target)) return;
            // Clicks inside any Radix popper (our Format dropdown,
            // or a tooltip we might add later) must not close us.
            if (
                target.closest?.(
                    "[data-radix-popper-content-wrapper], [data-radix-menu-content], [data-radix-select-content]",
                )
            ) {
                return;
            }
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    function commitTag() {
        const tag = tagInput.trim();
        if (!tag) {
            setTagInput("");
            return;
        }
        setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
        setTagInput("");
    }

    function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commitTag();
        } else if (
            e.key === "Backspace" &&
            tagInput === "" &&
            tags.length > 0
        ) {
            setTags((prev) => prev.slice(0, -1));
        }
    }

    async function handleSave() {
        setSaving(true);
        try {
            await onSave({
                ...column,
                name: name.trim(),
                prompt: prompt.trim(),
                format,
                tags: format === "tag" ? tags : undefined,
            });
            setOpen(false);
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete() {
        const ok = await confirm({
            title: t("deleteConfirmTitle"),
            message: t("deleteConfirmBody", { name: column.name }),
            confirmLabel: t("delete"),
            destructive: true,
        });
        if (!ok) return;
        setDeleting(true);
        try {
            await onDelete(column.index);
            setOpen(false);
        } finally {
            setDeleting(false);
        }
    }

    async function handleAutoGenerate() {
        if (!name.trim()) return;
        setGenerating(true);
        try {
            const { prompt } = await generateTabularColumnPrompt(name.trim(), {
                format,
                tags: format === "tag" ? tags : undefined,
            });
            setPrompt(prompt);
        } finally {
            setGenerating(false);
        }
    }

    const popover = open && pos && mounted
        ? createPortal(
              <div
                  ref={popoverRef}
                  style={{
                      position: "fixed",
                      top: pos.top,
                      right: pos.right,
                      zIndex: 9999,
                  }}
                  className="w-72 rounded-xl border border-border bg-surface-elevated p-3"
                  onClick={(e) => e.stopPropagation()}
              >
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-sm font-medium text-foreground">
                            {t("editColumn")}
                        </p>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            className="rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <label className="text-xs font-medium text-foreground">
                        {t("columnName")}
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="mt-1 w-full rounded-md border border-input px-2 py-1 text-foreground text-xs font-normal focus:border-ring focus:outline-none"
                    />

                    {/* Format */}
                    <div className="mt-3">
                        <label className="text-xs font-medium text-foreground">
                            {t("format")}
                        </label>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button className="mt-1 flex w-full items-center justify-between rounded-md border border-input bg-surface-elevated px-2 py-1 text-xs text-foreground hover:border-ring focus:outline-none">
                                    <span className="flex items-center gap-1.5">
                                        {(() => {
                                            const Icon = formatIcon(format);
                                            return (
                                                <Icon className="h-3 w-3 text-muted-foreground/70" />
                                            );
                                        })()}
                                        {formatLabelT(format, tFmt)}
                                    </span>
                                    <ChevronDown className="h-3 w-3 text-muted-foreground/70" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="start"
                                style={{
                                    width: "var(--radix-dropdown-menu-trigger-width)",
                                    zIndex: 10000,
                                }}
                            >
                                <DropdownMenuRadioGroup
                                    value={format}
                                    onValueChange={(v) => {
                                        setFormat(v as ColumnFormat);
                                        setTags([]);
                                        setTagInput("");
                                    }}
                                >
                                    {FORMAT_OPTIONS.map((o) => (
                                        <DropdownMenuRadioItem
                                            key={o.value}
                                            value={o.value}
                                            className="text-xs"
                                        >
                                            <o.icon className="h-3 w-3 text-muted-foreground/70" />
                                            {tFmt(o.labelKey)}
                                        </DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>

                    {/* Tag input */}
                    {format === "tag" && (
                        <div className="mt-2">
                            <div className="flex flex-wrap gap-1 rounded-md border border-input px-2 py-1 focus-within:border-ring min-h-[28px]">
                                {tags.map((tag, tagIdx) => (
                                    <span
                                        key={tag}
                                        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                    >
                                        {tag}
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setTags((prev) =>
                                                    prev.filter(
                                                        (t) => t !== tag,
                                                    ),
                                                )
                                            }
                                            className="text-muted-foreground/70 hover:text-muted-foreground"
                                        >
                                            <X className="h-2 w-2" />
                                        </button>
                                    </span>
                                ))}
                                <input
                                    type="text"
                                    value={tagInput}
                                    onChange={(e) =>
                                        setTagInput(e.target.value)
                                    }
                                    onKeyDown={handleTagKeyDown}
                                    onBlur={commitTag}
                                    placeholder={
                                        tags.length === 0 ? t("addTag") : ""
                                    }
                                    className="min-w-[60px] flex-1 bg-transparent text-xs text-foreground placeholder-muted-foreground/70 focus:outline-none"
                                />
                            </div>
                        </div>
                    )}

                    {/* Prompt */}
                    <div className="mt-3">
                        <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-foreground">
                                {t("prompt")}
                            </label>
                            <button
                                type="button"
                                onClick={handleAutoGenerate}
                                disabled={!name.trim() || generating}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:text-muted-foreground/70"
                            >
                                {generating ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                    <Plus className="h-3 w-3" />
                                )}
                                {t("autoGeneratePrompt")}
                            </button>
                        </div>
                        <textarea
                            rows={6}
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            className="mt-2 w-full rounded-lg border border-input bg-surface-elevated px-3 py-2 text-xs font-normal text-foreground placeholder-muted-foreground/70 focus:border-ring focus:outline-none resize-none leading-relaxed"
                        />
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={handleDelete}
                            disabled={deleting || saving}
                            className="inline-flex items-center gap-1.5 text-xs text-destructive transition-colors hover:text-destructive disabled:text-destructive/70"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t("delete")}
                        </button>
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={
                                saving ||
                                deleting ||
                                generating ||
                                !name.trim() ||
                                !prompt.trim()
                            }
                            className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                        >
                            {saving ? t("saving") : t("saveChanges")}
                        </button>
                    </div>
              </div>,
              document.body,
          )
        : null;

    return (
        <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
                ref={buttonRef}
                onClick={(e) => {
                    e.stopPropagation();
                    if (disabled) return;
                    setOpen((v) => !v);
                }}
                disabled={disabled}
                className={`flex h-4 w-4 items-center justify-center rounded transition-colors ${
                    disabled
                        ? "text-muted-foreground/70 cursor-default"
                        : "text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                }`}
            >
                <MoreHorizontal className="h-4 w-4" />
            </button>
            {popover}
            {confirmDialogEl}
        </div>
    );
}
