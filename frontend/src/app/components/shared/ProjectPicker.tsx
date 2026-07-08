"use client";

import { useState } from "react";
import { Folder, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { MikeProject } from "./types";

interface Props {
    projects: MikeProject[];
    loading: boolean;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
}

export function ProjectPicker({ projects, loading, selectedId, onSelect }: Props) {
    const t = useTranslations("projectPicker");
    const [search, setSearch] = useState("");
    const q = search.toLowerCase().trim();
    const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

    return (
        <>
            <div className="px-4 pt-1 pb-2">
                <div className="flex items-center gap-2 rounded-lg border border-input bg-muted px-3 py-2">
                    <Search className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                    <input
                        type="text"
                        placeholder={t("searchPlaceholder")}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                        autoFocus
                    />
                    {search && (
                        <button onClick={() => setSearch("")} className="text-muted-foreground/70 hover:text-muted-foreground">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-2">
                {loading ? (
                    <div className="rounded-sm border border-border overflow-hidden">
                        <div className="flex items-center px-2 py-2">
                            <div className="h-3 w-14 rounded bg-secondary animate-pulse" />
                        </div>
                        {[65, 45, 80, 55, 70].map((w, i) => (
                            <div key={i} className="flex items-center gap-2 px-2 py-2">
                                <div className="h-3.5 w-3.5 rounded-full border border-border shrink-0" />
                                <div className="h-3.5 w-3.5 rounded bg-secondary animate-pulse shrink-0" />
                                <div className="h-3 rounded bg-secondary animate-pulse" style={{ width: `${w}%` }} />
                            </div>
                        ))}
                    </div>
                ) : filtered.length === 0 ? (
                    <p className="text-center text-sm text-muted-foreground/70 py-8">
                        {q ? t("noMatches") : t("noProjects")}
                    </p>
                ) : (
                    <div className="rounded-sm border border-border overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-2">
                            <p className="text-xs font-medium text-muted-foreground/70">
                                {t("groupHeading")}
                            </p>
                        </div>
                        <div className="space-y-px">
                            {filtered.map((project) => {
                                const isSelected = selectedId === project.id;
                                return (
                                    <button
                                        key={project.id}
                                        onClick={() => onSelect(isSelected ? null : project.id)}
                                        className={`w-full flex items-center gap-2 px-2 py-2 text-xs transition-colors text-left ${isSelected ? "bg-secondary" : "hover:bg-accent"}`}
                                    >
                                        <span className={`shrink-0 h-3.5 w-3.5 rounded-full border flex items-center justify-center ${isSelected ? "bg-primary border-primary" : "border-input"}`}>
                                            {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />}
                                        </span>
                                        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                                        <span className={`flex-1 truncate ${isSelected ? "text-foreground font-medium" : "text-foreground"}`}>
                                            {project.name}
                                            {project.cm_number && (
                                                <span className="ml-1 font-normal text-muted-foreground/70">(#{project.cm_number})</span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-muted-foreground/70">{project.document_count ?? 0}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
