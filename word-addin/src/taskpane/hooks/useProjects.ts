import { useCallback, useEffect, useState } from "react";
import { listProjects, type ApiProject } from "../lib/api";

interface State {
    projects: ApiProject[];
    loading: boolean;
    error: string | null;
}

export function useProjects() {
    const [state, setState] = useState<State>({
        projects: [],
        loading: true,
        error: null,
    });

    const refresh = useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        try {
            const projects = await listProjects();
            setState({ projects, loading: false, error: null });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to load projects";
            setState({ projects: [], loading: false, error: message });
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    return { ...state, refresh };
}
