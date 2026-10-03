"use client";

import { Fragment, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { splitStatusTokens, type StatusKind } from "./statusTokens";

const statusDotVariants = cva(
    "relative inline-block size-[0.55em] shrink-0 rounded-full border align-middle",
    {
        variants: {
            status: {
                problem: "border-status-problem-edge bg-status-problem",
                gap: "border-status-gap-edge bg-status-gap",
                assessment: "border-status-assessment-edge bg-status-assessment",
                insufficient: "border-status-insufficient-edge bg-transparent",
                clear: "border-status-clear-edge bg-status-clear",
            },
        },
    },
);

/**
 * A status token of the model (🔴 🟡 🔵 ⚪ 🟢) drawn as a small, soft dot —
 * pastel fill, hairline edge, about the height of a lowercase letter —
 * instead of the emoji. The emoji stays in the DOM for copy and print,
 * visually hidden; screen readers get the status name.
 */
export function StatusDot({
    status,
    token,
    className,
}: {
    status: StatusKind;
    /** The original emoji (kept for copying). */
    token?: string;
    className?: string;
}) {
    const t = useTranslations("statusDot");
    return (
        <span
            data-slot="status-dot"
            data-status={status}
            role="img"
            aria-label={t(status)}
            className={cn(statusDotVariants({ status }), className)}
        >
            {token && <span className="sr-only">{token}</span>}
        </span>
    );
}

/** Plain text with its status tokens drawn as dots. */
export function renderStatusTokens(text: string): ReactNode {
    const parts = splitStatusTokens(text);
    if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
    return parts.map((p, i) =>
        typeof p === "string" ? (
            <Fragment key={i}>{p}</Fragment>
        ) : (
            <StatusDot key={i} status={p.status} token={p.token} />
        ),
    );
}
