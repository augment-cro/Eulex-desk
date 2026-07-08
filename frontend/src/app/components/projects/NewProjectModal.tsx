"use client";

import { useRef, useState } from "react";
import { X, Users, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    addDocumentToProject,
    createProject,
    uploadProjectDocument,
} from "@/app/lib/mikeApi";
import { track, fileTypeOf } from "@/app/lib/analytics";
import { useDirectoryData } from "../shared/useDirectoryData";
import { FileDirectory } from "../shared/FileDirectory";
import { EmailPillInput } from "../shared/EmailPillInput";
import { ConnectorsButton } from "../shared/ConnectorsButton";
import type { MikeDocument, MikeProject } from "../shared/types";

interface Props {
    open: boolean;
    onClose: () => void;
    onCreated: (project: MikeProject) => void;
}

export function NewProjectModal({ open, onClose, onCreated }: Props) {
    const t = useTranslations("newProject");
    const [name, setName] = useState("");
    const [cmNumber, setCmNumber] = useState("");
    const [sharedEmails, setSharedEmails] = useState<string[]>([]);
    const [showMembers, setShowMembers] = useState(false);
    const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    // Docs imported from connectors (Google Drive / Microsoft 365 / Box).
    // These are already standalone MikeDocuments — on submit we just
    // call addDocumentToProject(newProject.id, doc.id) the same way
    // as for the user-pre-selected ones.
    const [importedConnectorDocs, setImportedConnectorDocs] = useState<
        MikeDocument[]
    >([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { loading: dirLoading, standaloneDocuments, projects: dirProjects } =
        useDirectoryData(open);

    if (!open) return null;

    function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (!files.length) return;
        setPendingFiles((prev) => [
            ...prev,
            ...files.filter((f) => !prev.some((p) => p.name === f.name)),
        ]);
    }

    function handleConnectorImport(doc: MikeDocument) {
        // De-dup against both the connector list and any directory
        // selections (the new doc *is* a standalone doc, so the user
        // might also see it appear in the directory after re-fetch).
        setImportedConnectorDocs((prev) =>
            prev.some((d) => d.id === doc.id) ? prev : [...prev, doc],
        );
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return;
        setLoading(true);
        setError("");
        try {
            const project = await createProject(
                name.trim(),
                cmNumber.trim() || undefined,
                sharedEmails,
            );
            const directorySelected = [...selectedDocIds];
            const connectorIds = importedConnectorDocs.map((d) => d.id);
            const allDocIds = Array.from(
                new Set([...directorySelected, ...connectorIds]),
            );
            await Promise.all([
                ...allDocIds.map((id) =>
                    addDocumentToProject(project.id, id).catch(() => {}),
                ),
                ...pendingFiles.map((f) => {
                    const fileType = fileTypeOf(f);
                    return uploadProjectDocument(project.id, f).then(
                        () => {
                            track("document_uploaded", {
                                surface: "project",
                                file_type: fileType,
                                result: "success",
                            });
                        },
                        () => {
                            track("document_uploaded", {
                                surface: "project",
                                file_type: fileType,
                                result: "error",
                            });
                        },
                    );
                }),
            ]);
            onCreated({
                ...project,
                document_count:
                    allDocIds.length + pendingFiles.length,
            });
            resetForm();
            onClose();
        } catch (err: unknown) {
            setError((err as Error).message || t("failedToCreate"));
        } finally {
            setLoading(false);
        }
    }

    function resetForm() {
        setName("");
        setCmNumber("");
        setSharedEmails([]);
        setShowMembers(false);
        setSelectedDocIds(new Set());
        setPendingFiles([]);
        setImportedConnectorDocs([]);
        setError("");
    }

    function handleClose() {
        resetForm();
        onClose();
    }

    const extraDocCount =
        pendingFiles.length + importedConnectorDocs.length;

    return (
        <div className="fixed inset-0 z-101 flex items-center justify-center bg-foreground/20 backdrop-blur-xs">
            <div className="w-full max-w-2xl rounded-xl bg-background border border-border flex flex-col h-[600px]">
                {/* Header */}
                <div className="flex items-center justify-between px-6 pt-5 pb-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                        <span>{t("breadcrumbProjects")}</span>
                        <span>›</span>
                        <span>{t("breadcrumbNew")}</span>
                    </div>
                    <button
                        onClick={handleClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
                    <div className="px-6 pt-3 pb-5 flex-1 overflow-y-auto">
                        {/* Title */}
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={t("namePlaceholder")}
                            className="w-full text-2xl font-serif text-foreground placeholder-muted-foreground/70 focus:outline-none bg-transparent"
                            autoFocus
                        />

                        {/* CM Number */}
                        <input
                            type="text"
                            value={cmNumber}
                            onChange={(e) => setCmNumber(e.target.value)}
                            placeholder={t("cmPlaceholder")}
                            className="mt-1.5 w-full text-sm text-muted-foreground placeholder-muted-foreground/70 focus:outline-none bg-transparent"
                        />

                        {/* Attribute pills */}
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setShowMembers((v) => !v)}
                                className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent transition-colors"
                            >
                                <Users className="h-3 w-3 text-muted-foreground/70" />
                                {t("members")}
                                {sharedEmails.length > 0
                                    ? ` (${sharedEmails.length})`
                                    : ""}
                            </button>
                        </div>

                        {/* Members panel */}
                        {showMembers && (
                            <div className="mt-3">
                                <EmailPillInput
                                    emails={sharedEmails}
                                    onChange={setSharedEmails}
                                    placeholder={t("membersPlaceholder")}
                                />
                            </div>
                        )}

                        {/* Documents */}
                        <div className="mt-4 space-y-2">
                            <p className="text-xs font-medium text-foreground">
                                {t("selectDocuments")}
                            </p>
                            <FileDirectory
                                standaloneDocs={standaloneDocuments}
                                directoryProjects={dirProjects}
                                loading={dirLoading}
                                selectedIds={selectedDocIds}
                                onChange={setSelectedDocIds}
                                emptyMessage={t("noExistingDocuments")}
                            />

                            {/* Imported-from-connector docs are guaranteed
                                selected for the new project; surface them
                                in a small pill list so the user sees they
                                are coming in. */}
                            {importedConnectorDocs.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {importedConnectorDocs.map((doc) => (
                                        <span
                                            key={doc.id}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent text-foreground border border-border max-w-[220px]"
                                            title={doc.filename}
                                        >
                                            <span className="truncate">
                                                {doc.filename}
                                            </span>
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>

                        {error && (
                            <p className="mt-3 text-sm text-destructive">{error}</p>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-border px-6 py-4 shrink-0">
                        <div className="flex items-center gap-2">
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                className="hidden"
                                onChange={handleFileChange}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent transition-colors"
                            >
                                <Upload className="h-3.5 w-3.5" />
                                {t("uploadFiles")}
                                {extraDocCount > 0
                                    ? ` (${extraDocCount})`
                                    : ""}
                            </button>
                            <ConnectorsButton
                                onImport={handleConnectorImport}
                            />
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
                                disabled={!name.trim() || loading}
                                className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                            >
                                {loading ? t("creating") : t("create")}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
