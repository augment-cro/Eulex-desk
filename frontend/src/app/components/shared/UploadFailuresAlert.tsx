"use client";

import { createPortal } from "react-dom";
import { AlertCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UploadFailure } from "@/app/lib/bulkUpload";
import {
    MAX_UPLOAD_MB,
    SUPPORTED_UPLOAD_LABEL,
} from "@/app/lib/supportedFileTypes";

interface Props {
    failures: UploadFailure[];
    onDismiss: () => void;
    /**
     * Bottom-right card over the page (same placement as
     * `ConnectorImportProgress`) for surfaces with no room for an inline
     * alert, e.g. the chat composer's upload button.
     */
    floating?: boolean;
    className?: string;
}

/**
 * Which files did not upload, and why. Shared by every multi-file upload
 * surface (see `uploadFilesBulk`); renders nothing without failures.
 */
export function UploadFailuresAlert({
    failures,
    onDismiss,
    floating = false,
    className,
}: Props) {
    const t = useTranslations("documents.uploadErrors");
    const tc = useTranslations("common");
    if (failures.length === 0) return null;

    const reasonLabel = (failure: UploadFailure) => {
        if (failure.reason === "unsupported") {
            return failure.fileType
                ? t("unsupportedType", { type: failure.fileType.toUpperCase() })
                : t("unsupported");
        }
        if (failure.reason === "too_large") {
            return t("tooLarge", { max: MAX_UPLOAD_MB });
        }
        return t("failed");
    };
    const hasUnsupported = failures.some((f) => f.reason === "unsupported");

    const alert = (
        <Alert
            variant="destructive"
            className={cn(
                "border-destructive/20 bg-destructive/10 pr-10",
                !floating && className,
            )}
        >
            <AlertCircle />
            <AlertTitle>{t("title", { count: failures.length })}</AlertTitle>
            <AlertDescription>
                <ul className="max-h-32 w-full overflow-y-auto">
                    {failures.map((failure, i) => (
                        <li
                            key={`${i}-${failure.name}`}
                            // Wraps the reason under the name in narrow
                            // panels (the project-chat explorer).
                            className="flex min-w-0 flex-wrap gap-x-1.5 text-xs"
                        >
                            <span
                                className="min-w-0 max-w-full truncate font-medium"
                                title={failure.name}
                            >
                                {failure.name}
                            </span>
                            <span className="shrink-0">
                                · {reasonLabel(failure)}
                            </span>
                        </li>
                    ))}
                </ul>
                {hasUnsupported && (
                    <p className="text-xs">
                        {t("supportedTypes", { types: SUPPORTED_UPLOAD_LABEL })}
                    </p>
                )}
            </AlertDescription>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onDismiss}
                aria-label={tc("close")}
                className="absolute right-1.5 top-1.5 size-7 text-current hover:bg-destructive/10 hover:text-destructive"
            >
                <X />
            </Button>
        </Alert>
    );

    if (!floating) return alert;
    return createPortal(
        <div
            className={cn(
                "fixed bottom-6 right-6 z-[400] w-[360px] max-w-[calc(100vw-3rem)] rounded-lg bg-background",
                className,
            )}
        >
            {alert}
        </div>,
        document.body,
    );
}
