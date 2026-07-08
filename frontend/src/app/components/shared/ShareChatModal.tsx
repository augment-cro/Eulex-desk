"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Mail, CheckCircle2, Clock, Ban } from "lucide-react";
import {
    shareChat,
    listChatShares,
    deleteChatShare,
    type ChatShare,
} from "@/app/lib/mikeApi";
import { EmailPillInput } from "./EmailPillInput";
import { useTranslations } from "next-intl";
import { track } from "@/app/lib/analytics";

interface Props {
    chatId: string;
    chatTitle: string | null;
    onClose: () => void;
}

type ShareStatus = "pending" | "accepted" | "expired" | "revoked";

function shareStatus(share: ChatShare): ShareStatus {
    if (share.revoked_at) return "revoked";
    if (share.accepted_at) return "accepted";
    if (new Date(share.expires_at).getTime() < Date.now()) return "expired";
    return "pending";
}

export function ShareChatModal({ chatId, chatTitle, onClose }: Props) {
    const t = useTranslations("shareChat");
    const tCommon = useTranslations("common");
    const [pendingEmails, setPendingEmails] = useState<string[]>([]);
    const [existing, setExisting] = useState<ChatShare[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    useEffect(() => {
        listChatShares(chatId)
            .then((rows) => setExisting(rows ?? []))
            .catch(() => {})
            .finally(() => setLoading(false));
    }, [chatId]);

    // Auto-clear transient info banner after a few seconds.
    useEffect(() => {
        if (!info) return;
        const t = setTimeout(() => setInfo(null), 4000);
        return () => clearTimeout(t);
    }, [info]);

    async function handleSubmit() {
        if (pendingEmails.length === 0 || saving) return;
        setSaving(true);
        setError(null);
        setInfo(null);
        try {
            const res = await shareChat(chatId, { emails: pendingEmails });
            setExisting(res.shares);
            setPendingEmails([]);
            const sentCount = res.sent?.length ?? 0;
            const failedCount = res.failures?.length ?? 0;
            if (sentCount > 0) {
                track("chat_shared");
                setInfo(
                    failedCount === 0
                        ? t("inviteSent", { count: sentCount })
                        : t("inviteSentPartial", {
                              sent: sentCount,
                              failed: failedCount,
                          }),
                );
            }
            if (sentCount === 0 && failedCount > 0) {
                setError(res.failures[0]?.reason || t("errorSendFailed"));
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Surface backend rate-limit / validation reason if the
            // body is plain text JSON detail.
            try {
                const parsed = JSON.parse(msg) as { detail?: string };
                setError(parsed.detail ?? msg);
            } catch {
                setError(msg);
            }
        } finally {
            setSaving(false);
        }
    }

    async function handleRevoke(shareId: string) {
        const optimistic = existing.map((s) =>
            s.id === shareId
                ? { ...s, revoked_at: new Date().toISOString() }
                : s,
        );
        setExisting(optimistic);
        try {
            await deleteChatShare(chatId, shareId);
        } catch {
            const rows = await listChatShares(chatId).catch(() => existing);
            setExisting(rows);
        }
    }

    return createPortal(
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-primary/30 backdrop-blur-xs px-4">
            <div className="w-full max-w-xl rounded-2xl bg-background border border-border flex flex-col max-h-[85vh]">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <div className="flex items-center gap-2 text-sm text-foreground">
                        <Mail className="h-4 w-4 text-muted-foreground/70" />
                        <span className="font-medium">{t("title")}</span>
                        {chatTitle && (
                            <span className="text-muted-foreground/70 truncate max-w-[280px]">
                                · {chatTitle}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-5 py-4 flex flex-col gap-4 flex-1 overflow-y-auto">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                        {t("explainer")}
                    </p>

                    <EmailPillInput
                        emails={pendingEmails}
                        onChange={setPendingEmails}
                        placeholder={t("addPeopleByEmail")}
                        autoFocus
                    />

                    {error && (
                        <div className="text-xs rounded-md bg-destructive/10 border border-destructive/20 text-destructive px-3 py-2">
                            {error}
                        </div>
                    )}
                    {info && (
                        <div className="text-xs rounded-md bg-success/10 border border-success/20 text-success px-3 py-2">
                            {info}
                        </div>
                    )}

                    <div>
                        <p className="text-xs font-medium text-foreground mb-2">
                            {t("peopleWithAccess")}
                        </p>
                        {loading ? (
                            <div className="space-y-2">
                                {[1, 2].map((i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between"
                                    >
                                        <div className="h-3 w-44 rounded bg-muted animate-pulse" />
                                        <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                                    </div>
                                ))}
                            </div>
                        ) : existing.length === 0 ? (
                            <p className="text-sm text-muted-foreground/70">
                                {t("none")}
                            </p>
                        ) : (
                            <ul className="space-y-1">
                                {existing.map((s) => {
                                    const status = shareStatus(s);
                                    return (
                                        <li
                                            key={s.id}
                                            className="flex items-center justify-between py-1.5"
                                        >
                                            <span className="text-sm text-foreground truncate">
                                                {s.shared_with_email}
                                            </span>
                                            <div className="flex items-center gap-3 shrink-0">
                                                <StatusBadge status={status} />
                                                {status !== "revoked" &&
                                                    status !== "accepted" && (
                                                        <button
                                                            onClick={() =>
                                                                handleRevoke(
                                                                    s.id,
                                                                )
                                                            }
                                                            className="text-muted-foreground/70 hover:text-destructive transition-colors"
                                                            title={t("revoke")}
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </button>
                                                    )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>

                <div className="border-t border-border px-5 py-3 flex justify-end gap-2 shrink-0">
                    <button
                        onClick={onClose}
                        className="rounded-lg px-5 py-2 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
                    >
                        {tCommon("cancel")}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={saving || pendingEmails.length === 0}
                        className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                        {saving ? t("sharing") : t("sendInvites")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}

function StatusBadge({ status }: { status: ShareStatus }) {
    const t = useTranslations("shareChat");
    if (status === "accepted") {
        return (
            <span className="inline-flex items-center gap-1 text-[11px] text-success">
                <CheckCircle2 className="h-3 w-3" />
                {t("statusAccepted")}
            </span>
        );
    }
    if (status === "expired") {
        return (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Clock className="h-3 w-3" />
                {t("statusExpired")}
            </span>
        );
    }
    if (status === "revoked") {
        return (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                <Ban className="h-3 w-3" />
                {t("statusRevoked")}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {t("statusPending")}
        </span>
    );
}
