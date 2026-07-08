/**
 * Fetches the user's workflow list (GET /workflows). Filtered to a single
 * type by default so the assistant tab shows only assistant workflows
 * (`type=assistant`), the tabular tab only tabular ones, etc.
 */

import { useEffect, useMemo, useState } from "react";
import { listWorkflows, type ApiWorkflow } from "../lib/api";

export interface WorkflowsState {
    workflows: ApiWorkflow[];
    loading: boolean;
    error: string | null;
}

export function useWorkflows(
    typeFilter: "assistant" | "tabular" | "all" = "assistant",
): WorkflowsState {
    const [all, setAll] = useState<ApiWorkflow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        const fetcher =
            typeFilter === "all"
                ? listWorkflows()
                : listWorkflows(typeFilter);
        fetcher
            .then((rows) => {
                if (!cancelled) setAll(rows);
            })
            .catch((e) => {
                if (!cancelled) {
                    setError(
                        e instanceof Error
                            ? e.message
                            : "Failed to load workflows",
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [typeFilter]);

    const workflows = useMemo(() => {
        if (typeFilter === "all") return all;
        return all.filter((w) => w.type === typeFilter);
    }, [all, typeFilter]);

    return { workflows, loading, error };
}
