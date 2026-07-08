import React from "react";
import { Check, FolderClosed, Loader2, RefreshCw } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import {
    requestTabSwitch,
    useChatContext,
} from "../contexts/ChatContextStore";
import { useTranslation } from "../i18n/I18nProvider";

export default function ProjectsTab() {
    const { projects, loading, error, refresh } = useProjects();
    const { activeProjectId, setActiveProjectId } = useChatContext();
    const t = useTranslation();

    const handleSelect = (id: string | null) => {
        setActiveProjectId(id);
        if (id) requestTabSwitch("chat");
    };

    return (
        <div className="h-full overflow-y-auto p-3 space-y-2">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-gray-700">
                    {t("projects.title")}
                </h2>
                <button
                    type="button"
                    onClick={refresh}
                    className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
                    disabled={loading}
                >
                    <RefreshCw
                        className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
                    />
                    {t("projects.refresh")}
                </button>
            </div>

            {activeProjectId ? (
                <button
                    type="button"
                    onClick={() => handleSelect(null)}
                    className="w-full text-left text-xs text-mike-600 hover:underline"
                >
                    {t("projects.detach")}
                </button>
            ) : null}

            {loading && projects.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
                </div>
            ) : null}

            {error ? <p className="text-xs text-red-600">{error}</p> : null}

            {projects.length === 0 && !loading ? (
                <p className="text-xs text-gray-500">
                    {t("projects.noProjectsHint")}
                </p>
            ) : null}

            <ul className="space-y-1">
                {projects.map((p) => {
                    const active = p.id === activeProjectId;
                    return (
                        <li key={p.id}>
                            <button
                                type="button"
                                onClick={() =>
                                    handleSelect(active ? null : p.id)
                                }
                                className={`w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left transition-colors ${
                                    active
                                        ? "bg-mike-50 text-mike-700"
                                        : "hover:bg-gray-50 text-gray-700"
                                }`}
                            >
                                <FolderClosed className="h-4 w-4 shrink-0" />
                                <span className="flex-1 truncate">
                                    {p.name}
                                </span>
                                {active ? (
                                    <Check className="h-4 w-4 text-mike-600" />
                                ) : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
