import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useWorkflows } from "../hooks/useWorkflows";
import {
    requestTabSwitch,
    useChatContext,
} from "../contexts/ChatContextStore";
import { useTranslation } from "../i18n/I18nProvider";

function ChevronLeft() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    );
}

function preview(md: string | null | undefined, n = 80): string {
    if (!md) return "";
    const flat = md.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

export default function WorkflowsTab() {
    const { workflows, loading, error } = useWorkflows("assistant");
    const [query, setQuery] = useState("");
    const [openId, setOpenId] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const { setPendingWorkflow } = useChatContext();
    const t = useTranslation();

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return workflows;
        return workflows.filter(
            (w) =>
                w.title.toLowerCase().includes(q) ||
                (w.prompt_md || "").toLowerCase().includes(q),
        );
    }, [workflows, query]);

    const open = openId
        ? workflows.find((w) => w.id === openId) || null
        : null;

    function handleUseInChat(wf: { id: string; title: string }) {
        setPendingWorkflow({ id: wf.id, title: wf.title });
        requestTabSwitch("chat");
        setToast(t("workflows.readyToast"));
        window.setTimeout(() => setToast(null), 3000);
    }

    if (open) {
        return (
            <div className="flex flex-col h-full overflow-y-auto relative">
                <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                    <button
                        onClick={() => setOpenId(null)}
                        className="text-gray-500 hover:text-gray-900 p-1 -ml-1"
                        title={t("workflows.back")}
                    >
                        <ChevronLeft />
                    </button>
                    <span className="text-xs text-gray-400">
                        {t("workflows.title")}
                    </span>
                </div>
                <div className="px-4 py-2">
                    <h2 className="font-serif text-xl text-gray-900">
                        {open.title}
                    </h2>
                    {open.practice ? (
                        <div className="text-xs text-gray-500 mt-0.5">
                            {open.practice}
                        </div>
                    ) : null}
                </div>
                <div className="px-3 pb-2">
                    <button
                        onClick={() =>
                            handleUseInChat({ id: open.id, title: open.title })
                        }
                        className="w-full text-sm rounded-2xl px-4 py-2 bg-gray-900 text-white hover:bg-gray-800 transition-colors"
                    >
                        {t("workflows.useInChat")}
                    </button>
                </div>
                <div className="px-4 py-2 text-sm text-gray-800 prose prose-sm max-w-none">
                    {open.prompt_md ? (
                        <ReactMarkdown>{open.prompt_md}</ReactMarkdown>
                    ) : (
                        <div className="text-xs text-gray-400">
                            {t("workflows.noPromptBody")}
                        </div>
                    )}
                </div>
                {toast ? <Toast text={toast} /> : null}
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-hidden relative">
            <div className="px-3 pt-3 pb-2">
                <h2 className="font-serif text-xl text-gray-900 px-1 mb-2">
                    {t("workflows.title")}
                </h2>
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("workflows.searchPlaceholder")}
                    className="w-full text-sm rounded-2xl border border-gray-200 bg-white px-3 py-2 text-gray-800 placeholder:text-gray-400 focus:outline-none focus:border-gray-400"
                />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
                {loading ? (
                    <div className="flex items-center justify-center py-10 text-sm text-gray-400">
                        {t("workflows.loading")}
                    </div>
                ) : error ? (
                    <div className="flex items-center justify-center py-10 text-sm text-red-500 px-6 text-center">
                        {error}
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex items-center justify-center py-10 text-sm text-gray-500 px-6 text-center">
                        {query
                            ? t("workflows.noMatching")
                            : t("workflows.noWorkflowsLong")}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {filtered.map((w) => (
                            <button
                                key={w.id}
                                onClick={() => setOpenId(w.id)}
                                className="text-left bg-white border border-gray-200 rounded-2xl p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                            >
                                <div className="font-serif text-base text-gray-900 truncate">
                                    {w.title}
                                </div>
                                <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                                    {preview(w.prompt_md)}
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {toast ? <Toast text={toast} /> : null}
        </div>
    );
}

function Toast({ text }: { text: string }) {
    return (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs rounded-2xl px-4 py-2 shadow-lg">
            {text}
        </div>
    );
}
