import { X, Link2, Check } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

interface SimpleLinkDialogProps {
    isOpen: boolean;
    onClose: () => void;
    shareUrl: string | null;
}

export function SimpleLinkDialog({
    isOpen,
    onClose,
    shareUrl,
}: SimpleLinkDialogProps) {
    const [linkCopied, setLinkCopied] = useState(false);
    const t = useTranslations("shareChat");

    if (!isOpen) return null;

    const handleCopyLink = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2000);
        } catch (err) {}
    };

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-foreground/50 z-[199]"
                onClick={onClose}
            />

            {/* Dialog */}
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[200] w-full max-w-md px-4">
                <div className="relative bg-background rounded-2xl border border-border p-6">
                    {/* Close Button */}
                    <button
                        onClick={onClose}
                        className="absolute right-4 top-4 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
                    >
                        <X className="h-5 w-5" />
                    </button>

                    {/* Header */}
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-3xl font-light font-eb-garamond text-foreground">
                            {t("title")}
                        </h2>
                    </div>

                    {/* Content */}
                    <div className="space-y-4">
                        {/* Link display */}
                        <div className="bg-muted rounded-lg p-3 border border-border">
                            <p className="text-sm text-muted-foreground mb-2 font-medium">
                                {t("shareLink")}
                            </p>
                            <p className="text-sm text-foreground break-all font-mono">
                                {shareUrl}
                            </p>
                        </div>

                        {/* Copy button */}
                        <button
                            onClick={handleCopyLink}
                            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground py-2.5 px-4 rounded-lg transition-colors font-medium"
                        >
                            {linkCopied ? (
                                <>
                                    <Check className="h-5 w-5" />
                                    {t("copied")}
                                </>
                            ) : (
                                <>
                                    <Link2 className="h-5 w-5" />
                                    {t("copyLink")}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    );
}
