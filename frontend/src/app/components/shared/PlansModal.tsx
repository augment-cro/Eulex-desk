"use client";

/**
 * Full plan-comparison modal (Free / Plus / Pro / Team) shown when a user
 * clicks an upgrade CTA (e.g. "Pogledaj Plus" in the rate-limit banner).
 *
 * Thin wrapper around the existing self-contained `PlanCards` grid — the same
 * comparison rendered on the account page. PlanCards fetches `/billing/plans`
 * itself and mounts its own `PlusUpgradeModal` for the per-tier Stripe
 * checkout, so this wrapper only hosts the dialog shell + the current-tier
 * highlight. Built on the shadcn `Dialog` primitive (Radix) per the repo's
 * shadcn-first rule — gives focus-trap, Esc-to-close, scroll-lock and ARIA
 * wiring for free. Open/close contract mirrors `PlusUpgradeModal`/`TopupModal`
 * ({ open, onClose }).
 */

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { track } from "@/app/lib/analytics";
import { PlanCards } from "../account/PlanCards";

export function PlansModal({
    open,
    onClose,
}: {
    open: boolean;
    onClose: () => void;
}) {
    const { profile } = useUserProfile();
    const t = useTranslations("account.plan");

    // Fire paywall_shown once each time the modal opens.
    useEffect(() => {
        if (open) {
            track("paywall_shown", { trigger: "upgrade_cta" });
        }
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            {/* z-[200]/[201]: lift above the app sidebar (z-[99]) so the modal
                and its backdrop cover everything, matching the app's modal tier. */}
            <DialogContent
                overlayClassName="z-[200]"
                className="z-[201] w-[95vw] max-w-[95vw] sm:max-w-7xl max-h-[90vh] overflow-y-auto overflow-x-hidden p-6"
            >
                <DialogHeader>
                    <DialogTitle className="font-serif text-2xl">
                        {t("modalTitle")}
                    </DialogTitle>
                    <DialogDescription>
                        {t("modalSubtitle")}
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-2">
                    <PlanCards currentTier={profile?.tierKey ?? null} />
                </div>
            </DialogContent>
        </Dialog>
    );
}
