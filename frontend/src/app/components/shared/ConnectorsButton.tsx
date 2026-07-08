"use client";

/**
 * ConnectorsButton — a compact "Kontekst" dropdown for modals that
 * already have their own "Upload files" button (NewProjectModal,
 * AddNewTRModal, …). Mirrors the connector half of AddDocButton but
 * without the upload/browse-all items so the host modal keeps full
 * control over its primary upload UI.
 *
 * Flow:
 *   - Lazy-fetches /integrations on first dropdown open.
 *   - Shows only providers the operator has configured.
 *   - Connected provider → opens GoogleDrivePickerLauncher (Drive)
 *     or IntegrationFilePicker (OneDrive/Box).
 *   - Not-connected provider → opens the OAuth flow in a new tab; on
 *     return the host page refreshes its session and the dropdown
 *     re-reads /integrations next time it's opened.
 *
 * Imports are performed against `projectId` (null → standalone). The
 * resulting MikeDocument is handed back via onImport so the host can
 * either auto-select it for the new project/review or pre-attach it
 * to a workflow.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, LinkIcon, Loader2, Cloud } from "lucide-react";
import { useTranslations } from "next-intl";
import { IntegrationIcon } from "./IntegrationIcon";
import { IntegrationFilePicker } from "./IntegrationFilePicker";
import { GoogleDrivePickerLauncher } from "./GoogleDrivePickerLauncher";
import {
    listIntegrations,
    startIntegrationOAuth,
    type IntegrationProviderId,
    type IntegrationProviderStatus,
} from "@/app/lib/mikeApi";
import type { MikeDocument } from "./types";

interface Props {
    /**
     * Project id to import into. `null` (default) imports as a
     * standalone document — the modal can then call
     * `addDocumentToProject(newProject.id, doc.id)` after the project
     * itself is created.
     */
    projectId?: string | null;
    /** Fired once per successfully imported document. */
    onImport: (doc: MikeDocument) => void;
    /** Optional override label; defaults to "Kontekst" / "Context". */
    label?: string;
    /** Match the host modal's button visual style. */
    size?: "sm" | "md";
}

export function ConnectorsButton({
    projectId = null,
    onImport,
    label,
    size = "sm",
}: Props) {
    const t = useTranslations("documents");
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [integrations, setIntegrations] = useState<
        IntegrationProviderStatus[] | null
    >(null);
    const [loadError, setLoadError] = useState(false);
    const [integrationPicker, setIntegrationPicker] = useState<{
        provider: IntegrationProviderId;
        displayName: string;
    } | null>(null);
    const [googleDrivePickerOpen, setGoogleDrivePickerOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    // Close the dropdown when clicking outside; the IntegrationFilePicker
    // and GoogleDrivePickerLauncher render into their own portals so we
    // don't need to special-case them here.
    useEffect(() => {
        if (!dropdownOpen) return;
        const onDocClick = (e: MouseEvent) => {
            const target = e.target as Node;
            if (
                menuRef.current?.contains(target) ||
                triggerRef.current?.contains(target)
            ) {
                return;
            }
            setDropdownOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
    }, [dropdownOpen]);

    // Lazy-load integrations on first open. The /integrations endpoint
    // is cheap (~80ms) but we still defer it so the modal renders
    // instantly. Reset on close so a fresh OAuth completion is picked
    // up next time the dropdown opens.
    useEffect(() => {
        if (!dropdownOpen || integrations !== null) return;
        let cancelled = false;
        listIntegrations()
            .then((res) => {
                if (cancelled) return;
                setIntegrations(res.providers.filter((p) => p.configured));
                setLoadError(false);
            })
            .catch(() => {
                if (cancelled) return;
                setIntegrations([]);
                setLoadError(true);
            });
        return () => {
            cancelled = true;
        };
    }, [dropdownOpen, integrations]);

    const handleConnect = async (provider: IntegrationProviderId) => {
        try {
            const { authorize_url } = await startIntegrationOAuth(provider);
            window.open(authorize_url, "_blank", "noopener,noreferrer");
            // Clear cache so the next open picks up the new "connected" state.
            setIntegrations(null);
            setDropdownOpen(false);
        } catch (err) {
            console.error(`Failed to start ${provider} OAuth:`, err);
        }
    };

    const buttonLabel = label ?? t("connectorsButton");

    const sizeClasses =
        size === "md"
            ? "px-3 py-2 text-sm"
            : "px-3 py-1.5 text-xs";

    return (
        <>
            <div className="relative inline-block">
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={() => setDropdownOpen((o) => !o)}
                    className={`flex items-center gap-1.5 rounded-lg border border-border ${sizeClasses} text-muted-foreground hover:bg-accent transition-colors`}
                >
                    <Cloud
                        className={
                            size === "md" ? "h-4 w-4" : "h-3.5 w-3.5"
                        }
                    />
                    <span>{buttonLabel}</span>
                    <ChevronDown
                        className={
                            size === "md" ? "h-3.5 w-3.5" : "h-3 w-3"
                        }
                    />
                </button>

                {dropdownOpen && (
                    <div
                        ref={menuRef}
                        className="absolute left-0 bottom-full z-50 mb-1 w-56 rounded-xl border border-border bg-surface-elevated overflow-hidden"
                    >
                        {integrations === null ? (
                            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground/70">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                {t("picker.loading")}
                            </div>
                        ) : integrations.length === 0 ? (
                            <div className="px-3 py-2.5 text-xs text-muted-foreground/70">
                                {loadError
                                    ? t("picker.loading")
                                    : t("noConnectorsConfigured")}
                            </div>
                        ) : (
                            integrations.map((provider) => (
                                <button
                                    key={provider.id}
                                    type="button"
                                    onClick={() => {
                                        setDropdownOpen(false);
                                        if (!provider.connected) {
                                            void handleConnect(provider.id);
                                            return;
                                        }
                                        // Google Drive uses its dedicated
                                        // Picker iframe; OneDrive/Box use
                                        // the generic IntegrationFilePicker.
                                        if (provider.id === "google_drive") {
                                            setGoogleDrivePickerOpen(true);
                                            return;
                                        }
                                        setIntegrationPicker({
                                            provider: provider.id,
                                            displayName: provider.display_name,
                                        });
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
                                >
                                    {provider.connected ? (
                                        <IntegrationIcon
                                            provider={provider.id}
                                            className="h-4 w-4 shrink-0"
                                        />
                                    ) : (
                                        <LinkIcon className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                                    )}
                                    <span className="whitespace-nowrap">
                                        {provider.connected
                                            ? t("browseProvider", {
                                                  name: provider.display_name,
                                              })
                                            : t("connectProvider", {
                                                  name: provider.display_name,
                                              })}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                )}
            </div>

            <IntegrationFilePicker
                open={integrationPicker !== null}
                provider={integrationPicker?.provider ?? null}
                providerDisplayName={integrationPicker?.displayName ?? null}
                onClose={() => setIntegrationPicker(null)}
                onImport={onImport}
                projectId={projectId}
            />
            <GoogleDrivePickerLauncher
                open={googleDrivePickerOpen}
                onClose={() => setGoogleDrivePickerOpen(false)}
                onImport={onImport}
                projectId={projectId}
            />
        </>
    );
}
