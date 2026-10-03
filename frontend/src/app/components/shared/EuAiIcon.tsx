"use client";

import type * as React from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Official EU icon for AI-generated content (European Commission,
// https://digital-strategy.ec.europa.eu/en/policies/eu-icons-labelling-ai-generated-content);
// path data verbatim from LABEL_AI_black.svg.
const CIRCLE =
    "M272.03,100.72c100.92,0,182.74,81.82,182.74,182.75s-81.82,182.74-182.74,182.74-182.75-81.82-182.75-182.74,81.82-182.75,182.75-182.75";
const LETTER_A =
    "M170.79,353.74c-1.08,0-2.05-.43-2.92-1.31-.88-.87-1.31-1.84-1.31-2.92,0-.67.07-1.27.2-1.81l47.34-129.32c.4-1.48,1.24-2.79,2.52-3.93,1.27-1.14,3.05-1.71,5.34-1.71h29.81c2.28,0,4.06.57,5.34,1.71,1.27,1.14,2.11,2.45,2.52,3.93l47.14,129.32c.27.54.4,1.14.4,1.81,0,1.08-.44,2.05-1.31,2.92s-1.91,1.31-3.12,1.31h-24.78c-2.01,0-3.52-.5-4.53-1.51-1.01-1.01-1.65-1.91-1.91-2.72l-7.86-20.55h-53.78l-7.65,20.55c-.27.81-.88,1.71-1.81,2.72-.94,1.01-2.55,1.51-4.83,1.51h-24.78ZM218.13,299.96h37.47l-18.93-53.18-18.53,53.18Z";
const LETTER_I =
    "M328.11,353.74c-1.48,0-2.69-.47-3.63-1.41-.94-.94-1.41-2.15-1.41-3.63v-130.93c0-1.48.47-2.68,1.41-3.63s2.15-1.41,3.63-1.41h26.99c1.48,0,2.68.47,3.63,1.41.94.94,1.41,2.15,1.41,3.63v130.93c0,1.48-.47,2.69-1.41,3.63-.94.94-2.15,1.41-3.63,1.41h-26.99Z";

/**
 * The EU "AI" icon: a circle in `currentColor` with the letters knocked out
 * (even-odd fill), so it takes the text colour in every theme. The viewBox
 * is cropped to the circle, so it reads at 12–14 px (`size-3` / `size-3.5`).
 */
function EuAiIcon({
    className,
    label,
    ...props
}: React.ComponentProps<"svg"> & {
    /** Accessible name; defaults to the plain "EU AI label" text. */
    label?: string;
}) {
    const t = useTranslations("euAiIcon");
    return (
        <svg
            data-slot="eu-ai-icon"
            role="img"
            aria-label={label ?? t("label")}
            viewBox="89.28 100.72 365.49 365.49"
            fill="currentColor"
            className={cn("size-3.5 shrink-0", className)}
            {...props}
        >
            <path fillRule="evenodd" d={CIRCLE + LETTER_A + LETTER_I} />
        </svg>
    );
}

export { EuAiIcon };
