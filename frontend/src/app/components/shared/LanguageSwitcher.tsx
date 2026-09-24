"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { Locale } from "@/i18n/request";
import { getStoredTokens } from "@/lib/oauth";
import { cn } from "@/lib/utils";
import { CountryFlag } from "@/app/components/shared/CountryFlag";

import { API_BASE } from "@/app/lib/apiBase";
/**
 * `sidebar` — the in-app shell switcher (shadcn sidebar tokens).
 * `landing` — the public marketing/login surfaces. Both variants now use the
 * shared paper/ink design tokens (see design tokens). Same locale-switch
 * behaviour, different skin.
 */
type LanguageSwitcherVariant = "sidebar" | "landing";

// `country` is the ISO code whose flag represents the locale (en → GB).
const LOCALES: { code: Locale; country: string }[] = [
    { code: "en", country: "gb" },
    { code: "hr", country: "hr" },
];

/**
 * Fire-and-forget mirror of the chosen locale into the user profile.
 *
 * The web frontend itself runs on the cookie alone — `next-intl` reads
 * `NEXT_LOCALE` server-side. We persist `preferred_language` so clients
 * that can't see this cookie (most importantly the Word add-in's
 * sandboxed Office.js WebView, which has its own cookie jar) can fetch
 * the same locale on sign-in.
 *
 * Failures are swallowed: the language switch is already cosmetically
 * complete client-side, so we don't want a transient backend hiccup to
 * show an error toast on every switch.
 */
function persistPreferredLanguage(locale: Locale): void {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) return;
    void fetch(`${API_BASE}/user/profile`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ preferred_language: locale }),
    }).catch(() => {
        /* non-blocking */
    });
}

/** Cookie the server-side `next-intl` request config reads (`NEXT_LOCALE`). */
function setLocaleCookie(nextLocale: Locale): void {
    document.cookie = `NEXT_LOCALE=${nextLocale};path=/;max-age=31536000;SameSite=Lax`;
}

export function LanguageSwitcher({
    variant = "sidebar",
}: {
    variant?: LanguageSwitcherVariant;
} = {}) {
    const locale = useLocale();
    const t = useTranslations("language");
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const handleSwitch = (nextLocale: Locale) => {
        if (nextLocale === locale) return;
        setLocaleCookie(nextLocale);
        persistPreferredLanguage(nextLocale);
        startTransition(() => {
            router.refresh();
        });
    };

    const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
    const other = LOCALES.find((l) => l.code !== locale) ?? LOCALES[1];

    // Sidebar (account menu): list every language, current one marked, so
    // the user sees the alternative instead of having to guess that the
    // single flag is a toggle (Teams BugFix, Neven 2026-09-09 — users
    // thought only one language existed). Order is fixed: English, then
    // Hrvatski underneath.
    if (variant === "sidebar") {
        return (
            <div role="group" aria-label={t("label")}>
                {LOCALES.map((l) => {
                    const isCurrent = l.code === locale;
                    return (
                        <button
                            key={l.code}
                            type="button"
                            onClick={() => handleSwitch(l.code)}
                            disabled={isPending || isCurrent}
                            aria-current={isCurrent ? "true" : undefined}
                            className={cn(
                                "flex w-full items-center gap-2 rounded-md px-4 py-2 text-left text-sm transition-colors",
                                isCurrent
                                    ? "bg-secondary text-foreground"
                                    : "text-foreground hover:bg-accent",
                                isPending && "opacity-50",
                            )}
                        >
                            <CountryFlag
                                code={l.country}
                                label={t(l.code)}
                                className="text-base"
                            />
                            <span>{t(l.code)}</span>
                        </button>
                    );
                })}
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={() => handleSwitch(other.code)}
            disabled={isPending}
            aria-label={t("label")}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-lg leading-none transition-colors hover:bg-accent disabled:opacity-50",
            )}
            title={t("label")}
        >
            <CountryFlag
                code={current.country}
                label={t(locale as "en" | "hr")}
                className="text-lg"
            />
        </button>
    );
}
