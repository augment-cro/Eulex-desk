"use client";

/**
 * Visual indicator that PII Shield is active for the current chat,
 * with a small counter showing how many entities are currently
 * masked. Wraps `usePiiStatus` so all the polling/back-off lives in
 * one place.
 *
 * The badge is intentionally compact (fits next to McpToggleButton)
 * and never blocks the composer — it's purely informational. Clicking
 * it navigates to the privacy settings page.
 */

import Link from "next/link";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useTranslations } from "next-intl";
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
        <Link
            href="/account/privacy"
            title={t("tooltip")}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                active
                    ? "border-border bg-accent text-foreground hover:bg-accent"
                    : "border-border bg-muted text-muted-foreground hover:bg-accent"
            }`}
        >
            {active ? (
                <ShieldCheck className="h-3.5 w-3.5" />
            ) : (
                <ShieldOff className="h-3.5 w-3.5" />
            )}
            <span className="hidden sm:inline">
                {active ? t("active") : t("inactive")}
            </span>
            {active && total > 0 && (
                <span className="ml-1 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-foreground">
                    {t("hidden", { count: total })}
                </span>
            )}
        </Link>
    );
}
