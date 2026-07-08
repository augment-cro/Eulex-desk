"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    AlertCircle,
    CheckCircle2,
    Loader2,
    LinkIcon,
    Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    disconnectIntegration,
    listIntegrations,
    startIntegrationOAuth,
    INTEGRATION_PROVIDER_IDS,
    type IntegrationProviderId,
    type IntegrationProviderStatus,
} from "@/app/lib/mikeApi";
import { track } from "@/app/lib/analytics";
import { useConfirmDialog } from "@/app/components/modals/confirm-dialog";

/**
 * sessionStorage guard so integration_connected fires once per OAuth
 * landing: the ?integration=&ok=1 params intentionally survive refresh
 * (the toast is idempotent), but the analytics event must not. Cleared in
 * handleConnect so a genuine reconnect in the same tab counts again.
 */
function connectedGuardKey(provider: string): string {
    return `sa:integration_connected:${provider}`;
}
import { IntegrationIcon } from "@/app/components/shared/IntegrationIcon";

/**
 * /account/connectors — manage native file-source integrations
 * (Google Drive / OneDrive / Box). Lives next to the existing MCP
 * connectors tab; this one is purely about pulling files into Eulex Desk.
 *
 * The OAuth round-trip lands the browser back here with
 *   ?integration=google_drive&ok=1
 * (or &ok=0&error=...) — we surface that as a transient toast and
 * re-fetch the list so the row flips to "Connected".
 */
export default function ConnectorsPage() {
    const t = useTranslations("connectorsPage");
    const tDelete = useTranslations("confirmDelete");
    const sp = useSearchParams();
    const { confirm: confirmDialog, dialog: confirmDialogEl } =
        useConfirmDialog();

    const [providers, setProviders] = useState<
        IntegrationProviderStatus[] | null
    >(null);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [toast, setToast] = useState<{
        kind: "ok" | "err";
        message: string;
    } | null>(null);

    const reload = useCallback(async () => {
        try {
            const res = await listIntegrations();
            setProviders(res.providers);
        } catch (err) {
            setProviders([]);
            setToast({
                kind: "err",
                message:
                    err instanceof Error
                        ? err.message
                        : t("errors.loadFailed"),
            });
        }
    }, [t]);

    useEffect(() => {
        void reload();
    }, [reload]);

    // Surface the OAuth callback result that the backend bounced us
    // back with. Shown for ~5s; we DO NOT strip the params from the URL
    // because the user may want to refresh the page (idempotent).
    const trackedConnectRef = useRef(false);
    useEffect(() => {
        const integration = sp.get("integration");
        const ok = sp.get("ok");
        const error = sp.get("error");
        if (!integration) return;
        if (ok === "1") {
            // Only fire the event when the provider is a known, valid value —
            // prevents arbitrary URL query-param values from reaching SA.
            // Guarded twice: the ref stops effect re-runs (e.g. locale switch
            // re-creating `t`), sessionStorage stops full-page refreshes with
            // the params still in the URL.
            if (
                !trackedConnectRef.current &&
                (INTEGRATION_PROVIDER_IDS as readonly string[]).includes(
                    integration,
                )
            ) {
                trackedConnectRef.current = true;
                let alreadyTracked = false;
                try {
                    const key = connectedGuardKey(integration);
                    alreadyTracked = sessionStorage.getItem(key) === "1";
                    if (!alreadyTracked) sessionStorage.setItem(key, "1");
                } catch {
                    // sessionStorage unavailable — ref alone still gives
                    // at-most-once per mount.
                }
                if (!alreadyTracked) {
                    track("integration_connected", {
                        provider: integration as IntegrationProviderId,
                    });
                }
            }
            setToast({
                kind: "ok",
                message: t("toasts.connected", { name: integration }),
            });
        } else {
            setToast({
                kind: "err",
                message: error
                    ? t("toasts.failedWithError", {
                          name: integration,
                          error,
                      })
                    : t("toasts.failed", { name: integration }),
            });
        }
        const id = setTimeout(() => setToast(null), 6000);
        return () => clearTimeout(id);
    }, [sp, t]);

    const handleConnect = async (provider: IntegrationProviderId) => {
        setBusy((b) => ({ ...b, [provider]: true }));
        // A new OAuth flow may legitimately land back here — let its
        // integration_connected event through the sessionStorage guard.
        try {
            sessionStorage.removeItem(connectedGuardKey(provider));
        } catch {
            /* ignore */
        }
        try {
            const { authorize_url } = await startIntegrationOAuth(provider);
            window.location.href = authorize_url;
        } catch (err) {
            setBusy((b) => ({ ...b, [provider]: false }));
            setToast({
                kind: "err",
                message:
                    err instanceof Error ? err.message : t("errors.startFailed"),
            });
        }
    };

    const handleDisconnect = async (provider: IntegrationProviderStatus) => {
        const ok = await confirmDialog({
            title: tDelete("connectorTitle"),
            message: tDelete("connectorBody", {
                name: provider.display_name,
            }),
            confirmLabel: tDelete("disconnectAction"),
            destructive: true,
        });
        if (!ok) return;
        setBusy((b) => ({ ...b, [provider.id]: true }));
        try {
            await disconnectIntegration(provider.id);
            await reload();
        } catch (err) {
            setToast({
                kind: "err",
                message:
                    err instanceof Error
                        ? err.message
                        : t("errors.disconnectFailed"),
            });
        } finally {
            setBusy((b) => ({ ...b, [provider.id]: false }));
        }
    };

    return (
        <div className="space-y-6">
            <div className="pb-2">
                <h2 className="text-2xl font-medium font-serif mb-2">
                    {t("title")}
                </h2>
                <p className="text-sm text-muted-foreground max-w-2xl">
                    {t("description")}
                </p>
            </div>

            {toast && (
                <div
                    className={`rounded-md border px-3 py-2 text-sm flex items-start gap-2 ${
                        toast.kind === "ok"
                            ? "border-success/20 bg-success/10 text-success"
                            : "border-destructive/20 bg-destructive/10 text-destructive"
                    }`}
                >
                    {toast.kind === "ok" ? (
                        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                    ) : (
                        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    )}
                    <span>{toast.message}</span>
                </div>
            )}

            {providers === null ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("loading")}
                </div>
            ) : providers.length === 0 ? (
                <div className="rounded-md border border-border bg-muted p-6 text-sm text-muted-foreground">
                    {t("empty")}
                </div>
            ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {providers.map((p) => (
                        <li
                            key={p.id}
                            className="flex items-center justify-between gap-4 p-4"
                        >
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <IntegrationIcon
                                        provider={p.id}
                                        className={`h-4 w-4 shrink-0 ${
                                            p.connected ? "" : "opacity-50 grayscale"
                                        }`}
                                    />
                                    <span className="font-medium text-sm">
                                        {p.display_name}
                                    </span>
                                    {!p.configured && (
                                        <span className="text-xs text-warning bg-warning/10 px-2 py-0.5 rounded">
                                            {t("notConfigured")}
                                        </span>
                                    )}
                                </div>
                                {p.connected ? (
                                    <p className="text-xs text-muted-foreground mt-1 truncate">
                                        {t("connectedAs", {
                                            email:
                                                p.account_email ??
                                                p.account_name ??
                                                "—",
                                        })}
                                    </p>
                                ) : (
                                    <p className="text-xs text-muted-foreground/70 mt-1">
                                        {t("notConnected")}
                                    </p>
                                )}
                            </div>

                            {p.configured ? (
                                p.connected ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy[p.id]}
                                        onClick={() => handleDisconnect(p)}
                                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                                    >
                                        {busy[p.id] ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Trash2 className="h-4 w-4 mr-1" />
                                        )}
                                        {t("disconnect")}
                                    </Button>
                                ) : (
                                    <Button
                                        size="sm"
                                        disabled={busy[p.id]}
                                        onClick={() => handleConnect(p.id)}
                                        className="bg-primary hover:bg-primary/90 text-primary-foreground"
                                    >
                                        {busy[p.id] ? (
                                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                        ) : (
                                            <LinkIcon className="h-4 w-4 mr-1" />
                                        )}
                                        {t("connect")}
                                    </Button>
                                )
                            ) : (
                                <span className="text-xs text-muted-foreground/70">
                                    {t("contactAdmin")}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {confirmDialogEl}
        </div>
    );
}
