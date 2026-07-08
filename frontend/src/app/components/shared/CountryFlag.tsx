import { cn } from "@/lib/utils";

/**
 * Renders a country flag as an SVG via the `flag-icons` CSS library
 * (imported globally in `layout.tsx`). `code` is an ISO 3166-1 alpha-2
 * country code, lowercased (e.g. "hr", "fr", "eu"). The flag sizes to the
 * current font-size (flag-icons renders width 1.333em × height 1em), so
 * pass a text-size utility via `className` to scale it.
 *
 * We use real SVG flags instead of Unicode flag emoji because emoji flags
 * fall back to the two-letter country code ("HR", "FR") on Windows/Chrome,
 * which are the platforms most of our users run.
 */
export function CountryFlag({
    code,
    label,
    className,
}: {
    code: string;
    label?: string;
    className?: string;
}) {
    return (
        <span
            role="img"
            aria-label={label ?? code.toUpperCase()}
            title={label ?? code.toUpperCase()}
            className={cn("fi shrink-0 rounded-[2px]", `fi-${code.toLowerCase()}`, className)}
        />
    );
}

/**
 * Maps a built-in MCP connector slug (already `sys-`-prefixed by the
 * backend) to the ISO country code whose flag represents that legislation.
 * Returns null for connectors with no national identity (e.g. web search),
 * so callers fall back to a generic icon.
 */
export function connectorFlagCode(slug: string): string | null {
    switch (slug.replace(/^sys-/, "")) {
        case "zakon-ai":
            return "hr";
        case "eulex-fr":
            return "fr";
        case "ris-at":
            return "at";
        case "legal-it":
            return "it";
        case "eulex":
            return "eu";
        default:
            return null;
    }
}
