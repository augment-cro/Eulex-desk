import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
    /* config options here */
    output: "standalone",
    reactCompiler: true,
    // Pin Turbopack's workspace root to this app. Without it, a stray
    // package-lock.json higher up (e.g. in $HOME) makes Turbopack treat the
    // whole home directory as the root and watch every file under it — which
    // pegs CPU/RAM and can freeze the machine.
    turbopack: {
        root: __dirname,
    },
    async rewrites() {
        return [
            {
                source: "/sitemap.xml",
                destination: "/api/sitemap/sitemap.xml",
            },
            {
                source: "/sitemap_:slug.xml",
                destination: "/api/sitemap/sitemap_:slug.xml",
            },
        ];
    },
    skipTrailingSlashRedirect: true,
};

export default withNextIntl(nextConfig);
