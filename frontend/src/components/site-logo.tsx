import Link from "next/link";

interface SiteLogoProps {
    size?: "sm" | "md" | "lg" | "xl";
    className?: string;
    animate?: boolean;
    asLink?: boolean;
}

// Heights for the EULEX wordmark (w-auto keeps the aspect ratio). The mark is
// the brand SVG shared with eulex-www (public/eulex-logo.svg), matching the
// sidebar + landing so every surface shows the same EULEX logo.
const heightClasses: Record<NonNullable<SiteLogoProps["size"]>, string> = {
    sm: "h-5",
    md: "h-6",
    lg: "h-8",
    xl: "h-14",
};

export function SiteLogo({
    size = "md",
    className = "",
    animate = false,
    asLink = false,
}: SiteLogoProps) {
    const landingHref =
        process.env.NODE_ENV === "production"
            ? "https://eulex.ai/desk"
            : "http://localhost:3000";

    const logo = (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src="/eulex-logo.svg"
            alt="EULEX"
            className={`w-auto ${heightClasses[size]} ${
                animate ? "sidebar-fade-in" : ""
            } ${className}`}
        />
    );

    if (asLink) {
        return (
            <Link
                href={landingHref}
                aria-label="EULEX"
                className="cursor-pointer hover:opacity-80 transition-opacity"
            >
                {logo}
            </Link>
        );
    }

    return logo;
}
