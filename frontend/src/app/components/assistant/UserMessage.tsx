"use client";

import { File, FileText, Library } from "lucide-react";

interface Props {
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
}

export function UserMessage({ content, files, workflow }: Props) {
    const hasFiles = files && files.length > 0;

    return (
        <div className="w-full flex justify-end">
            <div className="max-w-[80%] bg-muted rounded-xl px-4 py-3">
                <p className="text-sm text-foreground whitespace-pre-wrap">{content}</p>
                {(workflow || hasFiles) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-primary text-primary-foreground border border-primary">
                                <Library className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{workflow.title}</span>
                            </div>
                        )}
                        {hasFiles && files.map((f, i) => {
                            const ext = f.filename.split(".").pop()?.toLowerCase();
                            const isPdf = ext === "pdf";
                            return (
                                <div
                                    key={i}
                                    className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs text-primary-foreground border border-primary bg-primary"
                                >
                                    {isPdf
                                        ? <FileText className="h-2.5 w-2.5 shrink-0 text-primary-foreground/70" />
                                        : <File className="h-2.5 w-2.5 shrink-0 text-primary-foreground/70" />
                                    }
                                    <span className="max-w-[140px] truncate">{f.filename}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
