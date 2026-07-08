import type { Metadata } from "next";
import { EB_Garamond } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import "flag-icons/css/flag-icons.min.css";
import { Providers } from "@/components/providers";

// Serif for the classic mike / mike-dark themes only (the EULEX themes use
// Sentient). Exposed as the --font-eb-garamond CSS var; globals.css routes the
// serif role to it under [data-theme="mike*"]. See DESIGN.md §1.
const ebGaramond = EB_Garamond({
    variable: "--font-eb-garamond",
    subsets: ["latin"],
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    title: "AI Platform",
    description:
        "AI-powered legal document analysis and contract review platform.",
    robots: { index: false, follow: true },
    icons: {
        icon: [
            { url: "/icon.svg", type: "image/svg+xml" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const locale = await getLocale();
    const messages = await getMessages();

    return (
        <html lang={locale} suppressHydrationWarning>
            <head>
                <link
                    rel="preconnect"
                    href="https://api.fontshare.com"
                    crossOrigin="anonymous"
                />
                <link
                    rel="stylesheet"
                    href="https://api.fontshare.com/v2/css?f[]=sentient@1,2&f[]=azeret-mono@5&display=swap"
                />
                {/*
                 * Simple Analytics queue stub — defines window.sa_event
                 * before hydration so any early calls are queued and
                 * replayed once the real script loads. Production only:
                 * track() no-ops in dev and the script (rendered by the
                 * Analytics component) is not loaded there.
                 */}
                {process.env.NODE_ENV === "production" && (
                    <script
                        dangerouslySetInnerHTML={{
                            __html: `window.sa_event=window.sa_event||function(){(window.sa_event.q=window.sa_event.q||[]).push(arguments)};`,
                        }}
                    />
                )}
            </head>
            <body className={`${ebGaramond.variable} font-sans antialiased`}>
                <NextIntlClientProvider messages={messages}>
                    <Providers>{children}</Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
