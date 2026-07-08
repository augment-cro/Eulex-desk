"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

type DialogKind = "confirm" | "alert";

type DialogState = {
    open: boolean;
    kind: DialogKind;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive: boolean;
    resolve: ((value: boolean) => void) | null;
};

const DEFAULT_STATE: DialogState = {
    open: false,
    kind: "confirm",
    title: "",
    message: "",
    confirmLabel: "OK",
    cancelLabel: "Cancel",
    destructive: false,
    resolve: null,
};

export type ConfirmOptions = {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
};

export type AlertOptions = {
    title?: string;
    message: string;
    confirmLabel?: string;
};

/**
 * Promise-based replacement for the browser's native `window.confirm()` and
 * `window.alert()`. Chrome silently auto-dismisses native dialogs after a
 * page has shown several modals (e.g. an OAuth popup flow), which manifests
 * as the dialog "flickering" and the user's intent being dropped on the
 * floor. Routing those calls through an in-app modal sidesteps that quirk
 * entirely and lets us style the prompt to match the rest of the UI.
 *
 * Now built on shadcn Dialog (Radix UI) for accessible, animated behaviour.
 */
export function useConfirmDialog() {
    const [state, setState] = useState<DialogState>(DEFAULT_STATE);
    const t = useTranslations("confirmDialog");
    const tc = useTranslations("common");

    const confirm = useCallback(
        (opts: ConfirmOptions): Promise<boolean> =>
            new Promise<boolean>((resolve) => {
                setState({
                    open: true,
                    kind: "confirm",
                    title: opts.title ?? t("confirm"),
                    message: opts.message,
                    confirmLabel: opts.confirmLabel ?? t("confirm"),
                    cancelLabel: opts.cancelLabel ?? tc("cancel"),
                    destructive: opts.destructive ?? false,
                    resolve,
                });
            }),
        [t, tc],
    );

    const alertDialog = useCallback(
        (opts: AlertOptions): Promise<void> =>
            new Promise<void>((resolve) => {
                setState({
                    open: true,
                    kind: "alert",
                    title: opts.title ?? t("notice"),
                    message: opts.message,
                    confirmLabel: opts.confirmLabel ?? t("ok"),
                    cancelLabel: "",
                    destructive: false,
                    resolve: () => resolve(),
                });
            }),
        [t],
    );

    const close = useCallback(
        (value: boolean) => {
            state.resolve?.(value);
            setState(DEFAULT_STATE);
        },
        [state],
    );

    const dialog = useMemo(() => {
        if (!state.open) return null;
        return (
            <ConfirmDialog
                open={state.open}
                kind={state.kind}
                title={state.title}
                message={state.message}
                confirmLabel={state.confirmLabel}
                cancelLabel={state.cancelLabel}
                destructive={state.destructive}
                onConfirm={() => close(true)}
                onCancel={() => close(false)}
            />
        );
    }, [state, close]);

    return { confirm, alert: alertDialog, dialog };
}

function ConfirmDialog({
    open,
    kind,
    title,
    message,
    confirmLabel,
    cancelLabel,
    destructive,
    onConfirm,
    onCancel,
}: {
    open: boolean;
    kind: DialogKind;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const handleOpenChange = (isOpen: boolean) => {
        if (!isOpen) {
            // Closing via Esc or overlay click
            kind === "confirm" ? onCancel() : onConfirm();
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                className="sm:max-w-md"
                // Don't show the default X button — we handle close via onOpenChange
                showCloseButton={false}
            >
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        {destructive && (
                            <div className="shrink-0 mt-0.5 rounded-full bg-destructive/10 p-2 border border-destructive/20">
                                <AlertTriangle className="h-4 w-4 text-destructive" />
                            </div>
                        )}
                        <div className="flex-1 min-w-0">
                            <DialogTitle className="text-base font-semibold text-foreground leading-snug">
                                {title}
                            </DialogTitle>
                            <DialogDescription className="mt-1.5 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                                {message}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <DialogFooter className="mt-2 gap-2 sm:gap-2">
                    {kind === "confirm" && (
                        <Button
                            variant="outline"
                            onClick={onCancel}
                            className="flex-1 sm:flex-none"
                        >
                            {cancelLabel}
                        </Button>
                    )}
                    <Button
                        onClick={onConfirm}
                        autoFocus={kind === "alert"}
                        className={
                            destructive
                                ? "flex-1 sm:flex-none bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                                : "flex-1 sm:flex-none bg-primary hover:bg-primary/90 text-primary-foreground"
                        }
                    >
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
