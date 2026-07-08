"use client";

import { useCallback, useEffect, useState } from "react";
import {
    AlertCircle,
    Check,
    ChevronUp,
    Loader2,
    Plug,
    Plus,
    Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirmDialog } from "@/app/components/modals/confirm-dialog";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { hasProFeatures } from "@/lib/tiers";
import { ProFeatureLock } from "@/app/components/account/ProFeatureLock";
import {
    createMcpServer,
    deleteMcpServer,
    listMcpServers,
    listBuiltinMcpServers,
    resetMcpOauth,
    startMcpOauth,
    testMcpServer,
    updateMcpServer,
    updateBuiltinMcpServer,
    type McpServer,
    type McpServerTestResult,
    type BuiltinMcpServer,
} from "@/app/lib/mikeApi";
import { CountryFlag, connectorFlagCode } from "@/app/components/shared/CountryFlag";
import { track } from "@/app/lib/analytics";

type DraftHeader = { key: string; value: string };

type Draft = {
    name: string;
    url: string;
    headers: DraftHeader[];
    auth_type: "headers" | "oauth";
};

const EMPTY_DRAFT: Draft = {
    name: "",
    url: "",
    headers: [{ key: "", value: "" }],
    auth_type: "headers",
};

export default function McpServersPage() {
    const [servers, setServers] = useState<McpServer[]>([]);
    const [builtinServers, setBuiltinServers] = useState<BuiltinMcpServer[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [showAdd, setShowAdd] = useState(false);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);

    const [testing, setTesting] = useState<Record<string, boolean>>({});
    const [testResults, setTestResults] = useState<
        Record<string, McpServerTestResult>
    >({});

    const { confirm, alert, dialog } = useConfirmDialog();
    const { profile } = useUserProfile();
    const t = useTranslations("connectors");
    const tc = useTranslations("common");

    const reload = useCallback(async () => {
        setLoadError(null);
        try {
            const [list, builtins] = await Promise.all([
                listMcpServers(),
                listBuiltinMcpServers(),
            ]);
            setServers(list);
            setBuiltinServers(builtins);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : "Failed to load");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    // Context (MCP) connectors are a Pro entitlement — free/plus see the
    // upsell card instead of the management controls, matching the PII / Word
    // add-in pattern. Pro and Legal Pro (and higher) get the full panel.
    if (profile && !hasProFeatures(profile.tierKey)) {
        return <ProFeatureLock kind="mcp" />;
    }

    const handleAdd = async () => {
        setAddError(null);
        const name = draft.name.trim();
        const url = draft.url.trim();
        if (!name || !url) {
            setAddError(t("addForm.nameUrlRequired"));
            return;
        }
        const headers: Record<string, string> = {};
        for (const h of draft.headers) {
            const k = h.key.trim();
            if (!k) continue;
            headers[k] = h.value;
        }
        setSaving(true);
        try {
            const created = await createMcpServer({
                name,
                url,
                headers: draft.auth_type === "oauth" ? {} : headers,
                auth_type: draft.auth_type,
            });
            setDraft(EMPTY_DRAFT);
            setShowAdd(false);
            await reload();
            if (draft.auth_type === "oauth") {
                // Discovery + sign-in needs user interaction. Kick the popup
                // immediately so it feels like one continuous flow.
                void launchOAuth(created.id);
            } else {
                // Auto-discover tools so the user sees the tool list right
                // away without an extra Test click.
                void runAutoTest(created.id);
            }
        } catch (err) {
            setAddError(err instanceof Error ? err.message : "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const launchOAuth = async (id: string) => {
        try {
            const { authorize_url, already_authorized } = await startMcpOauth(id);
            if (already_authorized) {
                await reload();
                void runAutoTest(id);
                return;
            }
            if (!authorize_url) {
                await alert({
                    title: t("alerts.signInUnavailable"),
                    message: t("alerts.noAuthorizeUrl"),
                });
                return;
            }
            const popup = window.open(
                authorize_url,
                "mcp_oauth",
                "width=600,height=720,menubar=no,toolbar=no,location=no",
            );
            if (!popup) {
                await alert({
                    title: t("alerts.popupBlocked"),
                    message:
                        t("alerts.popupBlockedMessage"),
                });
                return;
            }
            // Poll the row until tokens are saved, or until the popup closes
            // unfinished. Stop after 5 minutes regardless.
            const deadline = Date.now() + 5 * 60 * 1000;
            const interval = setInterval(async () => {
                try {
                    const list = await listMcpServers();
                    const row = list.find((s) => s.id === id);
                    if (row?.oauth_authorized) {
                        clearInterval(interval);
                        try {
                            popup.close();
                        } catch {
                            /* ignore */
                        }
                        setServers(list);
                        void runAutoTest(id);
                        return;
                    }
                } catch {
                    /* ignore transient errors */
                }
                if (popup.closed || Date.now() > deadline) {
                    clearInterval(interval);
                    await reload();
                }
            }, 1500);
        } catch (err) {
            await alert({
                title: t("alerts.signInFailed"),
                message: err instanceof Error ? err.message : t("alerts.signInFailed"),
            });
        }
    };

    const runAutoTest = async (id: string) => {
        setTesting((s) => ({ ...s, [id]: true }));
        try {
            const result = await testMcpServer(id);
            setTestResults((r) => ({ ...r, [id]: result }));
            if (result.ok) {
                track("mcp_server_connected");
            }
        } catch (err) {
            setTestResults((r) => ({
                ...r,
                [id]: {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                },
            }));
        } finally {
            setTesting((s) => ({ ...s, [id]: false }));
            reload();
        }
    };

    const handleToggleEnabled = async (server: McpServer) => {
        const wasDisabled = !server.enabled;
        try {
            await updateMcpServer(server.id, { enabled: !server.enabled });
            await reload();
            // Auto-test when going disabled → enabled so the user sees
            // immediately if the server still works after re-enabling.
            if (wasDisabled) void runAutoTest(server.id);
        } catch (err) {
            await alert({
                title: t("alerts.updateFailed"),
                message:
                    err instanceof Error ? err.message : t("alerts.failedToUpdate"),
            });
        }
    };

    const handleToggleBuiltin = async (server: BuiltinMcpServer) => {
        // Optimistic flip — the dropdown sees the same backend state and
        // will reload on next open, but flickering the row here is cheap.
        setBuiltinServers((prev) =>
            prev.map((b) =>
                b.slug === server.slug ? { ...b, enabled: !b.enabled } : b,
            ),
        );
        try {
            await updateBuiltinMcpServer(server.slug, {
                enabled: !server.enabled,
            });
        } catch (err) {
            await reload();
            await alert({
                title: t("alerts.updateFailed"),
                message:
                    err instanceof Error ? err.message : t("alerts.failedToUpdate"),
            });
        }
    };

    const handleDelete = async (server: McpServer) => {
        const ok = await confirm({
            title: t("confirm.removeTitle"),
            message: t("confirm.removeMessage", { name: server.name }),
            confirmLabel: t("confirm.removeConfirm"),
            destructive: true,
        });
        if (!ok) return;
        try {
            await deleteMcpServer(server.id);
            await reload();
        } catch (err) {
            await alert({
                title: t("alerts.deleteFailed"),
                message:
                    err instanceof Error ? err.message : t("alerts.failedToDelete"),
            });
        }
    };

    const handleTest = async (server: McpServer) => {
        setTesting((s) => ({ ...s, [server.id]: true }));
        try {
            const result = await testMcpServer(server.id);
            setTestResults((r) => ({ ...r, [server.id]: result }));
            if (result.ok) {
                track("mcp_server_connected");
            }
        } catch (err) {
            setTestResults((r) => ({
                ...r,
                [server.id]: {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                },
            }));
        } finally {
            setTesting((s) => ({ ...s, [server.id]: false }));
            // Reload so last_error reflects the test outcome.
            reload();
        }
    };

    const handleResetAndSignIn = async (server: McpServer) => {
        const ok = await confirm({
            title: t("confirm.resetOauthTitle"),
            message: t("confirm.resetOauthMessage", { name: server.name }),
            confirmLabel: t("confirm.resetOauthConfirm"),
        });
        if (!ok) return;
        try {
            await resetMcpOauth(server.id);
            // Drop any stale per-card state then re-render via reload.
            setTestResults((r) => {
                const next = { ...r };
                delete next[server.id];
                return next;
            });
            await reload();
            void launchOAuth(server.id);
        } catch (err) {
            await alert({
                title: t("alerts.resetFailed"),
                message:
                    err instanceof Error ? err.message : t("alerts.failedToResetOauth"),
            });
        }
    };

    return (
        <div className="space-y-4">
            {dialog}
            <div className="pb-2">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        {t("title")}
                    </h2>
                    <Button
                        onClick={() => setShowAdd((v) => !v)}
                        variant="outline"
                        className="gap-1"
                    >
                        {showAdd ? (
                            <>
                                <ChevronUp className="h-4 w-4" /> {t("hideForm")}
                            </>
                        ) : (
                            <>
                                <Plus className="h-4 w-4" /> {t("addConnector")}
                            </>
                        )}
                    </Button>
                </div>
                <p className="text-sm text-muted-foreground max-w-2xl">
                    {t.rich("description", {
                        link: (chunks) => (
                            <a
                                href="https://modelcontextprotocol.io"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline"
                            >
                                {chunks}
                            </a>
                        ),
                        code: (chunks) => (
                            <code className="text-xs bg-muted px-1 py-0.5 rounded">
                                {chunks}
                            </code>
                        ),
                    })}
                </p>
            </div>

            {/* Trust trade-off warning. Surfaced once at the top so users
                don't paste URLs and tokens for servers they haven't vetted. */}
            <div className="border border-warning/20 bg-warning/10 text-warning rounded-md p-3 text-sm flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
                <div>
                    <p className="font-medium">
                        {t("trustWarning.title")}
                    </p>
                    <p className="text-xs mt-1 leading-relaxed">
                        {t.rich("trustWarning.description", {
                            code: (chunks) => (
                                <code className="bg-warning/10 px-1 py-0.5 rounded">
                                    {chunks}
                                </code>
                            ),
                        })}
                    </p>
                </div>
            </div>

            {showAdd && (
                <AddForm
                    draft={draft}
                    setDraft={setDraft}
                    onSave={handleAdd}
                    saving={saving}
                    error={addError}
                />
            )}

            {loading ? (
                <div className="flex items-center gap-2 text-muted-foreground py-6">
                    <Loader2 className="h-4 w-4 animate-spin" /> {t("loadingServers")}
                </div>
            ) : loadError ? (
                <div className="text-destructive text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {loadError}
                </div>
            ) : (
                <>
                    {(builtinServers.length > 0 || servers.length > 0) ? (
                        <div className="space-y-3">
                            {/* Built-in connectors first — they're "preset
                                defaults" that the user can opt out of but
                                cannot edit (URL/headers stay server-side). */}
                            {builtinServers.map((b) => (
                                <BuiltinServerCard
                                    key={b.slug}
                                    server={b}
                                    onToggle={() => handleToggleBuiltin(b)}
                                />
                            ))}

                            {servers.map((s) => (
                                <ServerCard
                                    key={s.id}
                                    server={s}
                                    testing={testing[s.id] === true}
                                    testResult={testResults[s.id]}
                                    onToggle={() => handleToggleEnabled(s)}
                                    onDelete={() => handleDelete(s)}
                                    onTest={() => handleTest(s)}
                                    onSignIn={() => launchOAuth(s.id)}
                                    onResetOauth={() => handleResetAndSignIn(s)}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md py-6 text-center">
                            {t("noConnectors")}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function BuiltinServerCard({
    server,
    onToggle,
}: {
    server: BuiltinMcpServer;
    onToggle: () => void;
}) {
    const t = useTranslations("connectors");
    const tc = useTranslations("common");
    const flag = connectorFlagCode(server.slug);
    return (
        <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        {flag && (
                            <CountryFlag code={flag} label={server.name} className="text-base" />
                        )}
                        <h3 className="font-medium text-foreground truncate">
                            {flag ? flag.toUpperCase() : server.name}
                        </h3>
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent text-foreground border border-border">
                            {t("card.defaultBadge")}
                        </span>
                        {server.enabled ? (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                                {t("card.enabled")}
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70" />
                                {t("card.disabled")}
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                        <Plug className="h-3 w-3 shrink-0" />
                        {t("card.builtinHint")}
                    </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <Button variant="outline" size="sm" onClick={onToggle}>
                        {server.enabled ? tc("disable") : tc("enable")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function AddForm({
    draft,
    setDraft,
    onSave,
    saving,
    error,
}: {
    draft: Draft;
    setDraft: (d: Draft) => void;
    onSave: () => void;
    saving: boolean;
    error: string | null;
}) {
    const t = useTranslations("connectors");
    const tc = useTranslations("common");
    const updateHeader = (idx: number, patch: Partial<DraftHeader>) => {
        const headers = draft.headers.map((h, i) =>
            i === idx ? { ...h, ...patch } : h,
        );
        setDraft({ ...draft, headers });
    };
    const addHeaderRow = () =>
        setDraft({
            ...draft,
            headers: [...draft.headers, { key: "", value: "" }],
        });
    const removeHeaderRow = (idx: number) =>
        setDraft({
            ...draft,
            headers: draft.headers.filter((_, i) => i !== idx),
        });

    return (
        <div className="border border-border rounded-md p-4 space-y-3 bg-muted">
            <div>
                <label className="text-sm text-muted-foreground block mb-1">{t("addForm.name")}</label>
                <Input
                    placeholder={t("addForm.namePlaceholder")}
                    value={draft.name}
                    onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                    }
                />
            </div>
            <div>
                <label className="text-sm text-muted-foreground block mb-1">{t("addForm.url")}</label>
                <Input
                    placeholder={t("addForm.urlPlaceholder")}
                    value={draft.url}
                    onChange={(e) =>
                        setDraft({ ...draft, url: e.target.value })
                    }
                />
            </div>
            <div>
                <label className="text-sm text-muted-foreground block mb-1">
                    {t("addForm.authentication")}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() =>
                            setDraft({ ...draft, auth_type: "headers" })
                        }
                        className={`text-left rounded-md border p-2 text-sm transition-colors ${
                            draft.auth_type === "headers"
                                ? "border-border bg-surface-elevated ring-1 ring-ring"
                                : "border-border bg-surface-elevated hover:bg-accent"
                        }`}
                    >
                        <div className="font-medium">{t("addForm.apiKeyHeaders")}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                            {t("addForm.apiKeyHeadersDesc")}
                        </div>
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            setDraft({ ...draft, auth_type: "oauth" })
                        }
                        className={`text-left rounded-md border p-2 text-sm transition-colors ${
                            draft.auth_type === "oauth"
                                ? "border-border bg-surface-elevated ring-1 ring-ring"
                                : "border-border bg-surface-elevated hover:bg-accent"
                        }`}
                    >
                        <div className="font-medium">{t("addForm.oauthDiscover")}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                            {t("addForm.oauthDiscoverDesc")}
                        </div>
                    </button>
                </div>
            </div>
            {draft.auth_type === "headers" && (
            <div>
                <label className="text-sm text-muted-foreground block mb-1">
                    {t("addForm.customHeaders")}
                </label>
                <p className="text-xs text-muted-foreground/70 mb-2">
                    {t.rich("addForm.customHeadersHint", {
                        code: (chunks) => (
                            <code className="bg-muted px-1 py-0.5 rounded">
                                {chunks}
                            </code>
                        ),
                    })}
                </p>
                <div className="space-y-2">
                    {draft.headers.map((h, idx) => (
                        <div key={idx} className="flex gap-2">
                            <Input
                                placeholder={t("addForm.headerName")}
                                value={h.key}
                                onChange={(e) =>
                                    updateHeader(idx, { key: e.target.value })
                                }
                                className="flex-1"
                            />
                            <Input
                                placeholder={tc("name")}
                                value={h.value}
                                onChange={(e) =>
                                    updateHeader(idx, {
                                        value: e.target.value,
                                    })
                                }
                                className="flex-1"
                                type="password"
                            />
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeHeaderRow(idx)}
                                aria-label={t("addForm.removeHeader")}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={addHeaderRow}
                        className="gap-1"
                    >
                        <Plus className="h-3 w-3" /> {t("addForm.addHeader")}
                    </Button>
                </div>
            </div>
            )}
            {error && (
                <div className="text-sm text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {error}
                </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
                <Button
                    onClick={onSave}
                    disabled={saving}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                    {saving ? (
                        <>
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            {tc("saving")}
                        </>
                    ) : draft.auth_type === "oauth" ? (
                        t("addForm.saveAndSignIn")
                    ) : (
                        t("addForm.saveConnector")
                    )}
                </Button>
            </div>
        </div>
    );
}

/**
 * Sanitize a user-supplied server name for safe rendering. Strips Bearer
 * prefixes and obvious secret-looking tokens that users sometimes paste into
 * the Name field by mistake — the chat surface uses this label, so we don't
 * want secrets leaking onto screens / screenshots.
 */
function safeServerName(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "__UNTITLED__";
    const looksLikeSecret =
        /\b(?:Bearer|Basic|sk-[A-Za-z0-9_-]{8,}|sb_secret_|AIza[A-Za-z0-9_-]{20,})\b/i.test(
            trimmed,
        );
    if (looksLikeSecret) {
        // Best-effort cleanup: strip the secret-shaped substring.
        const cleaned = trimmed
            .replace(
                /\s*\(?(Bearer|Basic)\s+[A-Za-z0-9._~+/\-]+=*\)?/gi,
                "",
            )
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, "")
            .replace(/sb_secret_[A-Za-z0-9_-]+/g, "")
            .replace(/AIza[A-Za-z0-9_-]{20,}/g, "")
            .replace(/\s{2,}/g, " ")
            .trim();
        return cleaned || "Untitled connector";
    }
    return trimmed;
}

function ServerCard({
    server,
    testing,
    testResult,
    onToggle,
    onDelete,
    onTest,
    onSignIn,
    onResetOauth,
}: {
    server: McpServer;
    testing: boolean;
    testResult?: McpServerTestResult;
    onToggle: () => void;
    onDelete: () => void;
    onTest: () => void;
    onSignIn: () => void;
    onResetOauth: () => void;
}) {
    const t = useTranslations("connectors");
    const tc = useTranslations("common");
    const [showDetails, setShowDetails] = useState(false);
    const displayName = safeServerName(server.name).replace("__UNTITLED__", t("card.untitledConnector"));
    const nameWasSanitized = displayName !== server.name.trim() && displayName !== t("card.untitledConnector");
    const needsSignIn =
        server.auth_type === "oauth" && !server.oauth_authorized;

    return (
        <div className="border border-border rounded-lg overflow-hidden">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-medium text-foreground truncate">
                            {displayName}
                        </h3>
                        {server.auth_type === "oauth" && (
                            <span
                                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                                    server.oauth_authorized
                                        ? "bg-accent text-foreground border-border"
                                        : "bg-warning/10 text-warning border-warning/20"
                                }`}
                            >
                                {server.oauth_authorized
                                    ? t("card.oauthSignedIn")
                                    : t("card.oauthRequired")}
                            </span>
                        )}
                        {server.enabled ? (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-success" />
                                {t("card.enabled")}
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border">
                                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70" />
                                {t("card.disabled")}
                            </span>
                        )}
                        {server.last_error && server.last_error !== "reauth_required" && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive border border-destructive/20">
                                <AlertCircle className="h-3 w-3" />
                                {tc("error")}
                            </span>
                        )}
                    </div>
                    {nameWasSanitized && (
                        <p className="text-xs text-warning mt-1">
                            {t("card.nameContainedSecret")}
                        </p>
                    )}
                    <a
                        href={server.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-xs text-muted-foreground mt-1 truncate hover:text-foreground hover:underline"
                    >
                        {server.url}
                    </a>
                    {server.header_keys.length > 0 && (
                        <div className="text-xs text-muted-foreground/70 mt-1 flex flex-wrap gap-1">
                            <span>{t("card.headers")}</span>
                            {server.header_keys.map((k) => (
                                <span
                                    key={k}
                                    className="font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground"
                                >
                                    {k}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {needsSignIn ? (
                        <Button
                            size="sm"
                            onClick={onSignIn}
                            className="bg-primary hover:bg-primary/90 text-primary-foreground"
                        >
                            {t("card.signIn")}
                        </Button>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onTest}
                            disabled={testing}
                        >
                            {testing ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                tc("test")
                            )}
                        </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={onToggle}>
                        {server.enabled ? tc("disable") : tc("enable")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onDelete}
                        aria-label={t("card.deleteServer")}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Errors / status footer */}
            {testResult && !testResult.ok && (
                <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive border-t border-destructive/20 flex items-start gap-2">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-words">
                        {testResult.error ?? t("card.unknownError")}
                    </span>
                </div>
            )}
            {server.last_error && !testResult && (
                <div className="px-4 py-2 text-xs bg-destructive/10 text-destructive border-t border-destructive/20 flex items-start gap-2">
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-words flex-1">
                        {server.last_error}
                    </span>
                    {server.auth_type === "oauth" && (
                        <button
                            type="button"
                            onClick={onResetOauth}
                            className="text-destructive underline hover:text-destructive/80 shrink-0"
                        >
                            {t("confirm.resetOauth")}
                        </button>
                    )}
                </div>
            )}
            {/* Surface a Reset link even without last_error when the connector
                has cached DCR but no tokens — that's the "Client Not Registered"
                stuck state where the user needs to nuke metadata to make Sign in
                actually work. */}
            {!server.last_error &&
                server.auth_type === "oauth" &&
                !server.oauth_authorized &&
                testResult?.ok === false && (
                    <div className="px-4 py-2 text-xs bg-warning/10 text-warning border-t border-warning/20 flex items-center justify-end">
                        <button
                            type="button"
                            onClick={onResetOauth}
                            className="underline hover:text-warning/80"
                        >
                            {t("confirm.resetOauthTryAgain")}
                        </button>
                    </div>
                )}

            {/* Tool list */}
            {testResult?.ok && testResult.tools && testResult.tools.length > 0 && (
                <div className="border-t border-border bg-muted">
                    <button
                        type="button"
                        onClick={() => setShowDetails((v) => !v)}
                        className="w-full flex items-center justify-between px-4 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors"
                    >
                        <span className="flex items-center gap-2">
                            <Check className="h-3.5 w-3.5 text-success" />
                            {t("card.discoveredTools", { count: testResult.tool_count ?? 0 })}
                        </span>
                        <span className="text-muted-foreground/70">
                            {showDetails ? t("card.hide") : t("card.show")}
                        </span>
                    </button>
                    {showDetails && (
                        <ul className="divide-y divide-border bg-background">
                            {testResult.tools.map((t) => (
                                <ToolListItem
                                    key={t.name}
                                    name={t.name}
                                    description={t.description}
                                />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

function ToolListItem({
    name,
    description,
}: {
    name: string;
    description: string;
}) {
    const t = useTranslations("connectors");
    const [expanded, setExpanded] = useState(false);
    const trimmed = description.trim();
    const isLong = trimmed.length > 160;
    const shown = expanded || !isLong ? trimmed : trimmed.slice(0, 160) + "…";
    return (
        <li className="px-4 py-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded text-foreground">
                    {name}
                </code>
                {isLong && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="text-muted-foreground/70 hover:text-muted-foreground text-[11px] shrink-0"
                    >
                        {expanded ? t("card.toolLess") : t("card.toolMore")}
                    </button>
                )}
            </div>
            {trimmed && (
                <p className="text-muted-foreground mt-1 leading-relaxed">{shown}</p>
            )}
        </li>
    );
}

