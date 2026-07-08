import React from "react";
import type { EditMode } from "../lib/wordComments";
import { useTranslation } from "../i18n/I18nProvider";

interface Props {
    value: EditMode;
    onChange: (next: EditMode) => void;
    className?: string;
    disabled?: boolean;
}

/**
 * Compact pill-style segmented control letting the user pick how the
 * assistant's proposed edits should land in the document:
 *   - "track":    apply as Word tracked changes (existing behavior)
 *   - "comments": attach as Word comments anchored to the original text
 *
 * Persistence is the parent's responsibility — the toggle is fully
 * controlled, so the composer can drop it into a top-bar with the
 * model picker without coupling concerns.
 */
export default function EditModeToggle({
    value,
    onChange,
    className,
    disabled,
}: Props) {
    const t = useTranslation();
    const options: { id: EditMode; label: string; title: string }[] = [
        {
            id: "track",
            label: t("chat.trackChanges"),
            title: t("chat.trackChanges"),
        },
        {
            id: "comments",
            label: t("chat.comments"),
            title: t("chat.comments"),
        },
    ];

    return (
        <div
            role="radiogroup"
            aria-label={t("nav.editMode")}
            className={`inline-flex items-center bg-gray-100 rounded-full p-0.5 ${
                className ?? ""
            }`}
        >
            {options.map((opt) => {
                const active = value === opt.id;
                return (
                    <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled}
                        title={opt.title}
                        onClick={() => {
                            if (!active) onChange(opt.id);
                        }}
                        className={`px-2.5 py-0.5 text-[11px] font-medium rounded-full transition-colors disabled:opacity-40 ${
                            active
                                ? "bg-white text-mike-700 shadow-sm"
                                : "text-gray-500 hover:text-gray-700"
                        }`}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}
