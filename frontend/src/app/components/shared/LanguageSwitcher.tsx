"use client";

import { useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import type { Locale } from "@/i18n/request";
import { getStoredTokens } from "@/lib/oauth";
import { cn } from "@/lib/utils";
import { CountryFlag } from "@/app/components/shared/CountryFlag";

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

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

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
        document.cookie = `NEXT_LOCALE=${nextLocale};path=/;max-age=31536000;SameSite=Lax`;
        persistPreferredLanguage(nextLocale);
        startTransition(() => {
            router.refresh();
        });
    };

    const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
    const other = LOCALES.find((l) => l.code !== locale) ?? LOCALES[1];

    return (
        <button
            type="button"
            onClick={() => handleSwitch(other.code)}
            disabled={isPending}
            aria-label={t("label")}
            className={cn(
                "transition-colors disabled:opacity-50",
                variant === "sidebar"
                    ? "flex w-full items-center gap-2 rounded-md px-4 py-2 text-left text-sm text-foreground hover:bg-accent"
                    : "inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-lg leading-none hover:bg-accent",
            )}
            title={t("label")}
        >
            {variant === "sidebar" ? (
                <span className="flex items-center gap-2">
                    <CountryFlag
                        code={current.country}
                        label={t(locale as "en" | "hr")}
                        className="text-base"
                    />
                    <span>{t(locale as "en" | "hr")}</span>
                </span>
            ) : (
                <CountryFlag
                    code={current.country}
                    label={t(locale as "en" | "hr")}
                    className="text-lg"
                />
            )}
        </button>
    );
}
