"use client";

/**
 * Inline branded SVG icons for the file-source providers.
 *
 * Inlined (not <img src=...>) so they:
 *   - render instantly with no network round-trip on first paint
 *   - can be tinted with currentColor where the brand allows it
 *     (Box uses its blue, Drive + Microsoft keep brand colors)
 *   - work offline (Word add-in, dev tunnels) without CDN access
 *
 * Sources are the official public brand SVGs (Google Brand Resource
 * Center / Microsoft Brand Central / Box Brand Assets), minified and
 * normalized to a unit viewBox.
 */

import type { IntegrationProviderId } from "@/app/lib/mikeApi";

type Props = {
    provider: IntegrationProviderId;
    className?: string;
    /** Decorative — icons here carry the brand, label comes from text. */
    "aria-hidden"?: boolean;
};

export function IntegrationIcon({
    provider,
    className = "h-4 w-4",
    ...rest
}: Props) {
    switch (provider) {
        case "google_drive":
            return <GoogleDriveIcon className={className} {...rest} />;
        case "onedrive":
            return <Microsoft365Icon className={className} {...rest} />;
        case "box":
            return <BoxIcon className={className} {...rest} />;
        default:
            return null;
    }
}

/* literal-ok: official third-party brand colors (Google Drive / Microsoft /
   Box) — intentionally NOT themed; they must match each vendor's brand. */
function GoogleDriveIcon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 87.3 78"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            aria-hidden="true"
        >
            <path
                d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
                fill="#0066da"
            />
            <path
                d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z"
                fill="#00ac47"
            />
            <path
                d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
                fill="#ea4335"
            />
            <path
                d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
                fill="#00832d"
            />
            <path
                d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
                fill="#2684fc"
            />
            <path
                d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
                fill="#ffba00"
            />
        </svg>
    );
}

function Microsoft365Icon({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 21 21"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            aria-hidden="true"
        >
            <rect x="1" y="1" width="9" height="9" fill="#f25022" />
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
            <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
            <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
        </svg>
    );
}

function BoxIcon({ className }: { className?: string }) {
    // Official "BOX." wordmark from simpleicons (CC0). Single fill — we
    // paint it in Box's brand blue (#0061D5). Width 24 / height 24 keeps
    // it square inside our 4-px-padded slots.
    return (
        <svg
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            aria-hidden="true"
        >
            <path
                d="M4.297 8.522c1.337 0 2.503.755 3.083 1.86V8.879c0-.21.2-.357.388-.357h.713c.211 0 .388.144.388.357v6.236c0 .211-.18.367-.388.367h-.711c-.211 0-.39-.156-.39-.367v-.498A3.49 3.49 0 0 1 4.296 16.5C2.475 16.5 1 14.781 1 12.51c0-2.27 1.474-3.988 3.297-3.988m9.835 0c1.337 0 2.503.755 3.083 1.86a3.485 3.485 0 0 1 3.082-1.86c1.823 0 3.297 1.717 3.297 3.988S22.119 16.5 20.297 16.5a3.49 3.49 0 0 1-3.082-1.86A3.49 3.49 0 0 1 14.132 16.5c-1.823 0-3.297-1.719-3.297-3.99 0-2.27 1.474-3.988 3.297-3.988M4.532 14.45c1.158 0 2.097-.939 2.097-2.097a2.097 2.097 0 1 0-4.194 0c0 1.158.939 2.097 2.097 2.097m9.835 0c1.158 0 2.097-.939 2.097-2.097a2.097 2.097 0 1 0-4.194 0c0 1.158.939 2.097 2.097 2.097m5.93 0c1.158 0 2.097-.939 2.097-2.097a2.097 2.097 0 1 0-4.194 0c0 1.158.939 2.097 2.097 2.097"
                fill="#0061d5"
            />
        </svg>
    );
}
