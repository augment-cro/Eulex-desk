/**
 * Compact model picker for the add-in composer. Self-contained dropdown
 * (no headless-ui) since the task pane is narrow. Mirrors the model IDs
 * surfaced by the desktop frontend so chats are interchangeable.
 *
 * Availability comes from /user/profile (mapped via getAiKeys), and is
 * only used to dim entries the user hasn't configured a key for. We do
 * NOT block selection — the backend ultimately validates and falls back
 * gracefully if a key is missing.
 */

import React, { useEffect, useRef, useState } from "react";
import { getAiKeys } from "../lib/api";
import { useTranslation } from "../i18n/I18nProvider";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google";
}

export const MODELS: ModelOption[] = [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", group: "Anthropic" },
    {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        group: "Google",
    },
    {
        id: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        group: "Google",
    },
];

// Primary model. Backend ships with a server-level Anthropic key (via Secret
// Manager) so the add-in defaults to Claude Sonnet 5 even before the user
// has pasted their own key in /account/models.
export const DEFAULT_MODEL_ID = "claude-sonnet-5";
export const MODEL_STORAGE_KEY = "mike.lastModel";

type Availability = { anthropic: boolean; gemini: boolean };

function isAvailable(modelId: string, avail: Availability): boolean {
    const m = MODELS.find((x) => x.id === modelId);
    if (!m) return false;
    return m.group === "Anthropic" ? avail.anthropic : avail.gemini;
}

interface Props {
    value: string;
    onChange: (id: string) => void;
}

export default function ModelSelector({ value, onChange }: Props) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    // Default to "available" so the user isn't blocked from picking a model
    // before /user/profile finishes loading. The backend re-validates.
    const [avail, setAvail] = useState<Availability>({
        anthropic: true,
        gemini: true,
    });
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        getAiKeys()
            .then((keys) => {
                if (!alive) return;
                setAvail({
                    anthropic:
                        !!keys.anthropic?.enabled && !!keys.anthropic?.key,
                    gemini: !!keys.gemini?.enabled && !!keys.gemini?.key,
                });
            })
            .catch(() => {
                /* leave defaults; missing dot is non-fatal */
            });
        return () => {
            alive = false;
        };
    }, []);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        window.addEventListener("mousedown", handler);
        return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    const selected = MODELS.find((m) => m.id === value) ?? MODELS[0];
    const selectedAvail = isAvailable(selected.id, avail);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                title={
                    !selectedAvail
                        ? t("errors.apiKeyMissingForSelected")
                        : t("model.choose")
                }
                className={`flex items-center gap-1 px-2 h-7 rounded-md text-[11px] border transition-colors ${
                    open
                        ? "bg-gray-100 border-gray-300 text-gray-700"
                        : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                }`}
            >
                {!selectedAvail && (
                    <span
                        aria-label={t("errors.apiKeyMissing")}
                        className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"
                    />
                )}
                <span className="max-w-[110px] truncate">
                    {selected.label}
                </span>
                <svg
                    viewBox="0 0 12 12"
                    className={`w-2.5 h-2.5 shrink-0 transition-transform ${
                        open ? "rotate-180" : ""
                    }`}
                    fill="currentColor"
                >
                    <path d="M2 4l4 4 4-4z" />
                </svg>
            </button>

            {open && (
                <div className="absolute bottom-full mb-1 left-0 z-30 w-52 rounded-xl border border-gray-200 bg-white shadow-lg py-1">
                    {(["Anthropic", "Google"] as const).map((group, gi) => {
                        const items = MODELS.filter((m) => m.group === group);
                        return (
                            <div key={group}>
                                {gi > 0 && (
                                    <div className="my-1 border-t border-gray-100" />
                                )}
                                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider text-gray-400">
                                    {group}
                                </div>
                                {items.map((m) => {
                                    const ok = isAvailable(m.id, avail);
                                    const isSelected = m.id === value;
                                    return (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => {
                                                onChange(m.id);
                                                setOpen(false);
                                            }}
                                            className={`w-full flex items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-gray-50 ${
                                                isSelected
                                                    ? "bg-mike-50/50"
                                                    : ""
                                            }`}
                                        >
                                            {!ok && (
                                                <span
                                                    aria-label={t(
                                                        "errors.apiKeyMissing",
                                                    )}
                                                    className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"
                                                />
                                            )}
                                            <span
                                                className={`flex-1 truncate ${
                                                    ok
                                                        ? "text-gray-700"
                                                        : "text-gray-400"
                                                }`}
                                            >
                                                {m.label}
                                            </span>
                                            {isSelected && ok && (
                                                <span className="text-mike-500 text-[10px]">
                                                    ✓
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
