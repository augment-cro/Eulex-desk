import React, { useMemo, useState } from "react";
import { useProjects } from "../hooks/useProjects";
import { useTabularReview, useTabularReviews } from "../hooks/useTabular";
import { API_BASE } from "../lib/api";
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

function formatDate(s: string | null | undefined): string {
    if (!s) return "—";
    try {
        const d = new Date(s);
        return d.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
        });
    } catch {
        return s;
    }
}

/**
 * The web frontend exposes tabular reviews on the same origin the add-in
 * is hosted from. Open them in a new tab — Office task panes can navigate
 * the host browser via plain `window.open` even though they can't open
 * in-Word popups.
 */
function frontendOriginFromApiBase(): string {
    try {
        return new URL(API_BASE).origin;
    } catch {
        return "";
    }
}

function ReviewDetail({
    reviewId,
    onBack,
}: {
    reviewId: string;
    onBack: () => void;
}) {
    const { detail, loading, error } = useTabularReview(reviewId);
    const t = useTranslation();

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="flex items-center gap-2 px-3 pt-3 pb-1">
                <button
                    onClick={onBack}
                    className="text-gray-500 hover:text-gray-900 p-1 -ml-1"
                    title={t("tabular.back")}
                >
                    <ChevronLeft />
                </button>
                <span className="text-xs text-gray-400">
                    {t("tabular.title")}
                </span>
            </div>
            {loading ? (
                <div className="text-sm text-gray-400 px-4 py-6">
                    {t("tabular.loading")}
                </div>
            ) : error ? (
                <div className="text-sm text-red-500 px-4 py-6">{error}</div>
            ) : !detail ? null : (
                <div className="px-4 py-2">
                    <h2 className="font-serif text-xl text-gray-900">
                        {detail.review.title || t("tabular.untitled")}
                    </h2>
                    <div className="text-xs text-gray-500 mt-1">
                        {t("tabular.updated", {
                            date: formatDate(detail.review.updated_at),
                        })}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                        <div className="bg-white border border-gray-200 rounded-2xl p-3">
                            <div className="text-[10px] text-gray-400 uppercase tracking-wide">
                                {t("tabular.documents")}
                            </div>
                            <div className="font-serif text-lg text-gray-900 mt-0.5">
                                {detail.documents.length}
                            </div>
                        </div>
                        <div className="bg-white border border-gray-200 rounded-2xl p-3">
                            <div className="text-[10px] text-gray-400 uppercase tracking-wide">
                                {t("tabular.columns")}
                            </div>
                            <div className="font-serif text-lg text-gray-900 mt-0.5">
                                {detail.review.columns_config?.length ?? 0}
                            </div>
                        </div>
                    </div>

                    {detail.review.columns_config &&
                    detail.review.columns_config.length > 0 ? (
                        <div className="mt-4">
                            <div className="text-xs text-gray-500 mb-2 px-1">
                                {t("tabular.columns")}
                            </div>
                            <div className="flex flex-col gap-1.5">
                                {detail.review.columns_config.map((c, i) => (
                                    <div
                                        key={i}
                                        className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 truncate"
                                    >
                                        {c.name ||
                                            t("tabular.columnFallback", {
                                                index: i + 1,
                                            })}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    <a
                        href={`${frontendOriginFromApiBase()}/tabular-reviews/${detail.review.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full mt-4 text-sm rounded-2xl px-4 py-2 border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-center"
                    >
                        {t("tabular.openInBrowser")}
                    </a>
                </div>
            )}
        </div>
    );
}

export default function TabularTab() {
    const { projects } = useProjects();
    const t = useTranslation();
    const [projectId, setProjectId] = useState<string | "all">("all");
    const [openId, setOpenId] = useState<string | null>(null);

    const effective = projectId === "all" ? null : projectId;
    const { reviews, loading, error } = useTabularReviews(effective);

    const sorted = useMemo(
        () =>
            [...reviews].sort((a, b) =>
                (b.updated_at || "").localeCompare(a.updated_at || ""),
            ),
        [reviews],
    );

    if (openId) {
        return (
            <ReviewDetail reviewId={openId} onBack={() => setOpenId(null)} />
        );
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="px-3 pt-3 pb-2">
                <h2 className="font-serif text-xl text-gray-900 px-1 mb-2">
                    {t("tabular.title")}
                </h2>
                <select
                    value={projectId}
                    onChange={(e) =>
                        setProjectId(e.target.value as string | "all")
                    }
                    className="w-full text-sm rounded-2xl border border-gray-200 bg-white px-3 py-2 text-gray-800 focus:outline-none focus:border-gray-400"
                >
                    <option value="all">{t("tabular.allProjects")}</option>
                    {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
                {loading ? (
                    <div className="flex items-center justify-center py-10 text-sm text-gray-400">
                        {t("tabular.loading")}
                    </div>
                ) : error ? (
                    <div className="flex items-center justify-center py-10 text-sm text-red-500 px-6 text-center">
                        {error}
                    </div>
                ) : sorted.length === 0 ? (
                    <div className="flex items-center justify-center py-10 text-sm text-gray-500 px-6 text-center">
                        {t("tabular.noReviewsLong")}
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {sorted.map((r) => (
                            <button
                                key={r.id}
                                onClick={() => setOpenId(r.id)}
                                className="text-left bg-white border border-gray-200 rounded-2xl p-4 hover:bg-gray-50 cursor-pointer transition-colors"
                            >
                                <div className="font-serif text-base text-gray-900 truncate">
                                    {r.title || t("tabular.untitled")}
                                </div>
                                <div className="text-xs text-gray-400 mt-1 flex items-center gap-2">
                                    <span>{formatDate(r.updated_at)}</span>
                                    {typeof r.document_count === "number" ? (
                                        <>
                                            <span>·</span>
                                            <span>
                                                {r.document_count === 1
                                                    ? t(
                                                          "tabular.documentCountOne",
                                                          {
                                                              count: r.document_count,
                                                          },
                                                      )
                                                    : t(
                                                          "tabular.documentCountOther",
                                                          {
                                                              count: r.document_count,
                                                          },
                                                      )}
                                            </span>
                                        </>
                                    ) : null}
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
