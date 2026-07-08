/**
 * Module-scoped store shared between tabs (Chat, Projects, Workflows, Tabular,
 * Track). Intentionally minimal — a plain object plus an EventTarget for
 * change notifications, exposed through the `useChatContext` hook. No external
 * deps so the add-in bundle stays small.
 *
 * State:
 *   - activeProjectId:  scopes chat to a project (Chat tab uses
 *     POST /projects/:id/chat when set). Persisted to localStorage so it
 *     survives reloads.
 *   - pendingWorkflow:  one-shot handoff from the Workflows tab to the
 *     Chat composer. In-memory only; consumePendingWorkflow() reads-and-clears.
 */

import { useCallback, useEffect, useState } from "react";

const PROJECT_KEY = "mike.activeProject";

export interface PendingWorkflow {
    id: string;
    title: string;
}

interface StoreState {
    activeProjectId: string | null;
    pendingWorkflow: PendingWorkflow | null;
}

function readInitialProjectId(): string | null {
    try {
        return window.localStorage.getItem(PROJECT_KEY);
    } catch {
        return null;
    }
}

const state: StoreState = {
    activeProjectId: readInitialProjectId(),
    pendingWorkflow: null,
};

const bus = new EventTarget();
const CHANGE = "change";

function emit(): void {
    bus.dispatchEvent(new Event(CHANGE));
}

function persistProject(id: string | null): void {
    try {
        if (id) window.localStorage.setItem(PROJECT_KEY, id);
        else window.localStorage.removeItem(PROJECT_KEY);
    } catch {
        /* ignore */
    }
}

export function getChatContext(): StoreState {
    return { ...state };
}

export function setActiveProjectId(id: string | null): void {
    if (state.activeProjectId === id) return;
    state.activeProjectId = id;
    persistProject(id);
    emit();
}

export function setPendingWorkflow(wf: PendingWorkflow | null): void {
    state.pendingWorkflow = wf;
    emit();
}

/** Read and clear the pending workflow. Chat tab calls this once it picks it up. */
export function consumePendingWorkflow(): PendingWorkflow | null {
    const wf = state.pendingWorkflow;
    if (wf) {
        state.pendingWorkflow = null;
        emit();
    }
    return wf;
}

export function useChatContext() {
    const [snapshot, setSnapshot] = useState<StoreState>(() => getChatContext());

    useEffect(() => {
        const handler = () => setSnapshot(getChatContext());
        bus.addEventListener(CHANGE, handler);
        return () => bus.removeEventListener(CHANGE, handler);
    }, []);

    const setProject = useCallback((id: string | null) => {
        setActiveProjectId(id);
    }, []);
    const setWorkflow = useCallback((wf: PendingWorkflow | null) => {
        setPendingWorkflow(wf);
    }, []);
    const consume = useCallback(() => consumePendingWorkflow(), []);

    return {
        activeProjectId: snapshot.activeProjectId,
        setActiveProjectId: setProject,
        pendingWorkflow: snapshot.pendingWorkflow,
        setPendingWorkflow: setWorkflow,
        consumePendingWorkflow: consume,
    };
}

// ---------------------------------------------------------------------------
// Tab switching helper. MainLayout listens for `mike.tab.switch` events on
// window with `detail` set to a TabId string. If the listener isn't wired
// yet (e.g. before MainLayout mounts), this is a no-op — the pending
// workflow is still set, so the user can switch manually.
// ---------------------------------------------------------------------------

export type TabSwitchTarget =
    | "chat"
    | "projects"
    | "tabular"
    | "workflows"
    | "track";

export function requestTabSwitch(target: TabSwitchTarget): void {
    try {
        window.dispatchEvent(
            new CustomEvent<TabSwitchTarget>("mike.tab.switch", {
                detail: target,
            }),
        );
    } catch {
        /* ignore */
    }
}
