"use client";

/**
 * GoogleDrivePickerLauncher — bridges Google's official Drive Picker
 * (`@googleworkspace/drive-picker-react`) to our existing import flow.
 *
 * The Picker iframe is mandatory for our chosen scope `drive.file`,
 * which only grants access to files the user explicitly hands the app
 * via the Picker UI (no audit/verification gate, unlike `drive.readonly`).
 *
 * Flow when `open` flips to true:
 *   1. Fetch a fresh access_token + app_id from
 *      GET /integrations/google_drive/picker_token (auto-refreshes if
 *      the stored token is within 60s of expiry).
 *   2. Mount <DrivePicker oauth-token=… app-id=… multiselect> which
 *      auto-displays Google's iframe modal on top of the page.
 *   3. On `picker-picked` → import each picked file through our backend
 *      and forward the resulting MikeDocument(s) to onImport.
 *   4. On `picker-canceled`, oauth error or unmount → cleanly close.
 *
 * The Google iframe paints its own modal + backdrop on top of the
 * viewport (z-index ~10001 internally), so we don't wrap it in any
 * additional portal/backdrop on our side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
    DrivePicker,
    DrivePickerDocsView,
} from "@googleworkspace/drive-picker-react";
import type {
    PickerCanceledEvent,
    PickerPickedEvent,
    OAuthErrorEvent,
} from "@googleworkspace/drive-picker-element";
import {
    getGoogleDrivePickerToken,
    importIntegrationFile,
    type GoogleDrivePickerToken,
} from "@/app/lib/mikeApi";
import {
    UPLOAD_CONCURRENCY,
    classifyUploadError,
    settleWithConcurrency,
} from "@/app/lib/bulkUpload";
import { GOOGLE_PICKER_MIME_TYPES } from "@/app/lib/supportedFileTypes";
import type { MikeDocument } from "./types";
import { ConnectorImportProgress } from "./ConnectorImportProgress";

interface Props {
    open: boolean;
    onClose: () => void;
    onImport: (doc: MikeDocument) => void;
    projectId?: string | null;
}

interface PickedDoc {
    id: string;
    name?: string;
    mimeType?: string;
}

export function GoogleDrivePickerLauncher({
    open,
    onClose,
    onImport,
    projectId = null,
}: Props) {
    const t = useTranslations("googleDrivePicker");
    const tDocs = useTranslations("documents");
    const [tokenState, setTokenState] = useState<GoogleDrivePickerToken | null>(
        null,
    );
    const [error, setError] = useState<string | null>(null);
    // Progress counters surfaced through the floating toast so the
    // user gets visible feedback after the Picker iframe dismisses
    // itself. `total` 0 hides the toast entirely. `unsupportedTypes`
    // names the formats the backend rejected.
    const [progress, setProgress] = useState({
        total: 0,
        done: 0,
        failed: 0,
        unsupportedTypes: [] as string[],
    });
    // Latch — we don't want to call onClose() twice for the same open
    // cycle (e.g. once on `picker-canceled` and once on unmount).
    const closedRef = useRef(false);

    const close = useCallback(() => {
        if (closedRef.current) return;
        closedRef.current = true;
        onClose();
    }, [onClose]);

    // Fetch a fresh picker token every time the launcher opens. We do
    // NOT cache across opens because the token is short-lived and the
    // backend round-trip is cheap (~80ms).
    useEffect(() => {
        if (!open) {
            setTokenState(null);
            setError(null);
            // Don't reset `progress` here — the toast component owns
            // its fade-out timing and we want a "completed" burst to
            // remain visible briefly after the picker closes.
            closedRef.current = false;
            return;
        }
        let cancelled = false;
        getGoogleDrivePickerToken()
            .then((res) => {
                if (cancelled) return;
                setTokenState(res);
            })
            .catch((err) => {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : String(err);
                setError(msg);
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    const handlePicked = useCallback(
        async (e: PickerPickedEvent) => {
            const detail = e.detail as { docs?: PickedDoc[] };
            const docs = detail.docs ?? [];
            if (docs.length === 0) {
                close();
                return;
            }
            // Reset + seed counters so the floating toast picks up.
            setProgress({
                total: docs.length,
                done: 0,
                failed: 0,
                unsupportedTypes: [],
            });
            // Each import is a server-side download + processing run, so
            // keep at most UPLOAD_CONCURRENCY in flight (a multi-select
            // used to fire them all at once). Counters still tick up as
            // each import settles, so slow ones don't hide progress.
            const unsupportedTypes = new Set<string>();
            const results = await settleWithConcurrency(
                docs,
                UPLOAD_CONCURRENCY,
                async (d) => {
                    try {
                        const doc = await importIntegrationFile(
                            "google_drive",
                            d.id,
                            projectId,
                        );
                        onImport(doc);
                        setProgress((p) => ({ ...p, done: p.done + 1 }));
                    } catch (reason) {
                        console.error(
                            `Google Drive import failed for ${d?.name ?? d?.id}:`,
                            reason,
                        );
                        const failure = classifyUploadError(reason);
                        if (
                            failure.reason === "unsupported" &&
                            failure.fileType
                        ) {
                            unsupportedTypes.add(
                                failure.fileType.toUpperCase(),
                            );
                        }
                        setProgress((p) => ({
                            ...p,
                            failed: p.failed + 1,
                            unsupportedTypes: [...unsupportedTypes],
                        }));
                        throw reason;
                    }
                },
            );
            const failedCount = results.filter(
                (r) => r.status === "rejected",
            ).length;
            if (failedCount > 0 && failedCount === results.length) {
                // Hard fail — surface the error card so the user knows
                // *something* went wrong rather than silently closing.
                const importFailed = t("importFailed", { count: failedCount });
                setError(
                    unsupportedTypes.size > 0
                        ? `${importFailed} ${tDocs("importing.unsupported", {
                              types: [...unsupportedTypes].join(", "),
                          })}`
                        : importFailed,
                );
                return;
            }
            // Soft close — the floating toast keeps showing the
            // result for ~1.5s after we close.
            close();
        },
        [onImport, projectId, close, t, tDocs],
    );

    const handleCanceled = useCallback(
        (_e: PickerCanceledEvent) => {
            close();
        },
        [close],
    );

    const handleOauthError = useCallback(
        (e: OAuthErrorEvent) => {
            const detail = e.detail as unknown as { message?: string };
            setError(detail.message || t("oauthError"));
            close();
        },
        [close, t],
    );

    // The progress toast survives `open === false` so it can fade out
    // its "done" state after the picker dismisses itself.
    const progressToast = (
        <ConnectorImportProgress
            provider="google_drive"
            providerDisplayName="Google Drive"
            total={progress.total}
            done={progress.done}
            failed={progress.failed}
            unsupportedTypes={progress.unsupportedTypes}
        />
    );

    if (!open) return progressToast;

    if (error) {
        return (
            <>
                {progressToast}
                <div className="fixed inset-0 z-[300] flex items-center justify-center bg-primary/20">
                    <div className="bg-background border border-border rounded-lg p-5 max-w-md mx-4">
                        <h3 className="text-sm font-medium text-destructive mb-2">
                            {t("errorTitle")}
                        </h3>
                        <p className="text-sm text-muted-foreground mb-4 break-words">
                            {error}
                        </p>
                        <div className="flex justify-end">
                            <button
                                onClick={() => {
                                    setError(null);
                                    onClose();
                                }}
                                className="px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                                {t("ok")}
                            </button>
                        </div>
                    </div>
                </div>
            </>
        );
    }

    if (!tokenState) {
        // Brief loading state while we fetch the token. Picker iframe
        // takes a second to render anyway, so this is barely visible.
        return progressToast;
    }

    return (
        <>
            {progressToast}
            <DrivePicker
                {...({
                    "app-id": tokenState.app_id,
                    "oauth-token": tokenState.access_token,
                    ...(tokenState.developer_key
                        ? { "developer-key": tokenState.developer_key }
                        : {}),
                    "max-items": 20,
                    multiselect: true,
                    title: t("pickerTitle"),
                } as Record<string, unknown>)}
                onPicked={handlePicked}
                onCanceled={handleCanceled}
                onOauthError={handleOauthError}
            >
                {/* Only offer what the backend imports: PDF / Word / text
                    and native Google Docs (exported to .docx). Sheets and
                    Slides export to xlsx / pptx, which would be rejected. */}
                <DrivePickerDocsView
                    {...({
                        "include-folders": "false",
                        "owned-by-me": "default",
                        "mime-types": GOOGLE_PICKER_MIME_TYPES,
                    } as Record<string, unknown>)}
                />
            </DrivePicker>
        </>
    );
}
