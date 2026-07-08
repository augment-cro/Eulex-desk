"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Lock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { hasProFeatures } from "@/lib/tiers";

interface TabDef {
    id: string;
    labelKey:
        | "general"
        | "models"
        | "connectors"
        | "fileSources"
        | "wordAddin"
        | "privacy";
    href: string;
    /** When true the tab is only visible for ADMIN_EMAIL. */
    adminOnly?: boolean;
    /**
     * When true the tab requires the "pro" entitlement group (PII + Word
     * add-in). Below Pro it stays visible but greyed with a lock — clicking
     * still navigates so the page can show the upgrade upsell.
     */
    proOnly?: boolean;
}

/** Email that can see admin-only settings tabs (connectors). Unset ⇒ none. */
const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL || null;

const TABS: TabDef[] = [
    { id: "general", labelKey: "general", href: "/account" },
    { id: "models", labelKey: "models", href: "/account/models" },
    { id: "mcp", labelKey: "connectors", href: "/account/mcp", proOnly: true },
    { id: "files", labelKey: "fileSources", href: "/account/connectors" },
    { id: "privacy", labelKey: "privacy", href: "/account/privacy", proOnly: true },
    { id: "word", labelKey: "wordAddin", href: "/account/word", proOnly: true },
];

export default function AccountLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { user, isAuthenticated, authLoading } = useAuth();
    const { profile } = useUserProfile();
    const t = useTranslations("account");

    const isAdmin = !!ADMIN_EMAIL && user?.email === ADMIN_EMAIL;
    const proUnlocked = hasProFeatures(profile?.tierKey);

    const visibleTabs = useMemo(
        () => TABS.filter((tab) => !tab.adminOnly || isAdmin),
        [isAdmin],
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    // Redirect non-admin users away from admin-only pages
    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        const currentTab = TABS.find((tab) => tab.href === pathname);
        if (currentTab?.adminOnly && !isAdmin) {
            router.replace("/account");
        }
    }, [pathname, isAdmin, authLoading, isAuthenticated, router]);

    if (authLoading) {
        return (
            <div className="h-dvh bg-background flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-foreground" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <div className="flex flex-col h-full md:overflow-y-auto px-6 py-6 md:py-10">
            <div className="max-w-5xl w-full mx-auto">
                <h1 className="text-4xl font-medium mb-8 font-eb-garamond">
                    {t("settings")}
                </h1>

                <div className="flex flex-col md:flex-row gap-6 md:gap-10">
                    <nav
                        aria-label="Settings"
                        className="md:w-56 shrink-0 flex md:flex-col gap-1 overflow-x-auto"
                    >
                        {visibleTabs.map((tab) => {
                            const active = pathname === tab.href;
                            const locked = !!tab.proOnly && !proUnlocked;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => router.push(tab.href)}
                                    className={`flex items-center justify-between gap-2 text-left whitespace-nowrap px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                                        active
                                            ? "bg-secondary text-secondary-foreground"
                                            : locked
                                              ? "text-muted-foreground/70 hover:text-muted-foreground hover:bg-accent"
                                              : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                    }`}
                                >
                                    <span>{t(`tabs.${tab.labelKey}`)}</span>
                                    {locked && (
                                        <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                                            <Lock className="h-3 w-3" aria-hidden="true" />
                                            {t("proLock.badge")}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </nav>

                    <div className="flex-1 min-w-0">{children}</div>
                </div>
            </div>
        </div>
    );
}
