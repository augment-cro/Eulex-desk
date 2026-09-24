"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Upload, Search, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    uploadStandaloneDocument,
    uploadProjectDocument,
    addDocumentToProject,
    deleteDocument,
} from "@/app/lib/mikeApi";
import { uploadFilesBulk, type UploadFailure } from "@/app/lib/bulkUpload";
import { SUPPORTED_UPLOAD_ACCEPT } from "@/app/lib/supportedFileTypes";
import type { MikeDocument } from "./types";
import { FileDirectory } from "./FileDirectory";
import { useDirectoryData, invalidateDirectoryCache } from "./useDirectoryData";
import { OwnerOnlyModal } from "./OwnerOnlyModal";
import { ConnectorsButton } from "./ConnectorsButton";
import { UploadFailuresAlert } from "./UploadFailuresAlert";
import { useAuth } from "@/contexts/AuthContext";

export { invalidateDirectoryCache };

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (documents: MikeDocument[], projectId?: string) => void;
    breadcrumb: string[];
    allowMultiple?: boolean;
    projectId?: string;
}

export function AddDocumentsModal({
    open,
    onClose,
    onSelect,
    breadcrumb,
    allowMultiple = true,
    projectId,
}: Props) {
    const { loading, standaloneDocuments, projects } = useDirectoryData(open);
    const { user } = useAuth();
    const t = useTranslations("documents");
    const tc = useTranslations("common");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const [search, setSearch] = useState("");
    const [extraUploadedDocs, setExtraUploadedDocs] = useState<MikeDocument[]>([]);
    // IDs deleted in this session — hidden locally since `useDirectoryData`'s
    // cached state won't re-fetch until the modal reopens.
    const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>(
        [],
    );
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setSearch("");
        setSelectedIds(new Set());
        setExtraUploadedDocs([]);
        setDeletedIds(new Set());
        setUploadFailures([]);
    }, [open]);

    if (!open) return null;

    const q = search.toLowerCase().trim();

    const allStandalone = [
        ...extraUploadedDocs.filter(
            (u) => !standaloneDocuments.some((d) => d.id === u.id),
        ),
        ...standaloneDocuments,
    ].filter((d) => !deletedIds.has(d.id));

    const filteredStandalone = q
        ? allStandalone.filter((d) => d.filename.toLowerCase().includes(q))
        : allStandalone;

    const filteredProjects = projects
        .filter((p) => p.id !== projectId)
        .map((p) => ({
            ...p,
            documents: (p.documents || []).filter(
                (d) =>
                    !deletedIds.has(d.id) &&
                    (!q || d.filename.toLowerCase().includes(q)),
            ),
        }))
        .filter(
            (p) =>
                !q ||
                p.name.toLowerCase().includes(q) ||
                p.documents.length > 0,
        );

    const allDocs = [
        ...allStandalone,
        ...projects.flatMap((p) => p.documents || []),
    ];

    // Docs uploaded through this modal already exist server-side, so closing
    // WITHOUT confirming used to leave them invisible to the parent until a
    // reload ("ghost" documents, issue #101). Surface them on close — the
    // parent dedups by id, so this is safe even after a confirm.
    function handleClose() {
        if (extraUploadedDocs.length > 0) {
            onSelect(extraUploadedDocs, projectId);
        }
        onClose();
    }

    async function handleConfirm() {
        const selected = allDocs.filter((d) => selectedIds.has(d.id));

        if (projectId) {
            const toAssign = selected.filter((d) => d.project_id !== projectId);
            const alreadyHere = selected.filter(
                (d) => d.project_id === projectId,
            );
            if (toAssign.length > 0) {
                setUploading(true);
                try {
                    const assigned = await Promise.all(
                        toAssign.map((d) =>
                            addDocumentToProject(projectId, d.id),
                        ),
                    );
                    onSelect([...alreadyHere, ...assigned], projectId);
                } catch (err) {
                    console.error("Failed to assign documents:", err);
                } finally {
                    setUploading(false);
                }
            } else {
                onSelect(alreadyHere, projectId);
            }
            onClose();
            return;
        }

        const projectIds = new Set(
            selected.map((d) => d.project_id).filter(Boolean),
        );
        const singleProjectId =
            projectIds.size === 1 ? [...projectIds][0]! : undefined;
        onSelect(selected, singleProjectId);
        onClose();
    }

    async function handleDelete(ids: string[]) {
        // Server only allows the doc creator to delete. Filter to owned
        // and warn for the rest.
        const docsById = new Map<string, MikeDocument>();
        for (const d of [
            ...standaloneDocuments,
            ...extraUploadedDocs,
            ...projects.flatMap((p) => p.documents ?? []),
        ]) {
            docsById.set(d.id, d);
        }
        const owned = ids.filter((id) => {
            const d = docsById.get(id);
            return !d || !d.user_id || !user?.id || d.user_id === user.id;
        });
        const blocked = ids.length - owned.length;
        if (owned.length === 0 && blocked > 0) {
            setOwnerOnlyAction(t("ownerOnlyDelete"));
            return;
        }
        const idSet = new Set(owned);
        try {
            await Promise.all(owned.map((id) => deleteDocument(id)));
        } catch (err) {
            console.error("Delete failed:", err);
            return;
        }
        invalidateDirectoryCache();
        setExtraUploadedDocs((prev) => prev.filter((d) => !idSet.has(d.id)));
        setDeletedIds((prev) => {
            const next = new Set(prev);
            owned.forEach((id) => next.add(id));
            return next;
        });
        if (blocked > 0) {
            setOwnerOnlyAction(
                t("ownerOnlyDeletePartial", { count: blocked }),
            );
        }
    }

    async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        setUploading(true);
        setUploadFailures([]);
        try {
            // Each document is listed + pre-selected as soon as it lands,
            // so one failed file never hides the others.
            const { uploaded, failures } = await uploadFilesBulk(files, {
                upload: (f) =>
                    projectId
                        ? uploadProjectDocument(projectId, f)
                        : uploadStandaloneDocument(f),
                surface: projectId ? "project" : "standalone",
                onUploaded: (doc) => {
                    setExtraUploadedDocs((prev) => [doc, ...prev]);
                    setSelectedIds((prev) => new Set([...prev, doc.id]));
                },
            });
            if (uploaded.length > 0) invalidateDirectoryCache();
            setUploadFailures(failures);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    // Cloud-connector imports (Google Drive / Microsoft 365 / Box). The
    // ConnectorsButton already drives the OAuth + picker flow and hands us
    // the resulting MikeDocument; we just need to surface it in the list
    // and pre-select it so the user can confirm in one click.
    function handleConnectorImport(doc: MikeDocument) {
        invalidateDirectoryCache();
        setExtraUploadedDocs((prev) =>
            prev.some((d) => d.id === doc.id) ? prev : [doc, ...prev],
        );
        setSelectedIds((prev) => new Set([...prev, doc.id]));
    }

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-foreground/10 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-2xl bg-background border border-border flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        {breadcrumb.map((segment, i) => (
                            <span key={i} className="flex items-center gap-1.5">
                                {i > 0 && <span>›</span>}
                                {segment}
                            </span>
                        ))}
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Search bar */}
                <div className="px-4 pt-1 pb-2">
                    <div className="flex items-center gap-2 rounded-lg border border-input bg-surface-elevated px-3 py-2">
                        <Search className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                        <input
                            type="text"
                            placeholder={t("searchPlaceholder")}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                            autoFocus
                        />
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="text-muted-foreground/70 hover:text-muted-foreground"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* File browser */}
                <div className="flex-1 overflow-y-auto px-4 pb-2">
                    <FileDirectory
                        standaloneDocs={filteredStandalone}
                        directoryProjects={filteredProjects}
                        loading={loading}
                        selectedIds={selectedIds}
                        onChange={setSelectedIds}
                        allowMultiple={allowMultiple}
                        forceExpanded={!!q}
                        emptyMessage={
                            q ? t("noMatches") : t("noDocuments")
                        }
                        onDelete={handleDelete}
                    />
                </div>

                <UploadFailuresAlert
                    failures={uploadFailures}
                    onDismiss={() => setUploadFailures([])}
                    className="mx-4 mb-2 w-auto"
                />

                {/* Footer */}
                <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={SUPPORTED_UPLOAD_ACCEPT}
                            multiple
                            className="hidden"
                            onChange={handleUpload}
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                        >
                            {uploading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Upload className="h-3.5 w-3.5" />
                            )}
                            {uploading ? t("uploading") : t("upload")}
                        </button>
                        <ConnectorsButton
                            projectId={projectId ?? null}
                            onImport={handleConnectorImport}
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.size > 0 && (
                            <span className="text-xs text-muted-foreground/70">
                                {t("selected", { count: selectedIds.size })}
                            </span>
                        )}
                        <button
                            onClick={handleClose}
                            className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
                        >
                            {tc("cancel")}
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedIds.size === 0 || uploading}
                            className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                        >
                            {uploading ? tc("saving") : t("confirm")}
                        </button>
                    </div>
                </div>
            </div>
            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>,
        document.body,
    );
}
