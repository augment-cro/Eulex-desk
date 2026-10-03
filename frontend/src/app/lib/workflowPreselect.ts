import type { MikeContextTask } from "./mikeApi";
import type { MikeWorkflow } from "../components/shared/types";

/**
 * Opening a new assistant chat with a workflow already selected — the
 * "Pokreni" button of a context task. The link carries the workflow as
 * `/assistant?workflow=<id>&workflowTitle=<title>`; the new-chat view reads
 * it once, preselects it in the composer (the usual workflow chip) and drops
 * the parameters from the address.
 */
export interface PreselectedWorkflow {
    id: string;
    title: string;
    type: MikeWorkflow["type"];
}

const MAX_CHARS = 200;

/** The text of a task in the UI locale, else the default (hr) one. */
export function localizedTaskText(
    i18n: { hr?: string; en?: string } | undefined,
    fallback: string,
    locale: string,
): string {
    return i18n?.[locale === "en" ? "en" : "hr"]?.trim() || fallback;
}

/** A context task as a workflow: id ctx-<context id>-<task id>, title "<task id> <name>". */
export function contextTaskWorkflow(
    contextId: string,
    task: Pick<MikeContextTask, "id" | "name" | "name_i18n">,
    locale: string,
): PreselectedWorkflow {
    return {
        id: `ctx-${contextId}-${task.id}`,
        title: `${task.id} ${localizedTaskText(task.name_i18n, task.name, locale)}`,
        type: "assistant",
    };
}

export function workflowPreselectHref(wf: Pick<PreselectedWorkflow, "id" | "title">): string {
    const params = new URLSearchParams({ workflow: wf.id, workflowTitle: wf.title });
    return `/assistant?${params.toString()}`;
}

/** The preselected workflow of a new-chat link, or null (absent / malformed). */
export function readWorkflowPreselect(
    params: Pick<URLSearchParams, "get"> | null,
): PreselectedWorkflow | null {
    const id = params?.get("workflow")?.trim() ?? "";
    const title = params?.get("workflowTitle")?.trim() ?? "";
    if (!id || !title || id.length > MAX_CHARS || title.length > MAX_CHARS) return null;
    return { id, title, type: "assistant" };
}
