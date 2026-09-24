import type {
    ColumnConfig,
    MikeWorkflow,
} from "@/app/components/shared/types";

const WORKFLOW_FILE_FORMAT = "mike.workflow" as const;
const WORKFLOW_FILE_VERSION = 1 as const;

export type WorkflowFileErrorCode =
    | "invalidJson"
    | "notEnvelope"
    | "wrongFormat"
    | "unsupportedVersion"
    | "missingTitle"
    | "badType"
    | "badColumns"
    | "badPrompt"
    | "badPractice";

export interface WorkflowFile {
    format: typeof WORKFLOW_FILE_FORMAT;
    version: typeof WORKFLOW_FILE_VERSION;
    title: string;
    type: "assistant" | "tabular";
    practice: string | null;
    prompt_md: string | null;
    columns_config: ColumnConfig[] | null;
}

export class WorkflowFileError extends Error {
    code: WorkflowFileErrorCode;
    constructor(code: WorkflowFileErrorCode) {
        super(code);
        this.code = code;
        this.name = "WorkflowFileError";
    }
}

export function buildWorkflowEnvelope(wf: MikeWorkflow): WorkflowFile {
    return {
        format: WORKFLOW_FILE_FORMAT,
        version: WORKFLOW_FILE_VERSION,
        title: wf.title,
        type: wf.type,
        practice: wf.practice ?? null,
        prompt_md: wf.prompt_md ?? null,
        columns_config: wf.columns_config ?? null,
    };
}

function sanitizeFilename(title: string): string {
    const cleaned = title
        .normalize("NFKD")
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    return cleaned.length > 0 ? cleaned : "workflow";
}

export function downloadWorkflow(wf: MikeWorkflow): void {
    const envelope = buildWorkflowEnvelope(wf);
    const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sanitizeFilename(wf.title)}.mikeworkflow.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function parseWorkflowFile(raw: string): WorkflowFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new WorkflowFileError("invalidJson");
    }
    if (!parsed || typeof parsed !== "object") {
        throw new WorkflowFileError("notEnvelope");
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.format !== WORKFLOW_FILE_FORMAT) {
        throw new WorkflowFileError("wrongFormat");
    }
    if (obj.version !== WORKFLOW_FILE_VERSION) {
        throw new WorkflowFileError("unsupportedVersion");
    }
    if (typeof obj.title !== "string" || !obj.title.trim()) {
        throw new WorkflowFileError("missingTitle");
    }
    if (obj.type !== "assistant" && obj.type !== "tabular") {
        throw new WorkflowFileError("badType");
    }
    // prompt_md must be a string (or absent) — a non-string here reaches
    // the editor's setContent and crashes it (issue #121).
    if (obj.prompt_md != null && typeof obj.prompt_md !== "string") {
        throw new WorkflowFileError("badPrompt");
    }
    if (obj.practice != null && typeof obj.practice !== "string") {
        throw new WorkflowFileError("badPractice");
    }
    let columns: ColumnConfig[] | null = null;
    if (obj.columns_config != null) {
        if (!Array.isArray(obj.columns_config)) {
            throw new WorkflowFileError("badColumns");
        }
        // Validate every column item's shape — a non-numeric `index` breaks
        // the `.sort((a,b)=>a.index-b.index)` + React keys downstream (#121).
        columns = obj.columns_config.map((raw): ColumnConfig => {
            if (!raw || typeof raw !== "object") {
                throw new WorkflowFileError("badColumns");
            }
            const c = raw as Record<string, unknown>;
            if (
                typeof c.index !== "number" ||
                !Number.isFinite(c.index) ||
                typeof c.name !== "string" ||
                typeof c.prompt !== "string"
            ) {
                throw new WorkflowFileError("badColumns");
            }
            return {
                index: c.index,
                name: c.name,
                prompt: c.prompt,
                ...(typeof c.format === "string" ? { format: c.format } : {}),
                ...(Array.isArray(c.tags)
                    ? { tags: c.tags.filter((t): t is string => typeof t === "string") }
                    : {}),
            } as ColumnConfig;
        });
    }
    return {
        format: WORKFLOW_FILE_FORMAT,
        version: WORKFLOW_FILE_VERSION,
        title: obj.title.trim(),
        type: obj.type,
        practice: (obj.practice as string | null | undefined) ?? null,
        prompt_md: (obj.prompt_md as string | null | undefined) ?? null,
        columns_config: columns,
    };
}

export async function readWorkflowFile(file: File): Promise<WorkflowFile> {
    const text = await file.text();
    return parseWorkflowFile(text);
}
