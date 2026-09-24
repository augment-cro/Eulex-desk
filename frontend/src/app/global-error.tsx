"use client";

import { useEffect } from "react";

// global-error replaces the root layout — and with it the
// NextIntlClientProvider — so next-intl is unavailable here. We read the
// NEXT_LOCALE cookie directly and pick strings from this tiny inline
// dictionary instead (hr is the default locale).
const STRINGS = {
    hr: {
        title: "Nešto je pošlo po zlu – Eulex Desk",
        heading: "Nešto je pošlo po zlu",
        body: "Dogodila se neočekivana pogreška. Zabilježili smo je i naš će je tim istražiti.",
        back: "Natrag",
    },
    en: {
        title: "Something went wrong – Eulex Desk",
        heading: "Something went wrong",
        body: "We encountered an unexpected error. This has been logged and our team will look into it.",
        back: "Back",
    },
} as const;

function getCookieLocale(): keyof typeof STRINGS {
    if (typeof document !== "undefined") {
        const match = document.cookie.match(
            /(?:^|;\s*)NEXT_LOCALE=(hr|en)(?:;|$)/,
        );
        if (match) return match[1] as keyof typeof STRINGS;
    }
    return "hr";
}

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
}) {
    useEffect(() => {
        console.error("Global error:", error);
    }, [error]);

    const locale = getCookieLocale();
    const s = STRINGS[locale];

    return (
        <html lang={locale}>
            <head>
                <title>{s.title}</title>
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=EB+Garamond:wght@400;500&display=swap');

                    * { margin: 0; padding: 0; box-sizing: border-box; }

                    /* literal-ok: standalone fallback — renders without the CSS bundle, so paper tokens are inlined here */
                    body {
                        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                        background-color: #FFFCF5;
                        color: #32270D;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .error-container {
                        text-align: center;
                        max-width: 480px;
                        padding: 2rem;
                    }

                    .error-title {
                        font-family: 'EB Garamond', Georgia, serif;
                        font-size: 1.75rem;
                        font-weight: 400;
                        color: #32270D;
                        margin-bottom: 0.75rem;
                    }

                    .error-message {
                        font-size: 0.9375rem;
                        color: #6F6249;
                        line-height: 1.6;
                        margin-bottom: 2rem;
                    }

                    .btn-back {
                        display: inline-flex;
                        align-items: center;
                        gap: 0.5rem;
                        padding: 0.625rem 1.25rem;
                        border-radius: 0.5rem;
                        font-size: 0.875rem;
                        font-weight: 500;
                        font-family: 'Inter', sans-serif;
                        cursor: pointer;
                        transition: all 0.15s ease;
                        text-decoration: none;
                        border: none;
                        background-color: #32270D;
                        color: #FFFCF5;
                    }

                    .btn-back:hover {
                        background-color: #211A0D;
                    }

                    .btn-back:active {
                        transform: scale(0.98);
                    }
                `}</style>
            </head>
            <body>
                <div className="error-container">
                    <h1 className="error-title">{s.heading}</h1>
                    <p className="error-message">{s.body}</p>
                    <button
                        className="btn-back"
                        onClick={() => window.history.back()}
                    >
                        {s.back}
                    </button>
                </div>
            </body>
        </html>
    );
}
