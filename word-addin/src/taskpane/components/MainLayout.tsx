import React, { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import BottomTabs, { type TabId } from "./BottomTabs";
import ChatPanel from "./ChatPanel";
import ProjectsTab from "./ProjectsTab";
import TabularTab from "./TabularTab";
import WorkflowsTab from "./WorkflowsTab";
import TrackChangesPanel from "./TrackChangesPanel";
import ErrorBoundary from "./ErrorBoundary";
import { useMcpServers } from "../hooks/useMcpServers";
import { useTranslation } from "../i18n/I18nProvider";

const TAB_IDS: TabId[] = [
    "chat",
    "projects",
    "tabular",
    "workflows",
    "track",
];

export default function MainLayout() {
    const [activeTab, setActiveTab] = useState<TabId>("chat");
    const { logout } = useAuth();
    const t = useTranslation();
    // MCP connector toggles live in ChatInput (Plug icon, Eulex Desk web parity).
    //
    // Gated by `true` because MainLayout only mounts after auth (App.tsx
    // renders <Login /> otherwise).
    const {
        userServers: mcpUserServers,
        builtinServers: mcpBuiltinServers,
        loading: mcpLoading,
        refresh: mcpRefresh,
    } = useMcpServers(true);

    // Cross-tab switch event from WorkflowsTab → "Use in chat" handoff,
    // and from ProjectsTab → "select" focusing the chat composer. Other
    // surfaces dispatch a window CustomEvent `mike.tab.switch` with detail
    // set to the target TabId.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<TabId>).detail;
            if (TAB_IDS.includes(detail)) setActiveTab(detail);
        };
        window.addEventListener("mike.tab.switch", handler);
        return () => window.removeEventListener("mike.tab.switch", handler);
    }, []);

    return (
        <div className="flex flex-col h-screen bg-white text-gray-900">
            {/* Thin top bar that hugs Office's own task-pane chrome.
                Office owns the title strip with the X close button; we
                cannot inject buttons into it (Microsoft locks down the
                pane chrome for security). Instead this bar sits flush
                against it, with Sign-out aligned to the same right edge
                as Office's X — so the user reads them as one chrome row.
                Sign-out is NOT what X does:
                  • X (Office) — closes the task pane; pairing/JWT survive.
                  • Sign-out (this button) — clears the JWT from
                    localStorage; user must re-pair on next launch.
                Tooltip restates that so first-time users don't conflate
                them. We keep this as a real bar (h-7 bg-white border-b)
                instead of a floating absolute button because the chat
                bubble used to render under the absolute button and the
                composite was unreadable (see screenshot from 2026-05-12).
            */}
            <header className="shrink-0 flex items-center justify-end h-7 px-1.5 border-b border-gray-100 bg-white">
                <button
                    onClick={logout}
                    title={t("common.signOutTooltip")}
                    aria-label={t("common.signOut")}
                    className="inline-flex items-center gap-1 px-1.5 h-5 text-[11px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                >
                    <LogOut className="h-3 w-3" />
                    {t("common.signOut")}
                </button>
            </header>

            {/*
              Mount ALL tabs once and toggle visibility via CSS instead of
              conditional rendering, so each tab's local state (chat
              messages + chatId, drilled-in workflow, project selection,
              tabular review filter, etc.) survives a side-trip to another
              tab. Conditional render unmounts the chat panel and the user
              loses their messages every time they switch.

              Only ChatPanel currently needs MCP connector state (Plug menu
              in the composer); the other tabs ignore the props.
            */}
            <main className="flex-1 min-h-0 overflow-hidden">
                <div hidden={activeTab !== "chat"} className="h-full">
                    <ErrorBoundary>
                        <ChatPanel
                            mcpUserServers={mcpUserServers}
                            mcpBuiltinServers={mcpBuiltinServers}
                            mcpLoading={mcpLoading}
                            mcpRefresh={mcpRefresh}
                        />
                    </ErrorBoundary>
                </div>
                <div hidden={activeTab !== "projects"} className="h-full">
                    <ErrorBoundary>
                        <ProjectsTab />
                    </ErrorBoundary>
                </div>
                <div hidden={activeTab !== "tabular"} className="h-full">
                    <ErrorBoundary>
                        <TabularTab />
                    </ErrorBoundary>
                </div>
                <div hidden={activeTab !== "workflows"} className="h-full">
                    <ErrorBoundary>
                        <WorkflowsTab />
                    </ErrorBoundary>
                </div>
                <div hidden={activeTab !== "track"} className="h-full">
                    <ErrorBoundary>
                        <TrackChangesPanel />
                    </ErrorBoundary>
                </div>
            </main>

            <BottomTabs active={activeTab} onChange={setActiveTab} />
        </div>
    );
}
