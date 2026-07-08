import React from "react";
import {
    BarChart3,
    FolderClosed,
    GitBranch,
    MessageSquare,
    PenLine,
} from "lucide-react";
import { useTranslation } from "../i18n/I18nProvider";

export type TabId = "chat" | "projects" | "tabular" | "workflows" | "track";

interface Props {
    active: TabId;
    onChange: (id: TabId) => void;
}

interface TabDef {
    id: TabId;
    labelKey: string;
    icon: React.ReactNode;
}

const TABS: TabDef[] = [
    {
        id: "chat",
        labelKey: "tabs.chat",
        icon: <MessageSquare className="h-[18px] w-[18px]" strokeWidth={1.75} />,
    },
    {
        id: "projects",
        labelKey: "tabs.projects",
        icon: <FolderClosed className="h-[18px] w-[18px]" strokeWidth={1.75} />,
    },
    {
        id: "tabular",
        labelKey: "tabs.tabular",
        icon: <BarChart3 className="h-[18px] w-[18px]" strokeWidth={1.75} />,
    },
    {
        id: "workflows",
        labelKey: "tabs.workflows",
        icon: <GitBranch className="h-[18px] w-[18px]" strokeWidth={1.75} />,
    },
    {
        id: "track",
        labelKey: "tabs.track",
        icon: <PenLine className="h-[18px] w-[18px]" strokeWidth={1.75} />,
    },
];

export default function BottomTabs({ active, onChange }: Props) {
    const t = useTranslation();
    return (
        <nav
            className="shrink-0 flex items-stretch border-t border-gray-200 bg-white/90 backdrop-blur-sm"
            style={{ height: 54 }}
            aria-label={t("nav.primary")}
        >
            {TABS.map((tab) => {
                const isActive = active === tab.id;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onChange(tab.id)}
                        aria-current={isActive ? "page" : undefined}
                        className={`group relative flex-1 flex flex-col items-center justify-center gap-0.5 px-1 transition-colors ${
                            isActive
                                ? "text-gray-900"
                                : "text-gray-400 hover:text-gray-700"
                        }`}
                    >
                        {isActive && (
                            <span
                                aria-hidden
                                className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-gray-900"
                            />
                        )}
                        {tab.icon}
                        <span
                            className={`text-[10px] leading-none whitespace-nowrap ${
                                isActive ? "font-semibold" : "font-medium"
                            }`}
                        >
                            {t(tab.labelKey)}
                        </span>
                    </button>
                );
            })}
        </nav>
    );
}
