/**
 * Lightweight i18n for the Word add-in.
 *
 * Locale resolution, in priority order:
 *
 *   1. `localStorage["mike_locale"]` — what we cached the last time we
 *      successfully fetched the user profile. Survives Office reloads
 *      and gives a flicker-free first paint at sign-in.
 *   2. `NEXT_LOCALE` cookie — only useful when the add-in is loaded
 *      directly in a browser tab (developer / debugging context). The
 *      Office.js WebView2 / WKWebView the user actually sees has its
 *      own cookie jar, isolated from the user's main browser session,
 *      so this almost never hits in production.
 *   3. Default `hr` — matches the frontend's `defaultLocale` in
 *      `frontend/src/i18n/request.ts`.
 *
 * Once the add-in authenticates, `useSyncLocaleFromProfile` (called
 * once near the auth boundary) does an async `getUserProfile()` and
 * promotes the server-stored `preferred_language` to the source of
 * truth — that's how a language switch made in the Eulex Desk web app
 * propagates to a paired Word add-in.
 *
 * We don't pull in next-intl because it assumes a Next.js server
 * runtime; this 30-line provider does the same JSON-key lookup with no
 * extra deps.
 */
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import en from "./messages/en.json";
import hr from "./messages/hr.json";
import { getUserProfile, updateUserProfile } from "../lib/api";

export type Locale = "en" | "hr";
const DEFAULT_LOCALE: Locale = "hr";
const STORAGE_KEY = "mike_locale";

type Messages = typeof hr;

const MESSAGES: Record<Locale, Messages> = {
    en: en as Messages,
    hr: hr as Messages,
};

function isLocale(value: unknown): value is Locale {
    return value === "en" || value === "hr";
}

function readStoredLocale(): Locale | null {
    if (typeof localStorage === "undefined") return null;
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return isLocale(v) ? v : null;
    } catch {
        return null;
    }
}

function writeStoredLocale(locale: Locale): void {
    if (typeof localStorage === "undefined") return;
    try {
        localStorage.setItem(STORAGE_KEY, locale);
    } catch {
        /* quota / private mode — drop silently */
    }
}

function readLocaleFromCookie(): Locale | null {
    if (typeof document === "undefined") return null;
    try {
        const raw = document.cookie
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith("NEXT_LOCALE="));
        if (!raw) return null;
        const value = decodeURIComponent(raw.slice("NEXT_LOCALE=".length));
        return isLocale(value) ? value : null;
    } catch {
        return null;
    }
}

function writeLocaleCookie(locale: Locale): void {
    if (typeof document === "undefined") return;
    try {
        // Mirror the web frontend's LanguageSwitcher so the cookie path
        // covers the (rare) case the user opens the add-in URL in their
        // browser too.
        document.cookie = `NEXT_LOCALE=${locale};path=/;max-age=31536000;SameSite=Lax`;
    } catch {
        /* ignore */
    }
}

function resolveInitialLocale(): Locale {
    return readStoredLocale() ?? readLocaleFromCookie() ?? DEFAULT_LOCALE;
}

/**
 * Resolve a dotted key like "chat.placeholder" against the messages
 * tree. Falls back to the key itself when the path is missing, so a
 * forgotten translation surfaces visibly rather than as an empty string.
 */
function lookup(messages: Messages, key: string): string {
    const parts = key.split(".");
    let node: unknown = messages;
    for (const p of parts) {
        if (
            node &&
            typeof node === "object" &&
            p in (node as Record<string, unknown>)
        ) {
            node = (node as Record<string, unknown>)[p];
        } else {
            return key;
        }
    }
    return typeof node === "string" ? node : key;
}

/**
 * Minimal placeholder support: replaces `{name}` tokens with values
 * from the `vars` map. Numeric values are stringified as-is.
 */
function interpolate(
    template: string,
    vars?: Record<string, string | number>,
): string {
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) =>
        name in vars ? String(vars[name]) : `{${name}}`,
    );
}

interface I18nContextValue {
    locale: Locale;
    /**
     * Update the active locale. Persists to localStorage + cookie
     * locally for the next paint, and (when `syncToServer` is true,
     * the default) PATCHes the user profile so the choice rides
     * across to other clients (Eulex Desk web). Pass `false` when you're
     * just mirroring an already-server-confirmed locale (e.g. from
     * `useSyncLocaleFromProfile`) so we don't echo it back.
     */
    setLocale: (next: Locale, syncToServer?: boolean) => void;
    t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(() =>
        resolveInitialLocale(),
    );

    const setLocale = useCallback(
        (next: Locale, syncToServer = true) => {
            writeStoredLocale(next);
            writeLocaleCookie(next);
            setLocaleState(next);
            if (syncToServer) {
                // Fire-and-forget — the UI is already updated.
                void updateUserProfile({ preferred_language: next });
            }
        },
        [],
    );

    // Re-read the cookie when the taskpane regains focus, so a language
    // switch made in the main Eulex Desk app (in a separate browser tab on
    // the same origin) is picked up without forcing the user to reload
    // the add-in. Cheap no-op when the cookie hasn't changed.
    useEffect(() => {
        const onFocus = () => {
            const next = readLocaleFromCookie();
            if (next && next !== locale) {
                writeStoredLocale(next);
                setLocaleState(next);
            }
        };
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [locale]);

    const value = useMemo<I18nContextValue>(() => {
        const messages = MESSAGES[locale];
        return {
            locale,
            setLocale,
            t: (key, vars) => interpolate(lookup(messages, key), vars),
        };
    }, [locale, setLocale]);

    return (
        <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    );
}

export function useI18n(): I18nContextValue {
    const ctx = useContext(I18nContext);
    if (!ctx) {
        throw new Error("useI18n must be used inside <I18nProvider>");
    }
    return ctx;
}

/** Shorthand for components that only need the `t()` function. */
export function useTranslation(): I18nContextValue["t"] {
    return useI18n().t;
}

/**
 * One-shot "pull the user's locale from the backend after sign-in"
 * effect. Call this once at the auth boundary (e.g. inside `App.tsx`
 * after the user has paired and a JWT is in storage). Cheap when the
 * value matches what we already had — and skips the server PATCH
 * roundtrip on the first hit since the value already lives there.
 *
 * Pass `enabled = isAuthenticated` so we don't fire `/user/profile`
 * before the user has paired.
 */
export function useSyncLocaleFromProfile(enabled: boolean): void {
    const { locale, setLocale } = useI18n();
    const lastFetchedFor = useRef<boolean>(false);

    useEffect(() => {
        if (!enabled) {
            lastFetchedFor.current = false;
            return;
        }
        if (lastFetchedFor.current) return;
        lastFetchedFor.current = true;

        let cancelled = false;
        (async () => {
            const profile = await getUserProfile();
            if (cancelled || !profile) return;
            const next = profile.preferredLanguage;
            if (isLocale(next) && next !== locale) {
                // syncToServer=false — the value came from the server,
                // echoing it back would be wasteful.
                setLocale(next, false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [enabled, locale, setLocale]);
}
