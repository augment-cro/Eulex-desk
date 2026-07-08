"use client";

/**
 * IntegrationFilePicker — modal that lets the user pick a file from a
 * connected cloud-storage integration (Google Drive / OneDrive / Box)
 * and import it into Eulex Desk as a regular MikeDocument.
 *
 * The wire format is identical across providers (see
 * backend/src/routes/integrations.ts) so this component is fully
 * provider-agnostic — the only thing it varies by provider is the
 * label in the header.
 *
 * Flow:
 *   1. On open: fetch first page of files (no query).
 *   2. On query change: debounce 400ms, then re-fetch with ?q=…
 *   3. Click a row → POST /integrations/:provider/import → call
 *      onImport(doc) and close.
 *   4. "Load more" button at bottom appends the next page when the
 *      backend returned a next_page_token.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, FileIcon, Loader2, Search, X } from "lucide-react";
import { IntegrationIcon } from "./IntegrationIcon";
import { ConnectorImportProgress } from "./ConnectorImportProgress";
import { useTranslations } from "next-intl";
import {
    importIntegrationFile,
    listIntegrationFiles,
    type IntegrationFile,
    type IntegrationProviderId,
} from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";

interface Props {
    open: boolean;
    provider: IntegrationProviderId | null;
    providerDisplayName: string | null;
    onClose: () => void;
    onImport: (doc: MikeDocument) => void;
    /** Optional project to import into; null = standalone. */
    projectId?: string | null;
}

const PAGE_SIZE = 30;

export function IntegrationFilePicker({
    open,
    provider,
    providerDisplayName,
    onClose,
    onImport,
    projectId = null,
}: Props) {
    const t = useTranslations("documents");
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const [files, setFiles] = useState<IntegrationFile[]>([]);
    const [nextPageToken, setNextPageToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [importingId, setImportingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Same floating progress surface as Google Drive — exposes a 1-of-1
    // counter once the user clicks a file. Even though IntegrationFilePicker
    // keeps the modal open during the per-row spinner, the toast adds a
    // visible bottom-right cue that survives the modal closing.
    const [progress, setProgress] = useState({
        total: 0,
        done: 0,
        failed: 0,
    });

    // Reset everything when the modal opens or the provider switches.
    useEffect(() => {
        if (!open || !provider) return;
        setQuery("");
        setDebouncedQuery("");
        setFiles([]);
        setNextPageToken(null);
        setError(null);
        setImportingId(null);
        // Don't reset `progress` here — let the toast finish its
        // fade-out animation across open/close cycles.
    }, [open, provider]);

    // Debounce search input (400ms) to avoid hammering the provider on
    // every keystroke — the backend just proxies to Google/Microsoft/Box.
    useEffect(() => {
        if (!open) return;
        const id = setTimeout(() => setDebouncedQuery(query.trim()), 400);
        return () => clearTimeout(id);
    }, [query, open]);

    const fetchPage = useCallback(
        async (
            providerId: IntegrationProviderId,
            q: string,
            pageToken: string | null,
            append: boolean,
        ) => {
            if (append) setLoadingMore(true);
            else setLoading(true);
            setError(null);
            try {
                const out = await listIntegrationFiles(providerId, {
                    q: q || undefined,
                    page_token: pageToken ?? undefined,
                    page_size: PAGE_SIZE,
                });
                setFiles((prev) =>
                    append ? [...prev, ...out.files] : out.files,
                );
                setNextPageToken(out.next_page_token);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setError(msg);
            } finally {
                if (append) setLoadingMore(false);
                else setLoading(false);
            }
        },
        [],
    );

    // Fire a new fetch whenever the debounced query (or the open/provider) changes.
    useEffect(() => {
        if (!open || !provider) return;
        void fetchPage(provider, debouncedQuery, null, false);
    }, [open, provider, debouncedQuery, fetchPage]);

    const handleImport = useCallback(
        async (file: IntegrationFile) => {
            if (!provider) return;
            setImportingId(file.id);
            setError(null);
            setProgress({ total: 1, done: 0, failed: 0 });
            try {
                const doc = await importIntegrationFile(
                    provider,
                    file.id,
                    projectId,
                );
                onImport(doc);
                setProgress((p) => ({ ...p, done: p.done + 1 }));
                onClose();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setError(msg);
                setProgress((p) => ({ ...p, failed: p.failed + 1 }));
            } finally {
                setImportingId(null);
            }
        },
        [provider, projectId, onImport, onClose],
    );

    const dateFormatter = useMemo(
        () =>
            new Intl.DateTimeFormat(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
            }),
        [],
    );

    const formatSize = (bytes: number | null): string => {
        if (bytes == null) return "";
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024)
            return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
        return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    };

    // Close on Escape.
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") onCloseRef.current();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [open]);

    // The progress toast is rendered independently of the modal so it
    // survives the picker dismissing itself after the import settles.
    const progressToast = provider ? (
        <ConnectorImportProgress
            provider={provider}
            providerDisplayName={providerDisplayName}
            total={progress.total}
            done={progress.done}
            failed={progress.failed}
        />
    ) : null;

    if (!open || !provider) return progressToast;

    const title = t("picker.title", {
        name: providerDisplayName ?? provider,
    });

    return createPortal(
        <>
            {progressToast}
            <div
                className="fixed inset-0 z-[200] flex items-center justify-center bg-primary/10 backdrop-blur-xs"
                onClick={onClose}
            >
            <div
                className="w-full max-w-2xl rounded-2xl bg-background border border-border flex flex-col h-[600px]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4">
                    <div className="flex items-center gap-2">
                        <IntegrationIcon
                            provider={provider}
                            className="h-4 w-4 shrink-0"
                        />
                        <span className="text-sm font-medium text-foreground">
                            {title}
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Search bar */}
                <div className="px-4 pt-1 pb-2">
                    <div className="flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2">
                        <Search className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                        <input
                            type="text"
                            placeholder={t("picker.searchPlaceholder")}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                            autoFocus
                        />
                        {query && (
                            <button
                                onClick={() => setQuery("")}
                                className="text-muted-foreground/70 hover:text-muted-foreground"
                                aria-label="Clear search"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                </div>

                {/* Error banner */}
                {error && (
                    <div className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span className="break-words">{error}</span>
                    </div>
                )}

                {/* File list */}
                <div className="flex-1 overflow-y-auto px-2 pb-2">
                    {loading ? (
                        <div className="flex items-center justify-center h-full text-sm text-muted-foreground gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t("picker.loading")}
                        </div>
                    ) : files.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-sm text-muted-foreground/70">
                            {debouncedQuery
                                ? t("picker.empty")
                                : t("picker.emptyRoot")}
                        </div>
                    ) : (
                        <ul className="divide-y divide-border">
                            {files.map((file) => {
                                const isImporting = importingId === file.id;
                                const disabled = importingId !== null;
                                return (
                                    <li key={`${file.id}-${file.revision ?? ""}`}>
                                        <button
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => handleImport(file)}
                                            className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
                                                disabled
                                                    ? "opacity-50 cursor-not-allowed"
                                                    : "hover:bg-accent cursor-pointer"
                                            }`}
                                        >
                                            {isImporting ? (
                                                <Loader2 className="h-4 w-4 shrink-0 text-foreground animate-spin" />
                                            ) : (
                                                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm text-foreground truncate">
                                                    {file.name}
                                                </div>
                                                <div className="text-xs text-muted-foreground/70 mt-0.5 flex items-center gap-2">
                                                    {file.modified_at && (
                                                        <span>
                                                            {dateFormatter.format(
                                                                new Date(
                                                                    file.modified_at,
                                                                ),
                                                            )}
                                                        </span>
                                                    )}
                                                    {file.size_bytes != null && (
                                                        <>
                                                            <span>·</span>
                                                            <span>
                                                                {formatSize(
                                                                    file.size_bytes,
                                                                )}
                                                            </span>
                                                        </>
                                                    )}
                                                    {file.parent && (
                                                        <>
                                                            <span>·</span>
                                                            <span className="truncate">
                                                                {file.parent}
                                                            </span>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                            {isImporting && (
                                                <span className="text-xs text-foreground shrink-0">
                                                    {t("picker.importing")}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                );
                            })}

                            {nextPageToken && (
                                <li className="px-3 py-3 flex justify-center">
                                    <button
                                        type="button"
                                        disabled={loadingMore}
                                        onClick={() =>
                                            void fetchPage(
                                                provider,
                                                debouncedQuery,
                                                nextPageToken,
                                                true,
                                            )
                                        }
                                        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 disabled:opacity-50"
                                    >
                                        {loadingMore && (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                        )}
                                        {t("picker.loadMore")}
                                    </button>
                                </li>
                            )}
                        </ul>
                    )}
                </div>
            </div>
        </div>
        </>,
        document.body,
    );
}
