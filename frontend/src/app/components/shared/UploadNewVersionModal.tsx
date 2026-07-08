"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { listDocumentVersions } from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";

interface Props {
    open: boolean;
    onClose: () => void;
    doc: MikeDocument | null;
    onSubmit: (file: File, displayName: string) => Promise<void>;
}

export function UploadNewVersionModal({ open, onClose, doc, onSubmit }: Props) {
    const [name, setName] = useState("");
    const [stagedFile, setStagedFile] = useState<File | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [currentVersion, setCurrentVersion] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const t = useTranslations("uploadVersion");
    const tc = useTranslations("common");

    useEffect(() => {
        if (!open || !doc) return;
        setName(doc.filename);
        setStagedFile(null);
        setSubmitting(false);
        setCurrentVersion(null);
        let cancelled = false;
        (async () => {
            try {
                const { current_version_id, versions } =
                    await listDocumentVersions(doc.id);
                const current = versions.find(
                    (v) => v.id === current_version_id,
                );
                const initial =
                    (current?.display_name && current.display_name.trim()) ||
                    doc.filename;
                if (!cancelled) {
                    setName(initial);
                    setCurrentVersion(current?.version_number ?? null);
                }
            } catch {
                /* keep fallback */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, doc]);

    if (!open || !doc) return null;

    const accept = doc.file_type === "pdf" ? ".pdf" : ".docx,.doc";

    function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0] ?? null;
        setStagedFile(file);
        if (fileInputRef.current) fileInputRef.current.value = "";
    }

    async function handleSubmit() {
        if (!stagedFile || submitting || !doc) return;
        const finalName = name.trim() || doc.filename;
        setSubmitting(true);
        try {
            await onSubmit(stagedFile, finalName);
            onClose();
        } finally {
            setSubmitting(false);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-primary/10 backdrop-blur-xs">
            <div className="w-full max-w-md rounded-2xl bg-background border border-border flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="text-xs text-muted-foreground/70">
                        {t("title")} · {doc.filename}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Name input */}
                <div className="px-5 pb-4">
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                        {t("newVersionName")}
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t("versionNamePlaceholder")}
                        className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-ring"
                    />
                    <div className="mt-2 text-xs text-muted-foreground">
                        {t("currentVersion")}{" "}
                        <span className="text-foreground font-medium">
                            {currentVersion ?? "—"}
                        </span>
                    </div>
                    {stagedFile && (
                        <div className="mt-2 text-xs text-muted-foreground truncate">
                            {t("newVersionFile")}{" "}
                            <span className="text-foreground">
                                {stagedFile.name}
                            </span>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={accept}
                            className="hidden"
                            onChange={handleFilePick}
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={submitting}
                            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                        >
                            <Upload className="h-3.5 w-3.5" />
                            {stagedFile ? t("changeFile") : t("upload")}
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                        >
                            {tc("cancel")}
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={!stagedFile || submitting}
                            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                        >
                            {submitting ? tc("saving") : tc("save")}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
}
