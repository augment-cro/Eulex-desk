import React from "react";

const CARDINAL_ANGLES = [0, 90, 180, 270];
const INTERCARDINAL_ANGLES = [30, 60, 120, 150, 210, 240, 300, 330];

/**
 * Eulex Desk brand mark — compass/sun rays radiating from a central dot.
 *
 * Mirrors the SVG the Eulex Desk web frontend uses (frontend/src/components/chat/mike-icon.tsx)
 * so the add-in and the web app share the same identity. We render the mark as
 * inline SVG (no PNG asset) so it scales crisply at every taskpane width.
 *
 * The component name and file stay `MikeLogo` for now to avoid touching every
 * import site; only the visuals are Eulex Desk-branded.
 */
export default function MikeLogo({
    size = 28,
    className = "",
    color = "#0a0a0f",
}: {
    size?: number;
    className?: string;
    color?: string;
}) {
    return (
        <span
            className={`inline-flex items-center justify-center ${className}`}
            style={{
                width: size,
                height: size,
                lineHeight: 0,
                color,
            }}
            aria-label="Eulex Desk"
        >
            <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 64 64"
                width={size}
                height={size}
                style={{ display: "block", color: "inherit" }}
                aria-hidden
            >
                <g
                    stroke="currentColor"
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    fill="none"
                >
                    {CARDINAL_ANGLES.map((deg) => (
                        <line
                            key={deg}
                            x1="32"
                            y1="10"
                            x2="32"
                            y2="26"
                            transform={`rotate(${deg} 32 32)`}
                        />
                    ))}
                </g>
                <g
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    fill="none"
                >
                    {INTERCARDINAL_ANGLES.map((deg) => (
                        <line
                            key={deg}
                            x1="32"
                            y1="9"
                            x2="32"
                            y2="26"
                            transform={`rotate(${deg} 32 32)`}
                        />
                    ))}
                </g>
                <circle cx="32" cy="32" r="3.6" fill="currentColor" />
            </svg>
        </span>
    );
}
