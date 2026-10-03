"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { SiteLogo } from "@/components/site-logo";
import { cn } from "@/lib/utils";

/**
 * Marks a system context — published by EULEX for every user, read-only.
 * The mark is the shared EULEX wordmark (SiteLogo), never a text logo.
 */
export function SystemContextBadge({ className }: { className?: string }) {
    const t = useTranslations("contextsPage");
    return (
        <Badge
            variant="outline"
            className={cn("gap-1 border-border bg-background", className)}
            title={t("systemBadgeTitle")}
        >
            <SiteLogo size="xs" />
            <span className="sr-only">{t("systemBadgeTitle")}</span>
        </Badge>
    );
}
