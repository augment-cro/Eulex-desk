"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { createWorkflow } from "@/app/lib/mikeApi";
import {
    WorkflowFileError,
    readWorkflowFile,
} from "@/app/lib/workflowFile";
import type { MikeWorkflow } from "../shared/types";

interface Props {
    onUploaded: (workflow: MikeWorkflow) => void;
}

export function UploadWorkflowButton({ onUploaded }: Props) {
    const t = useTranslations("workflowsPage.upload");
    const inputRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function handleClick() {
        setError(null);
        inputRef.current?.click();
    }

    async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const envelope = await readWorkflowFile(file);
            const created = await createWorkflow({
                title: envelope.title,
                type: envelope.type,
                practice: envelope.practice,
                prompt_md: envelope.prompt_md ?? undefined,
                columns_config: envelope.columns_config ?? undefined,
            });
            onUploaded(created);
        } catch (err) {
            if (err instanceof WorkflowFileError) {
                setError(t(`errors.${err.code}`));
            } else {
                setError(t("errors.generic"));
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="relative flex items-center">
            <input
                ref={inputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleChange}
            />
            <button
                onClick={handleClick}
                disabled={busy}
                aria-label={t("aria")}
                title={t("aria")}
                className="flex items-center justify-center p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            >
                <Upload className="h-4 w-4" />
            </button>
            {error && (
                <span
                    className="ml-2 max-w-[280px] truncate text-xs text-destructive"
                    title={error}
                >
                    {error}
                </span>
            )}
        </div>
    );
}
