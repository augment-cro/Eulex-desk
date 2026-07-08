"use client";

import { Check, Trash2 } from "lucide-react";
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

interface DeleteChatsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    chatCount: number;
    isDeleting: boolean;
    isSuccess?: boolean;
}

export function DeleteChatsModal({
    isOpen,
    onClose,
    onConfirm,
    chatCount,
    isDeleting,
    isSuccess = false,
}: DeleteChatsModalProps) {
    const t = useTranslations("deleteChats");
    const tc = useTranslations("common");

    const handleOpenChange = (open: boolean) => {
        if (!open && !isDeleting && !isSuccess) onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={handleOpenChange}>
            <DialogContent
                className="sm:max-w-md"
                showCloseButton={!isDeleting && !isSuccess}
            >
                {isSuccess ? (
                    <>
                        <DialogHeader>
                            <div className="flex flex-col items-center text-center gap-3 py-2">
                                <div className="flex items-center justify-center w-14 h-14 rounded-full bg-success/10">
                                    <Check className="h-7 w-7 text-success" />
                                </div>
                                <DialogTitle className="text-xl font-semibold text-foreground">
                                    {t("successTitle")}
                                </DialogTitle>
                                <DialogDescription className="text-sm text-muted-foreground">
                                    {t("successMessage")}
                                </DialogDescription>
                            </div>
                        </DialogHeader>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <div className="flex items-start gap-3">
                                <div className="shrink-0 mt-0.5 rounded-full bg-destructive/10 p-2 border border-destructive/20">
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <DialogTitle className="text-base font-semibold text-foreground">
                                        {t("title")}
                                    </DialogTitle>
                                    <DialogDescription className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
                                        {t("confirmMessage", { count: chatCount })}
                                    </DialogDescription>
                                </div>
                            </div>
                        </DialogHeader>

                        <DialogFooter className="mt-2 gap-2 sm:gap-2">
                            <Button
                                variant="outline"
                                onClick={onClose}
                                disabled={isDeleting}
                                className="flex-1 sm:flex-none"
                            >
                                {tc("cancel")}
                            </Button>
                            <Button
                                onClick={onConfirm}
                                disabled={isDeleting}
                                className="flex-1 sm:flex-none bg-destructive hover:bg-destructive/90 text-destructive-foreground disabled:opacity-60"
                            >
                                {isDeleting ? t("deleting") : t("deleteAll")}
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
