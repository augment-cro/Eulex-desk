"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";

/**
 * Light/dark switch for the two EULEX themes (paper ↔ dark). A single toggle
 * (like the LanguageSwitcher): shows the current theme with a Moon/Sun
 * affordance and flips on click. The classic mike / mike-dark themes remain
 * defined in globals.css and registered with the next-themes provider, just
 * not offered here. `sidebar` for the in-app shell footer, `landing` for the
 * public marketing/login surfaces.
 */
type ThemeSwitcherVariant = "sidebar" | "landing";

export function ThemeSwitcher({
    variant = "sidebar",
}: {
    variant?: ThemeSwitcherVariant;
} = {}) {
    const { theme, setTheme } = useTheme();
    const t = useTranslations("theme");
    // next-themes reads localStorage on the client only — render nothing
    // until mounted so SSR and first client render agree.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;

    const isDark = theme === "dark" || theme === "mike-dark";
    // Icon mirrors the CURRENT theme (matching the label), not the target:
    // light → Sun, dark → Moon. (Was inverted, which read as light/dark swapped.)
    const Icon = isDark ? Moon : Sun;
    const toggle = () => setTheme(isDark ? "paper" : "dark");

    // variant="sidebar": a full-width row matching the account-settings /
    // language rows above it (font set to Sentient via `.account-menu`).
    if (variant === "sidebar") {
        return (
            <button
                type="button"
                onClick={toggle}
                aria-label={t("label")}
                className="w-full px-4 py-2 text-left text-sm text-foreground hover:bg-accent flex items-center gap-2 rounded-md"
            >
                <Icon className="h-4 w-4 shrink-0" />
                {t(isDark ? "dark" : "paper")}
            </button>
        );
    }

    // variant="landing": icon-only toggle for the public surfaces.
    return (
        <button
            type="button"
            onClick={toggle}
            aria-label={t("label")}
            title={t("label")}
            className="inline-flex items-center gap-1.5 outline-none transition-colors rounded-sm px-2 py-1.5 leading-none hover:bg-accent"
        >
            <Icon className="h-3.5 w-3.5" />
        </button>
    );
}
