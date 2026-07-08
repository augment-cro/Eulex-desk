"use client";

import React from "react";

const CARDINAL_ANGLES = [0, 90, 180, 270];
const INTERCARDINAL_ANGLES = [30, 60, 120, 150, 210, 240, 300, 330];

const DEFAULT_COLOR = "var(--foreground)";
const DONE_COLOR = "var(--success)";
const ERROR_COLOR = "var(--destructive)";

export function MikeIcon({
    spin = false,
    done = false,
    error = false,
    mike = false,
    intro = true,
    size = 24,
    style,
}: {
    spin?: boolean;
    done?: boolean;
    error?: boolean;
    mike?: boolean;
    /** Play a one-shot rotate+fade entrance animation on mount. Defaults to true. */
    intro?: boolean;
    size?: number;
    style?: React.CSSProperties;
}) {
    void mike;
    const color = error ? ERROR_COLOR : done ? DONE_COLOR : DEFAULT_COLOR;

    return (
        <span
            className="shrink-0 inline-flex items-center justify-center align-middle animate-[spin_3s_linear_infinite]"
            style={{
                width: size,
                height: size,
                animationPlayState: spin ? "running" : "paused",
                lineHeight: 0,
                ...style,
            }}
        >
            <span
                className={
                    intro
                        ? "inline-flex items-center justify-center mike-compass-intro"
                        : "inline-flex items-center justify-center"
                }
                style={{
                    width: size,
                    height: size,
                    color,
                    transition: "color 220ms ease",
                }}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 64 64"
                    width={size}
                    height={size}
                    style={{ display: "block", color: "inherit" }}
                    aria-hidden
                >
                    {/* Cardinal blades — heavier */}
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
                    {/* Intercardinal blades — lighter */}
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
                    {/* Center dot */}
                    <circle cx="32" cy="32" r="3.6" fill="currentColor" />
                </svg>
            </span>
        </span>
    );
}
