"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
    shareContext,
    unshareContext,
    type MikeContextShare,
} from "@/app/lib/mikeApi";

interface Props {
    contextId: string;
    shares: MikeContextShare[];
    onSharesChange: (shares: MikeContextShare[]) => void;
}

/** Owner-only: the shares API rejects non-owners. */
export function SharingPanel({ contextId, shares, onSharesChange }: Props) {
    const t = useTranslations("newContext");
    const [email, setEmail] = useState("");
    const [allowEdit, setAllowEdit] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function handleShare(e: React.FormEvent) {
        e.preventDefault();
        const target = email.trim();
        if (!target) return;
        setBusy(true);
        setError("");
        try {
            await shareContext(contextId, target, allowEdit);
            const rest = shares.filter(
                (s) => s.shared_with_email !== target,
            );
            onSharesChange([
                ...rest,
                {
                    context_id: contextId,
                    shared_with_email: target,
                    allow_edit: allowEdit,
                },
            ]);
            setEmail("");
            setAllowEdit(false);
        } catch (err: unknown) {
            console.error("Failed to share context", err);
            setError(t("failedShare"));
        } finally {
            setBusy(false);
        }
    }

    async function handleUnshare(target: string) {
        try {
            await unshareContext(contextId, target);
            onSharesChange(
                shares.filter((s) => s.shared_with_email !== target),
            );
        } catch (err: unknown) {
            console.error("Failed to remove share", err);
            setError(t("failedUpdate"));
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <form
                onSubmit={handleShare}
                className="flex flex-wrap items-center gap-2"
            >
                <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t("sharePlaceholder")}
                    className="max-w-64"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Switch
                        size="sm"
                        checked={allowEdit}
                        onCheckedChange={setAllowEdit}
                    />
                    {t("allowEdit")}
                </label>
                <Button
                    type="submit"
                    size="sm"
                    disabled={!email.trim() || busy}
                >
                    {t("share")}
                </Button>
            </form>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {shares.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("noShares")}
                </p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {shares.map((s) => (
                        <li
                            key={s.shared_with_email}
                            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5"
                        >
                            <span className="min-w-0 truncate text-sm text-foreground">
                                {s.shared_with_email}
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                                {s.allow_edit && (
                                    <span className="text-xs text-muted-foreground">
                                        {t("allowEdit")}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={() =>
                                        void handleUnshare(s.shared_with_email)
                                    }
                                    aria-label={t("removeShare")}
                                    title={t("removeShare")}
                                    className="rounded p-0.5 text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive transition-colors"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
