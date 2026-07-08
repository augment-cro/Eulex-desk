import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslations, useLocale } from "next-intl";
import { track } from "@/app/lib/analytics";

interface CreditsExhaustedModalProps {
    isOpen: boolean;
    onClose: () => void;
    resetDate: string;
}

export function CreditsExhaustedModal({
    isOpen,
    onClose,
    resetDate,
}: CreditsExhaustedModalProps) {
    const t = useTranslations("modals.creditsExhausted");
    const tc = useTranslations("common");
    const locale = useLocale();

    // Fire paywall_shown once each time the modal opens.
    useEffect(() => {
        if (isOpen) {
            track("paywall_shown", { trigger: "credits_exhausted" });
        }
    }, [isOpen]);

    if (!isOpen) return null;

    // Format the reset date
    const formatResetDate = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleDateString(locale === "hr" ? "hr-HR" : "en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
        });
    };

    return createPortal(
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-foreground/50 z-[200]"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[201] w-full max-w-md px-4">
                <div className="relative bg-background rounded-2xl border border-border p-6">
                    {/* Header */}
                    <div className="flex items-start justify-between mb-4">
                        <h2 className="text-3xl font-light font-eb-garamond text-foreground">
                            {t("title")}
                        </h2>
                    </div>

                    {/* Content */}
                    <div className="space-y-4">
                        <p className="text-muted-foreground">
                            {t("message")}
                        </p>

                        <div className="bg-accent border border-border rounded-lg p-4">
                            <p className="text-sm text-foreground font-medium mb-1">
                                {t("resetLabel")}
                            </p>
                            <p className="text-lg font-semibold text-foreground">
                                {formatResetDate(resetDate)}
                            </p>
                        </div>

                        <p className="text-sm text-muted-foreground">
                            {t("resetNote")}
                        </p>
                    </div>

                    {/* Actions */}
                    <div className="mt-6 flex gap-3">
                        <button
                            onClick={onClose}
                            className="flex-1 px-4 py-2.5 bg-secondary hover:bg-accent text-secondary-foreground rounded-lg font-medium transition-colors"
                        >
                            {tc("close")}
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    );
}
