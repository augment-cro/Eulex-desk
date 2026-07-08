"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
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

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const { chats, currentChatId, setCurrentChatId } = useChatHistoryContext();
    const router = useRouter();
    const pathname = usePathname();
    const t = useTranslations("sidebar");
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(false);
    const [projectNames, setProjectNames] = useState<Record<string, string>>(
        {},
    );

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

    if (!user) return null;

    return (
        <div
            className={`${
                isOpen
                    ? "w-64 h-dvh bg-muted"
                    : "w-14 md:h-dvh md:bg-muted h-auto bg-transparent"
            } border-border flex flex-col transition-all duration-300 absolute md:relative z-[99] overflow-visible`}
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

            {/* Assistant History — labeled "Povijest razgovora" header + chevron,
                placed below the nav list, shown only when conversation history
                exists (titles render in Sentient via .sidebar-chat-title). */}
            {isOpen && chats && chats.length > 0 && (
                <div className="mt-8 flex-1 min-h-0 flex flex-col">
                    <button
                        onClick={() => setHistoryCollapsed((v) => !v)}
                        aria-label={t("assistantHistory")}
                        className={`mb-2 px-5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors ${
                            shouldAnimate ? "sidebar-fade-in" : ""
                        }`}
                    >
                        <span>{t("assistantHistory")}</span>
                        <ChevronDown
                            className={`h-3.5 w-3.5 transition-transform ${historyCollapsed ? "-rotate-90" : ""}`}
                        />
                    </button>
                    <div
                        className={`overflow-y-auto flex-1 ${historyCollapsed ? "hidden" : ""}`}
                    >
                        <div
                            className={`space-y-1 px-2.5 ${
                                shouldAnimate ? "sidebar-fade-in-2" : ""
                            }`}
                        >
                            {chats.map((chat) => (
                                <SidebarChatItem
                                    key={chat.id}
                                    chat={chat}
                                    isActive={currentChatId === chat.id}
                                    projectName={
                                        chat.project_id
                                            ? projectNames[chat.project_id]
                                            : undefined
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
                            ))}
                        </div>
                    </div>
                </div>
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
