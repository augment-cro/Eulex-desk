/**
 * Modal that lets the user attach project documents to the next chat
 * message. Always offers a "Current Word document" pseudo-entry at the
 * top, and lists docs from the active project (or every project as a
 * fallback when no project is active).
 */

import React, { useEffect, useMemo, useState } from "react";
import {
    getProject,
    listProjects,
    listProjectDocuments,
    type ApiDocument,
} from "../lib/api";
import { useTranslation } from "../i18n/I18nProvider";
import { normalizeFilenameForDisplay } from "../lib/filenameUtf8";

export interface DocRef {
    /** undefined for the live Word document — handled at send time. */
    document_id?: string;
    filename: string;
    /** Helper flag for the special current-document chip. */
    isCurrentDoc?: boolean;
}

interface Props {
    open: boolean;
    activeProjectId: string | null;
    initialSelected?: DocRef[];
    onClose: () => void;
    onConfirm: (refs: DocRef[]) => void;
}

interface ProjectGroup {
    projectId: string;
    projectName: string;
    documents: ApiDocument[];
}

export default function DocumentPickerModal({
    open,
    activeProjectId,
    initialSelected = [],
    onClose,
    onConfirm,
}: Props) {
    const [groups, setGroups] = useState<ProjectGroup[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const t = useTranslation();

    const initialKeys = useMemo(() => {
        const s = new Set<string>();
        for (const r of initialSelected) {
            s.add(r.isCurrentDoc ? "__current__" : (r.document_id ?? ""));
        }
        return s;
    }, [initialSelected]);
    const [selected, setSelected] = useState<Set<string>>(
        new Set(initialKeys),
    );

    useEffect(() => {
        if (!open) return;
        setSelected(new Set(initialKeys));
        setLoading(true);
        setError(null);

        let cancelled = false;
        const load = async () => {
            try {
                if (activeProjectId) {
                    const proj = await getProject(activeProjectId);
                    let docs = proj.documents;
                    if (!docs) {
                        docs = await listProjectDocuments(activeProjectId);
                    }
                    if (cancelled) return;
                    setGroups([
                        {
                            projectId: proj.id,
                            projectName: proj.name,
                            documents: docs ?? [],
                        },
                    ]);
                } else {
                    const projects = await listProjects();
                    const all = await Promise.all(
                        projects.map(async (p) => ({
                            projectId: p.id,
                            projectName: p.name,
                            documents: await listProjectDocuments(p.id).catch(
                                () => [],
                            ),
                        })),
                    );
                    if (!cancelled) setGroups(all);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : String(e));
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [open, activeProjectId, initialKeys]);

    if (!open) return null;

    const toggle = (key: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const confirm = () => {
        const refs: DocRef[] = [];
        if (selected.has("__current__")) {
            refs.push({
                filename: t("documentPicker.currentDoc"),
                isCurrentDoc: true,
            });
        }
        for (const g of groups) {
            for (const d of g.documents) {
                if (selected.has(d.id)) {
                    refs.push({ document_id: d.id, filename: d.filename });
                }
            }
        }
        onConfirm(refs);
    };

    return (
        <div className="fixed inset-0 z-40 flex flex-col bg-white">
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 shrink-0">
                <h2 className="font-serif text-sm text-gray-800">
                    {t("documentPicker.title")}
                </h2>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClose}
                        className="text-xs text-gray-500 hover:text-gray-800"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        onClick={confirm}
                        className="text-xs px-2.5 py-1 rounded-md bg-mike-500 text-white hover:bg-mike-600"
                    >
                        {t("documentPicker.attachWithCount", {
                            count: selected.size,
                        })}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <label className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 cursor-pointer hover:bg-gray-50">
                    <input
                        type="checkbox"
                        checked={selected.has("__current__")}
                        onChange={() => toggle("__current__")}
                        className="accent-mike-500"
                    />
                    <div className="flex-1 min-w-0">
                        <div className="text-sm text-gray-800">
                            {t("documentPicker.currentDoc")}
                        </div>
                        <div className="text-[10px] text-gray-400">
                            {t("documentPicker.currentDocHint")}
                        </div>
                    </div>
                </label>

                {loading ? (
                    <div className="p-4 text-xs text-gray-400">
                        {t("documentPicker.loading")}
                    </div>
                ) : error ? (
                    <div className="p-4 text-xs text-red-600">
                        {t("documentPicker.loadFailed")}: {error}
                    </div>
                ) : groups.length === 0 ? (
                    <div className="p-4 text-xs text-gray-400">
                        {t("documentPicker.noProjects")}
                    </div>
                ) : (
                    groups.map((g) => (
                        <div key={g.projectId}>
                            <div className="px-3 py-1 bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                                {g.projectName}
                            </div>
                            {g.documents.length === 0 ? (
                                <div className="px-3 py-2 text-[11px] text-gray-400">
                                    {t("documentPicker.noDocs")}
                                </div>
                            ) : (
                                <ul>
                                    {g.documents.map((d) => (
                                        <li key={d.id}>
                                            <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-gray-50">
                                                <input
                                                    type="checkbox"
                                                    checked={selected.has(
                                                        d.id,
                                                    )}
                                                    onChange={() =>
                                                        toggle(d.id)
                                                    }
                                                    className="accent-mike-500"
                                                />
                                                <span className="text-xs text-gray-700 truncate flex-1">
                                                    {normalizeFilenameForDisplay(
                                                        d.filename,
                                                    )}
                                                </span>
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
