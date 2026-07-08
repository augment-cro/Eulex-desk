"use client";

/**
 * ConnectorImportProgress — fixed bottom-right toast that surfaces
 * progress for in-flight Google Drive / Microsoft 365 / Box imports.
 *
 * Mounted by the pickers (GoogleDrivePickerLauncher,
 * IntegrationFilePicker) so the user gets visible feedback even after
 * the picker UI has dismissed itself (true for Google's iframe, which
 * closes immediately on "Select" and leaves a multi-second blank gap
 * before chips appear).
 *
 * Render is portal'd to <body> so it survives unmounting of the parent
 * modal and ignores its overflow/clip rules.
 *
 * Controlled component — the parent picker owns the counts. The toast
 * auto-fades 1.5s after total === done + failed and `keepOpenAfterDone`
 * is falsy, but we also remount cleanly across batches by keying on the
 * "session" prop the caller bumps for each new import burst.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { IntegrationIcon } from "./IntegrationIcon";
import type { IntegrationProviderId } from "@/app/lib/mikeApi";

interface Props {
    provider: IntegrationProviderId | null;
    providerDisplayName?: string | null;
    /** Total files in the current import batch. 0 → hidden. */
    total: number;
    done: number;
    failed: number;
}

export function ConnectorImportProgress({
    provider,
    providerDisplayName,
    total,
    done,
    failed,
}: Props) {
    const t = useTranslations("documents");
    const [mounted, setMounted] = useState(false);
    const [visible, setVisible] = useState(false);

    // Hide after the burst settles. Keep `mounted` true through the
    // fade so the user actually sees the success/failure state.
    useEffect(() => {
        if (total === 0 || provider === null) {
            setVisible(false);
            const tid = setTimeout(() => setMounted(false), 250);
            return () => clearTimeout(tid);
        }
        setMounted(true);
        // Tick on next frame so the CSS transition runs.
        const tid = setTimeout(() => setVisible(true), 16);
        return () => clearTimeout(tid);
    }, [total, provider]);

    // Auto-fade ~1.5s after settle.
    const settled = total > 0 && done + failed >= total;
    useEffect(() => {
        if (!settled) return;
        const tid = setTimeout(() => setVisible(false), 1500);
        return () => clearTimeout(tid);
    }, [settled]);

    if (!mounted || provider === null || total === 0) return null;

    const name = providerDisplayName ?? provider;
    const allDone = settled && failed === 0;
    const allFailed = settled && done === 0 && failed === total;

    return createPortal(
        <div
            className={`fixed bottom-6 right-6 z-[400] transition-all duration-200 ease-out ${
                visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
            }`}
        >
            <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-elevated px-4 py-3 min-w-[260px] max-w-[360px]">
                <IntegrationIcon
                    provider={provider}
                    className="h-5 w-5 shrink-0 mt-0.5"
                />
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                        {allDone
                            ? t("importing.done", { name })
                            : allFailed
                              ? t("importing.failed", { name })
                              : t("importing.title", { name })}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                        {settled
                            ? failed > 0
                                ? t("importing.summaryMixed", {
                                      done,
                                      failed,
                                  })
                                : t("importing.summaryDone", { count: done })
                            : t("importing.progress", {
                                  done,
                                  total,
                              })}
                    </div>
                </div>
                <div className="shrink-0 mt-0.5">
                    {allDone ? (
                        <Check className="h-4 w-4 text-success" />
                    ) : allFailed ? (
                        <AlertCircle className="h-4 w-4 text-destructive" />
                    ) : (
                        <Loader2 className="h-4 w-4 animate-spin text-foreground" />
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
