/**
 * Modal that lets the user pick an assistant workflow to invoke alongside
 * their next message. Fetches GET /workflows?type=assistant on open.
 */

import React, { useEffect, useMemo, useState } from "react";
import { listAssistantWorkflows, type MikeWorkflow } from "../lib/api";
import { useTranslation } from "../i18n/I18nProvider";

export interface PickedWorkflow {
    id: string;
    title: string;
    prompt_md: string | null;
}

interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (wf: PickedWorkflow) => void;
}

export default function WorkflowPickerModal({
    open,
    onClose,
    onSelect,
}: Props) {
    const [workflows, setWorkflows] = useState<MikeWorkflow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const t = useTranslation();

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        listAssistantWorkflows()
            .then((wfs) => {
                if (!cancelled) {
                    setWorkflows(wfs);
                    setLoading(false);
                }
            })
            .catch((e) => {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return workflows;
        return workflows.filter((w) => w.title.toLowerCase().includes(q));
    }, [workflows, query]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-40 flex flex-col bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 shrink-0">
                <h2 className="font-serif text-sm text-gray-800">
                    {t("workflowPicker.title")}
                </h2>
                <button
                    onClick={onClose}
                    className="text-xs text-gray-500 hover:text-gray-800"
                >
                    {t("common.cancel")}
                </button>
            </div>

            <div className="px-3 py-2 border-b border-gray-100 shrink-0">
                <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("workflowPicker.searchPlaceholder")}
                    className="w-full px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-mike-500 focus:border-transparent"
                />
            </div>

            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <div className="p-4 text-xs text-gray-400">
                        {t("common.loading")}
                    </div>
                ) : error ? (
                    <div className="p-4 text-xs text-red-600">
                        {t("common.error")}: {error}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="p-4 text-xs text-gray-400">
                        {query
                            ? t("workflows.noMatching")
                            : t("workflows.noWorkflowsLong")}
                    </div>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {filtered.map((w) => (
                            <li key={w.id}>
                                <button
                                    onClick={() =>
                                        onSelect({
                                            id: w.id,
                                            title: w.title,
                                            prompt_md: w.prompt_md ?? null,
                                        })
                                    }
                                    className="w-full text-left px-3 py-2 hover:bg-gray-50"
                                >
                                    <div className="text-sm font-medium text-gray-800 truncate">
                                        {w.title}
                                    </div>
                                    {w.prompt_md && (
                                        <div className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">
                                            {w.prompt_md.slice(0, 120)}
                                        </div>
                                    )}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
