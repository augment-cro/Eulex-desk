"use client";

/**
 * Visual indicator that PII Shield is active for the current chat.
 * Icon-only (issue #132): the composer row must never overflow, so the
 * words live in the tooltip — green shield = on, muted = paused. The
 * masked-entity count joins the tooltip when present. Clicking
 * navigates to the privacy settings page. Wraps `usePiiStatus` so all
 * the polling/back-off lives in one place.
 */

import Link from "next/link";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePiiStatus } from "@/app/hooks/usePiiStatus";
import type { PiiMode } from "@/app/lib/mikeApi";

interface Props {
    chatMode?: PiiMode | null;
    sessionId?: string | null;
}

export function ShieldBadge({ chatMode, sessionId }: Props) {
    const t = useTranslations("pii.shieldBadge");
    const { mode, active, meta } = usePiiStatus({ chatMode, sessionId });

    if (mode === "off") {
        return null;
    }

    const total = meta?.total_entities ?? 0;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Link
                    href="/account/privacy"
                    aria-label={active ? t("active") : t("inactive")}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-accent"
                >
                    {active ? (
                        <ShieldCheck className="h-4 w-4 shrink-0 text-success" />
                    ) : (
                        <ShieldOff className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                </Link>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-60">
                {active ? t("tooltipOn") : t("tooltipOff")}
                {active && total > 0 ? ` ${t("hidden", { count: total })}.` : ""}
            </TooltipContent>
        </Tooltip>
    );
}
