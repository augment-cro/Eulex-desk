"use client";

import { createPortal } from "react-dom";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "next-intl";
import type { ColumnConfig } from "../shared/types";
import { formatIcon, formatLabelT } from "../tabular/columnFormat";

interface Props {
    col: ColumnConfig;
    onClose: () => void;
}

export function WFColumnViewModal({ col, onClose }: Props) {
    const tW = useTranslations("workflowsPage");
    const tA = useTranslations("addColumn");
    const tC = useTranslations("common");
    const tFmt = useTranslations("columnFormats");
    const FormatIcon = formatIcon(col.format ?? "text");

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-primary/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-background border border-border flex flex-col h-[600px]">
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{tW("title")}</span>
                        <span>›</span>
                        <span className="truncate max-w-[200px] text-muted-foreground">
                            {col.name}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="px-6 pt-3 pb-5 flex flex-col gap-4 overflow-y-auto flex-1">
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                            {tA("columnName")}
                        </p>
                        <p className="text-sm text-foreground">{col.name}</p>
                    </div>
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                            {tA("format")}
                        </p>
                        <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
                            <FormatIcon className="h-3.5 w-3.5 text-muted-foreground/70" />
                            {formatLabelT(col.format ?? "text", tFmt)}
                        </span>
                    </div>
                    {col.tags && col.tags.length > 0 && (
                        <div>
                            <p className="text-sm font-medium text-muted-foreground mb-2.5">
                                {tA("tags")}
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {col.tags.map((tag) => (
                                    <span
                                        key={tag}
                                        className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                                    >
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    <div>
                        <p className="text-sm font-medium text-muted-foreground mb-2">
                            {tA("prompt")}
                        </p>
                        <div className="text-base text-foreground leading-relaxed font-serif prose prose-base max-w-none">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {col.prompt || "_No prompt defined._"}
                            </ReactMarkdown>
                        </div>
                    </div>
                </div>
                <div className="border-t border-border px-6 py-4 flex justify-end shrink-0">
                    <button
                        onClick={onClose}
                        className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        {tC("close")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
