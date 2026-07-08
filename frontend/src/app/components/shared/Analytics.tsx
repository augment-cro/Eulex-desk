"use client";

/**
 * Analytics — invisible client component (renders the SA script tag only).
 *
 * Responsibilities:
 *  1. Load the Simple Analytics script (production only — track() and
 *     trackPageview() no-op in dev, so dev never needs the script).
 *  2. Keep `window.sa_metadata` in sync with the user's tier and ui_locale —
 *     including CLEARING tier on logout, so the previous user's tier can't
 *     stick to anonymous or next-user events.
 *  3. Send a normalised pageview on every route change — raw ID/token
 *     segments are replaced with :id / :token before they leave the browser.
 *     Pageviews that occur before the script loads are queued in
 *     lib/analytics.ts and flushed from the script's onLoad.
 *
 * Mount this inside <UserProfileProvider> (done in providers.tsx) so that
 * useUserProfile() resolves correctly.
 */

import { useEffect, useRef } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useLocale } from "next-intl";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    setGlobalMetadata,
    trackPageview,
    flushPageviews,
} from "@/app/lib/analytics";

const SA_HOSTNAME = process.env.NEXT_PUBLIC_SA_HOSTNAME || "max.eulex.ai";

export function Analytics(): React.ReactNode {
    const pathname = usePathname();
    const { profile } = useUserProfile();
    const locale = useLocale();

    // -------------------------------------------------------------------------
    // 1. Sync tier + ui_locale into window.sa_metadata whenever they change.
    //    Both keys are always passed: an undefined value REMOVES the key
    //    (see setGlobalMetadata), which is what clears tier after logout.
    // -------------------------------------------------------------------------
    useEffect(() => {
        setGlobalMetadata({
            tier: profile?.tierKey ?? undefined,
            ui_locale: locale || undefined,
        });
    }, [profile?.tierKey, locale]);

    // -------------------------------------------------------------------------
    // 2. Send a normalised pageview on route change.
    //
    // Dedupe compares the RAW pathname: two different entities of the same
    // route shape (/projects/A → /projects/B) are distinct navigations and
    // must both count, even though both normalise to /projects/:id.
    // -------------------------------------------------------------------------
    const lastSentPath = useRef<string | null>(null);

    useEffect(() => {
        // Deduplicate re-renders without a real navigation.
        if (pathname === lastSentPath.current) return;
        lastSentPath.current = pathname;

        trackPageview(pathname);
    }, [pathname]);

    // -------------------------------------------------------------------------
    // 3. The SA script itself. data-auto-collect="false" disables automatic
    //    pageview collection so only the normalised paths above are sent.
    //    Not rendered outside production: the wrapper no-ops there, so the
    //    third-party script would be dead weight on every dev page load.
    // -------------------------------------------------------------------------
    if (process.env.NODE_ENV !== "production") return null;

    return (
        <Script
            src="https://scripts.simpleanalyticscdn.com/latest.js"
            data-hostname={SA_HOSTNAME}
            data-auto-collect="false"
            strategy="afterInteractive"
            onLoad={flushPageviews}
        />
    );
}
