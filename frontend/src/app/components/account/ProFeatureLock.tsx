"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlansModal } from "@/app/components/shared/PlansModal";

/**
 * Pro-locked placeholder shown in place of a settings panel (PII / Word
 * add-in / Context (MCP)) for tiers below Pro. The real controls are
 * entitlement-gated on the backend, so free/plus users would only get 403s —
 * instead of dangling the controls we render this card explaining the feature
 * is a Pro perk and route the upgrade CTA into the shared `PlansModal`.
 *
 * Copy lives under the `account.proLock.<kind>` i18n namespace.
 */
export function ProFeatureLock({ kind }: { kind: "pii" | "word" | "mcp" }) {
    const t = useTranslations("account.proLock");
    const [showPlans, setShowPlans] = useState(false);

    return (
        <>
            <div className="max-w-2xl rounded-2xl border border-border bg-card p-6 text-card-foreground">
                <div className="flex items-center gap-3">
                    <span
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted"
                        aria-hidden="true"
                    >
                        <Lock className="h-5 w-5 text-muted-foreground" />
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-serif text-xl font-medium">
                            {t(`${kind}.title`)}
                        </h2>
                        <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                            {t("badge")}
                        </Badge>
                    </div>
                </div>

                <p className="mt-3 text-sm text-muted-foreground">
                    {t(`${kind}.description`)}
                </p>

                <Button
                    type="button"
                    className="mt-5"
                    onClick={() => setShowPlans(true)}
                >
                    {t("cta")}
                </Button>
            </div>

            <PlansModal open={showPlans} onClose={() => setShowPlans(false)} />
        </>
    );
}
