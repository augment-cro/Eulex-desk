"use client";

import { createPortal } from "react-dom";
import { Lock, X } from "lucide-react";
import { useTranslations } from "next-intl";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Short headline above the body, e.g. "Owner-only action". */
    title?: string;
    /** Sentence describing what the user tried to do. */
    action?: string;
    /** Email of the project/resource owner, shown so the user knows who to ask. */
    ownerEmail?: string | null;
    /** Override the default message entirely. */
    message?: string;
}

/**
 * Lightweight "you don't have permission" modal shown when a non-owner
 * attempts an owner-only action (manage people, rename, delete, …) on a
 * shared project. Replaces the silent 404 the backend would otherwise
 * return so the user understands why the action didn't go through.
 */
export function OwnerOnlyModal({
    open,
    onClose,
    title,
    action,
    ownerEmail,
    message,
}: Props) {
    const t = useTranslations("ownerOnly");

    if (!open) return null;

    const displayTitle = title ?? t("defaultTitle");

    const body =
        message ??
        (action
            ? t("actionMessage", { action })
            : t("defaultMessage"));

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-primary/10 backdrop-blur-xs"
            onClick={onClose}
        >
            <div
                className="w-full max-w-md rounded-2xl bg-background border border-border flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2">
                    <div className="flex items-center gap-2">
                        <Lock className="h-4 w-4 text-warning" />
                        <h2 className="text-base font-medium text-foreground">
                            {displayTitle}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-muted-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 pb-2 pt-1">
                    <p className="text-sm text-muted-foreground leading-relaxed">
                        {body}
                    </p>
                    {ownerEmail && (
                        <p className="mt-2 text-xs text-muted-foreground/70">
                            {t("askAccess", { email: ownerEmail })}
                        </p>
                    )}
                </div>

                {/* Footer */}
                <div className="flex justify-end gap-2 px-5 pb-5 pt-3">
                    <button
                        onClick={onClose}
                        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        {t("ok")}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
