"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
    PanelLeft,
    MessageSquare,
    FolderOpen,
    Table2,
    Library,
    Layers,
    User,
    ChevronsUpDown,
    ChevronDown,
    Archive,
    ArrowLeft,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
    SidebarChatGroup,
    SidebarArchivedGroupRow,
} from "@/app/components/shared/SidebarChatGroup";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MikeChat } from "@/app/components/shared/types";
import { LanguageSwitcher } from "@/app/components/shared/LanguageSwitcher";
import { ThemeSwitcher } from "@/app/components/shared/ThemeSwitcher";
import { contextsServiceEnabled, listProjects } from "@/app/lib/mikeApi";

const NAV_ITEMS = [
    { href: "/assistant", labelKey: "assistant" as const, icon: MessageSquare },
    { href: "/projects", labelKey: "projects" as const, icon: FolderOpen },
    { href: "/tabular-reviews", labelKey: "tabularReview" as const, icon: Table2 },
    { href: "/workflows", labelKey: "workflows" as const, icon: Library },
    // Contexts only when a contexts service is configured (feature dormant
    // otherwise).
    ...(contextsServiceEnabled()
        ? [{ href: "/contexts", labelKey: "contexts" as const, icon: Layers }]
        : []),
];

interface AppSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
}

// How many rows the Ungrouped / archived lists show before "Show more"
// (each click reveals another page). Pinned + named groups render fully.
const HISTORY_PAGE_SIZE = 20;
const COLLAPSED_GROUPS_KEY = "mike.sidebar.collapsedGroups";

// Horizontal resize (drag handle on the right edge, persisted per browser).
const SIDEBAR_WIDTH_KEY = "mike.sidebar.width";
const SIDEBAR_MIN_WIDTH = 208;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 256;

function clampSidebarWidth(w: number): number {
    return Math.min(Math.max(w, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
}

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const {
        chats,
        currentChatId,
        setCurrentChatId,
        groups,
        archivedChats,
        historyView,
        setHistoryView,
    } = useChatHistoryContext();
    const router = useRouter();
    const pathname = usePathname();
    const t = useTranslations("sidebar");
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
    // Sidebar width: lazy localStorage read (client-only render, see
    // collapsedGroups below); persisted when a drag ends.
    const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
        if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
        try {
            const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
            if (Number.isFinite(raw) && raw > 0)
                return clampSidebarWidth(raw);
        } catch {
            // localStorage unavailable — default width.
        }
        return SIDEBAR_DEFAULT_WIDTH;
    });
    const [isResizing, setIsResizing] = useState(false);
    // Group-collapse state survives reloads (per-browser, not synced).
    // Lazy initializer: the sidebar only renders for an authed user, i.e.
    // client-side, so reading localStorage here is hydration-safe.
    const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => {
        if (typeof window === "undefined") return [];
        try {
            const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
            if (raw) {
                const parsed: unknown = JSON.parse(raw);
                if (
                    Array.isArray(parsed) &&
                    parsed.every((x) => typeof x === "string")
                )
                    return parsed as string[];
            }
        } catch {
            // localStorage unavailable / corrupt — start expanded.
        }
        return [];
    });
    const [visibleCount, setVisibleCount] = useState(HISTORY_PAGE_SIZE);
    const [projectNames, setProjectNames] = useState<Record<string, string>>(
        {},
    );

    // Drag-to-resize: pointer listeners live on document for the duration
    // of a drag so the handle can't be "lost" on fast moves. The sidebar
    // is anchored at the viewport's left edge, so clientX IS the width.
    useEffect(() => {
        if (!isResizing) return;
        const onMove = (e: PointerEvent) =>
            setSidebarWidth(clampSidebarWidth(e.clientX));
        const onUp = () => setIsResizing(false);
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        const prevCursor = document.body.style.cursor;
        const prevSelect = document.body.style.userSelect;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.body.style.cursor = prevCursor;
            document.body.style.userSelect = prevSelect;
        };
    }, [isResizing]);

    // Persist the width when a drag ends (not per pointermove).
    useEffect(() => {
        if (isResizing) return;
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
        } catch {
            // Persisting is best-effort.
        }
    }, [isResizing, sidebarWidth]);

    const toggleGroupCollapsed = useCallback((groupId: string) => {
        setCollapsedGroups((prev) => {
            const next = prev.includes(groupId)
                ? prev.filter((id) => id !== groupId)
                : [...prev, groupId];
            try {
                localStorage.setItem(
                    COLLAPSED_GROUPS_KEY,
                    JSON.stringify(next),
                );
            } catch {
                // Persisting is best-effort.
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (!user) return;
        listProjects()
            .then((projects) => {
                const map: Record<string, string> = {};
                for (const p of projects) map[p.id] = p.name;
                setProjectNames(map);
            })
            .catch(() => {});
    }, [user]);

    useEffect(() => {
        if (!isOpen) setShouldAnimate(true);
    }, [isOpen]);

    useEffect(() => {
        const handleClickOutside = () => setIsDropdownOpen(false);
        if (isDropdownOpen) {
            document.addEventListener("click", handleClickOutside);
            return () =>
                document.removeEventListener("click", handleClickOutside);
        }
    }, [isDropdownOpen]);

    useEffect(() => {
        if (pathname.startsWith("/assistant/chat/")) {
            const chatId = pathname.split("/").pop() ?? null;
            setCurrentChatId(chatId);
            return;
        }

        const projectChatMatch = pathname.match(
            /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
        );
        if (projectChatMatch) {
            setCurrentChatId(projectChatMatch[1]);
            return;
        }

        if (pathname === "/assistant") {
            setCurrentChatId(null);
        }
    }, [pathname, setCurrentChatId]);

    const getUserInitials = (email: string) => {
        if (profile?.displayName)
            return profile.displayName.charAt(0).toUpperCase();
        return email.charAt(0).toUpperCase();
    };

    const getDisplayName = () => {
        if (!profile) return "";
        return profile.displayName || user?.email?.split("@")[0] || "";
    };

    const getUserTier = () => {
        if (!profile) return "";
        return profile.tier || "Free";
    };

    // Derived history sections (tracker #13), memoized so unrelated
    // sidebar state (dropdown, animation, route) doesn't re-filter up to
    // 500 chats per render. A chat whose group is archived but which was
    // individually restored renders as ungrouped so it can't silently
    // disappear from the active view.
    const {
        activeChats,
        activeGroups,
        archivedGroups,
        pinnedChats,
        ungroupedChats,
        chatsByGroup,
        hasSections,
    } = useMemo(() => {
        const activeChats = chats ?? [];
        const allGroups = groups ?? [];
        const activeGroups = allGroups.filter((g) => g.status === "active");
        const archivedGroups = allGroups.filter(
            (g) => g.status === "archived",
        );
        const activeGroupIds = new Set(activeGroups.map((g) => g.id));
        const pinnedChats = activeChats.filter((c) => c.pinned);
        const ungroupedChats: MikeChat[] = [];
        const chatsByGroup = new Map<string, MikeChat[]>();
        for (const c of activeChats) {
            if (c.pinned) continue;
            if (c.group_id && activeGroupIds.has(c.group_id)) {
                const list = chatsByGroup.get(c.group_id) ?? [];
                list.push(c);
                chatsByGroup.set(c.group_id, list);
            } else {
                ungroupedChats.push(c);
            }
        }
        return {
            activeChats,
            activeGroups,
            archivedGroups,
            pinnedChats,
            ungroupedChats,
            chatsByGroup,
            hasSections:
                pinnedChats.length > 0 || activeGroups.length > 0,
        };
    }, [chats, groups]);

    if (!user) return null;

    // The section (and its Archived toggle) renders as soon as the list
    // has loaded — even when empty. Gating on content would strand a user
    // who archived every chat: after a reload nothing would offer the way
    // into the archived view.
    const showHistory = chats !== null;

    const renderChatItem = (
        chat: MikeChat,
        view: "active" | "archived" = "active",
    ) => (
        <SidebarChatItem
            key={chat.id}
            chat={chat}
            view={view}
            isActive={currentChatId === chat.id}
            projectName={
                chat.project_id ? projectNames[chat.project_id] : undefined
            }
            onSelect={() => {
                setCurrentChatId(chat.id);
                router.push(
                    chat.project_id
                        ? `/projects/${chat.project_id}/assistant/chat/${chat.id}`
                        : `/assistant/chat/${chat.id}`,
                );
            }}
        />
    );

    // Matches the global button typography (Azeret Mono 500 / 12px /
    // uppercase / 0.1em) so <div> headings like "Pinned" render exactly
    // like the <button> group headings, and px-3 lines every heading up
    // with the chat-row titles.
    const sectionHeadingClass =
        "px-3 py-1.5 text-xs font-mono font-medium uppercase tracking-widest text-muted-foreground";

    const renderShowMore = (total: number) =>
        total > visibleCount ? (
            <Button
                variant="ghost"
                onClick={() => setVisibleCount((v) => v + HISTORY_PAGE_SIZE)}
                className="w-full h-8 px-3 justify-start text-sm font-normal text-muted-foreground hover:text-foreground"
            >
                {t("showMore")}
            </Button>
        ) : null;

    return (
        <div
            // Persisted drag width is a desktop affordance; on mobile the
            // sidebar is an absolute overlay, so cap it below the viewport.
            style={isOpen ? { width: sidebarWidth, maxWidth: "min(480px, 85vw)" } : undefined}
            className={cn(
                // Closed on mobile: unmount from layout entirely. Previously
                // the closed sidebar stayed as a transparent absolute
                // z-[99] overlay whose nav wrappers kept their padding, so
                // it sat on top of the hamburger in the mobile header and
                // swallowed taps (iOS Safari bug, Teams BugFix 2026-09-08).
                isOpen
                    ? "flex h-dvh bg-muted"
                    : "hidden md:flex w-14 md:h-dvh md:bg-muted",
                "border-border flex-col absolute md:relative z-[99] overflow-visible",
                // The open/close animation fights pointer-driven width
                // changes — suspend it while dragging.
                !isResizing && "transition-all duration-300",
            )}
        >
            {/* Toggle + Logo — h-20 with centered logo matches eulex-www's
                header (border-b h-20), so the EULEX mark sits at the same
                vertical position as on the website. */}
            <div
                className={`h-20 items-center justify-between px-2.5 ${
                    !isOpen ? "hidden md:flex" : "flex"
                }`}
            >
                {isOpen && (
                    <div className="px-2.5">
                        <Link
                            href="/assistant"
                            className="flex items-center hover:opacity-80 transition-opacity leading-none"
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src="/eulex-logo.svg"
                                alt="EULEX"
                                /* size matches eulex-www LogoImage: w-32 h-auto object-contain */
                                className={`h-auto w-32 shrink-0 object-contain ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            />
                        </Link>
                    </div>
                )}
                <button
                    onClick={onToggle}
                    className="h-9 w-9 p-2.5 items-center flex hover:bg-accent rounded-md transition-colors"
                    title={isOpen ? t("closeSidebar") : t("openSidebar")}
                >
                    <PanelLeft className="h-4 w-4" />
                </button>
            </div>

            {/* Nav items */}
            {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
                const isActive =
                    pathname === href || pathname.startsWith(href + "/");
                const label = t(labelKey);
                return (
                    <div key={href} className="py-1 px-2.5">
                        <button
                            onClick={() => router.push(href)}
                            title={!isOpen ? label : ""}
                            className={`w-full h-9 flex items-center gap-3 px-2.5 py-2 rounded-md transition-colors text-left ${
                                isActive
                                    ? "bg-secondary text-foreground"
                                    : "hover:bg-accent text-foreground"
                            } ${!isOpen ? "hidden md:flex" : "flex"}`}
                        >
                            <Icon className="h-4 w-4 flex-shrink-0 text-foreground" />
                            {isOpen && (
                                <span
                                    className={`text-sm font-medium ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
                                    {label}
                                </span>
                            )}
                        </button>
                    </div>
                );
            })}

            {/* Assistant History (tracker #13) — no overtitle: named groups
                render first, then the ungrouped chats under their own
                "Ungrouped" group-style heading (Pinned above everything).
                Chat titles render in Sentient via .sidebar-chat-title; an
                archived view is toggled from the bottom row. */}
            {isOpen && showHistory && (
                <div className="mt-8 flex-1 min-h-0 flex flex-col">
                    <div className="overflow-y-auto flex-1">
                        <div
                            className={`px-2.5 ${
                                shouldAnimate ? "sidebar-fade-in-2" : ""
                            }`}
                        >
                            {historyView === "archived" ? (
                                <>
                                    {archivedGroups.length > 0 && (
                                        <div className="mb-2 space-y-1">
                                            {archivedGroups.map((group) => (
                                                <SidebarArchivedGroupRow
                                                    key={group.id}
                                                    group={group}
                                                />
                                            ))}
                                        </div>
                                    )}
                                    {archivedChats !== null &&
                                        archivedChats.length === 0 &&
                                        archivedGroups.length === 0 && (
                                            <div className="px-2.5 py-2 text-xs text-muted-foreground">
                                                {t("noArchived")}
                                            </div>
                                        )}
                                    <div className="space-y-1">
                                        {(archivedChats ?? [])
                                            .slice(0, visibleCount)
                                            .map((chat) =>
                                                renderChatItem(
                                                    chat,
                                                    "archived",
                                                ),
                                            )}
                                    </div>
                                    {renderShowMore(
                                        archivedChats?.length ?? 0,
                                    )}
                                </>
                            ) : activeChats.length === 0 && !hasSections ? (
                                <div className="px-2.5 py-2 text-xs text-muted-foreground">
                                    {t("noChatsYet")}
                                </div>
                            ) : (
                                <>
                                    {pinnedChats.length > 0 && (
                                        <div className="mb-2">
                                            <div
                                                className={
                                                    sectionHeadingClass
                                                }
                                            >
                                                {t("pinned")}
                                            </div>
                                            <div className="space-y-1">
                                                {pinnedChats.map((chat) =>
                                                    renderChatItem(chat),
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {activeGroups.map((group) => (
                                        <div key={group.id} className="mb-2">
                                            <SidebarChatGroup
                                                group={group}
                                                collapsed={collapsedGroups.includes(
                                                    group.id,
                                                )}
                                                onToggleCollapsed={() =>
                                                    toggleGroupCollapsed(
                                                        group.id,
                                                    )
                                                }
                                            >
                                                {(
                                                    chatsByGroup.get(
                                                        group.id,
                                                    ) ?? []
                                                ).map((chat) =>
                                                    renderChatItem(chat),
                                                )}
                                            </SidebarChatGroup>
                                        </div>
                                    ))}
                                    {ungroupedChats.length > 0 && (
                                        <div>
                                            {/* Ungrouped renders as a group
                                                of its own — same heading
                                                style and collapse behavior
                                                as named groups, no menu. */}
                                            <button
                                                onClick={() =>
                                                    setUngroupedCollapsed(
                                                        (v) => !v,
                                                    )
                                                }
                                                className={cn(
                                                    sectionHeadingClass,
                                                    "flex items-center gap-1 hover:text-foreground transition-colors w-full text-left",
                                                )}
                                            >
                                                <span className="truncate">
                                                    {t("ungrouped")}
                                                </span>
                                                <ChevronDown
                                                    className={cn(
                                                        "h-3 w-3 flex-shrink-0 transition-transform",
                                                        ungroupedCollapsed &&
                                                            "-rotate-90",
                                                    )}
                                                />
                                            </button>
                                            {!ungroupedCollapsed && (
                                                <>
                                                    <div className="space-y-1">
                                                        {ungroupedChats
                                                            .slice(
                                                                0,
                                                                visibleCount,
                                                            )
                                                            .map((chat) =>
                                                                renderChatItem(
                                                                    chat,
                                                                ),
                                                            )}
                                                    </div>
                                                    {renderShowMore(
                                                        ungroupedChats.length,
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                    {/* Active <-> archived view toggle. Resets "Show more"
                        paging so each view starts at one page. */}
                    <button
                        onClick={() => {
                            setVisibleCount(HISTORY_PAGE_SIZE);
                            setHistoryView(
                                historyView === "archived"
                                    ? "active"
                                    : "archived",
                            );
                        }}
                        className="mx-2.5 mb-1 h-8 px-2.5 flex items-center gap-2 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    >
                        {historyView === "archived" ? (
                            <>
                                <ArrowLeft className="h-3.5 w-3.5" />
                                {t("backToActive")}
                            </>
                        ) : (
                            <>
                                <Archive className="h-3.5 w-3.5" />
                                {t("archived")}
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Resize handle — desktop only (the sidebar overlays content
                on mobile). Double-click resets to the default width. */}
            {isOpen && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t("resizeSidebar")}
                    title={t("resizeSidebar")}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        setIsResizing(true);
                    }}
                    onDoubleClick={() =>
                        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
                    }
                    className="hidden md:block absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-border active:bg-border transition-colors"
                />
            )}

            {/* User Profile */}
            <div className="mt-auto">
                {user && (
                    <div className="relative">
                        <button
                            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                            className={`flex items-center transition-colors w-full px-3.5 py-4 border-t border-border ${
                                !isOpen ? "hidden md:flex" : ""
                            } ${
                                pathname === "/account" || isDropdownOpen
                                    ? "bg-secondary"
                                    : "hover:bg-accent"
                            }`}
                            title={!isOpen ? user.email : undefined}
                        >
                            <div className="h-7 w-7 flex-shrink-0 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-sm font-medium font-serif">
                                {getUserInitials(user.email)}
                            </div>
                            {isOpen && (
                                <div
                                    className={`text-left flex-1 min-w-0 pl-3 flex items-center justify-between gap-2 ${
                                        shouldAnimate ? "sidebar-fade-in-2" : ""
                                    }`}
                                >
                                    <div className="flex flex-col gap-0.5 min-w-0">
                                        <div className="text-sm font-medium text-foreground leading-none">
                                            {getDisplayName()}
                                        </div>
                                        <div className="text-[12px] text-muted-foreground leading-none">
                                            {getUserTier()}
                                        </div>
                                    </div>
                                    <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground/70" />
                                </div>
                            )}
                        </button>

                        {isDropdownOpen && (
                            <div className="account-menu absolute bottom-full left-0 m-1 bg-surface-elevated rounded-lg border border-border p-1 z-50 w-62 whitespace-nowrap">
                                <button
                                    onClick={() => {
                                        router.push("/account");
                                        setIsDropdownOpen(false);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2 rounded-md"
                                >
                                    <User className="h-4 w-4" />
                                    {t("accountSettings")}
                                </button>
                                <LanguageSwitcher />
                                <ThemeSwitcher />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
