"use client";

/**
 * Plan-change section on the account → billing page (#28).
 *
 * Renders the public plan catalog (`GET /billing/plans`) as compact rows.
 * For a user with an ACTIVE Stripe subscription the buttons call
 * `POST /billing/change-plan` — upgrades apply immediately with a
 * prorated charge, downgrades are scheduled for the period end (both
 * behind a confirm dialog that explains exactly that). Users without an
 * active subscription (free tier, comped, bank transfer) fall back to
 * the normal checkout flow (`PlusUpgradeModal`), as does a
 * `{ action: "checkout" }` reply from the backend.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { TIER_RANK, type TierKey } from "@/lib/tiers";
import { getStoredTokens } from "@/lib/oauth";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { track } from "@/app/lib/analytics";
import {
    getBillingStatus,
    type BillingSubscriptionView,
} from "@/app/lib/mikeApi";
import {
    PlusUpgradeModal,
    type UpgradePlan,
} from "@/app/components/shared/PlusUpgradeModal";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

/** Plans a subscription can be changed to in-app (mirrors backend PaidPlan). */
const CHANGEABLE_TIERS: readonly TierKey[] = [
    "plus",
    "pro",
    "legal_pro",
    "team",
    "eulex_legal_team",
];

interface LocaleCopy {
    name: string;
    price: string;
    period: string;
    cta: string;
}
interface PlanEntry {
    tierKey: TierKey;
    order: number;
    locales: { hr: LocaleCopy; en: LocaleCopy };
}

type ChangePlanResponse = {
    ok?: boolean;
    action?: "upgraded" | "scheduled" | "checkout";
    plan?: string;
    effective?: "now" | "period_end";
    current_period_end?: number | null;
    detail?: string;
    code?: string;
};

function tierRank(key: string | null | undefined): number | null {
    if (!key || !(key in TIER_RANK)) return null;
    return TIER_RANK[key as keyof typeof TIER_RANK];
}

export function PlanChangeSection() {
    const t = useTranslations("account.billing.changePlan");
    const locale = useLocale();
    const loc: "hr" | "en" = locale === "hr" ? "hr" : "en";
    const { profile, reloadProfile } = useUserProfile();
    const currentTier = (profile?.tierKey ?? null) as TierKey | null;

    const [plans, setPlans] = useState<PlanEntry[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [subscription, setSubscription] =
        useState<BillingSubscriptionView | null>(null);

    // Confirm dialog + request state.
    const [pendingPlan, setPendingPlan] = useState<PlanEntry | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [errorMsg, setErrorMsg] = useState(false);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    // Checkout fallback (no active subscription).
    const [checkoutPlan, setCheckoutPlan] = useState<UpgradePlan | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API_BASE}/billing/plans`, {
                    cache: "no-store",
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = (await res.json()) as { plans: PlanEntry[] };
                if (!cancelled) {
                    setPlans(
                        [...(data.plans ?? [])]
                            .filter((p) => CHANGEABLE_TIERS.includes(p.tierKey))
                            .sort((a, b) => a.order - b.order),
                    );
                }
            } catch {
                if (!cancelled) setLoadFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const refreshSubscription = useCallback(async () => {
        try {
            const status = await getBillingStatus();
            setSubscription(status.subscription);
        } catch {
            // Non-fatal: without a snapshot we fall back to checkout,
            // and the backend re-checks the real state anyway.
            setSubscription(null);
        }
    }, []);

    useEffect(() => {
        void refreshSubscription();
    }, [refreshSubscription]);

    const currentRank = tierRank(currentTier);
    const hasActiveSub = !!subscription;

    const fmtDate = (unixSec: number | null | undefined): string | null =>
        unixSec
            ? new Intl.DateTimeFormat(loc === "hr" ? "hr-HR" : "en-GB", {
                  dateStyle: "long",
              }).format(new Date(unixSec * 1000))
            : null;

    const periodEndLabel = fmtDate(subscription?.current_period_end);

    const isDowngrade = (plan: PlanEntry): boolean => {
        const planRank = tierRank(plan.tierKey);
        return (
            currentRank !== null && planRank !== null && planRank < currentRank
        );
    };

    const confirmChange = async () => {
        if (!pendingPlan) return;
        setSubmitting(true);
        setErrorMsg(false);
        try {
            const tokens = getStoredTokens();
            if (!tokens?.access_token) throw new Error("not signed in");
            const res = await fetch(`${API_BASE}/billing/change-plan`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${tokens.access_token}`,
                },
                body: JSON.stringify({ tier: pendingPlan.tierKey }),
            });
            const body = (await res.json()) as ChangePlanResponse;
            if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
            const planName = (
                pendingPlan.locales[loc] ?? pendingPlan.locales.en
            ).name;
            if (body.action === "checkout") {
                // No active subscription after all — run normal checkout.
                setPendingPlan(null);
                setCheckoutPlan(pendingPlan.tierKey as UpgradePlan);
                return;
            }
            track("plan_change_completed", {
                tier: pendingPlan.tierKey,
                action: body.action ?? "unknown",
            });
            const dateLabel = fmtDate(body.current_period_end);
            setSuccessMsg(
                body.action === "upgraded"
                    ? t("successUpgraded", { plan: planName })
                    : dateLabel
                      ? t("successScheduled", {
                            plan: planName,
                            date: dateLabel,
                        })
                      : t("successScheduledNoDate", { plan: planName }),
            );
            setPendingPlan(null);
            void reloadProfile();
            void refreshSubscription();
        } catch {
            setErrorMsg(true);
        } finally {
            setSubmitting(false);
        }
    };

    if (loadFailed) {
        return <p className="text-sm text-muted-foreground">{t("loadError")}</p>;
    }
    if (!plans) {
        return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
    }

    const pendingCopy = pendingPlan
        ? (pendingPlan.locales[loc] ?? pendingPlan.locales.en)
        : null;
    const pendingIsDowngrade = pendingPlan ? isDowngrade(pendingPlan) : false;

    return (
        <section className="space-y-3">
            <div>
                <h2 className="font-serif text-lg font-semibold text-foreground">
                    {t("title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("subtitle")}
                </p>
            </div>

            {successMsg && (
                <div className="rounded-md border border-success/20 bg-success/10 px-4 py-3 text-sm text-success">
                    {successMsg}
                </div>
            )}

            <ul className="divide-y divide-border rounded-lg border border-border bg-background">
                {plans.map((plan) => {
                    const c = plan.locales[loc] ?? plan.locales.en;
                    const isCurrent = currentTier === plan.tierKey;
                    const downgrade = isDowngrade(plan);
                    return (
                        <li
                            key={plan.tierKey}
                            className={cn(
                                "flex items-center justify-between gap-3 px-4 py-3",
                                isCurrent && "bg-muted/40",
                            )}
                        >
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground">
                                        {c.name}
                                    </span>
                                    {isCurrent && (
                                        <Badge
                                            variant="secondary"
                                            className="shrink-0"
                                        >
                                            {t("current")}
                                        </Badge>
                                    )}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {c.price}
                                    {c.period ? ` ${c.period}` : ""}
                                </div>
                            </div>
                            {isCurrent ? null : (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="shrink-0"
                                    onClick={() => {
                                        track("plan_change_selected", {
                                            tier: plan.tierKey,
                                        });
                                        setErrorMsg(false);
                                        setSuccessMsg(null);
                                        if (hasActiveSub) {
                                            setPendingPlan(plan);
                                        } else {
                                            setCheckoutPlan(
                                                plan.tierKey as UpgradePlan,
                                            );
                                        }
                                    }}
                                >
                                    {downgrade && hasActiveSub
                                        ? t("downgradeCta")
                                        : c.cta}
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>

            <Dialog
                open={pendingPlan !== null}
                onOpenChange={(open) => {
                    if (!submitting && !open) setPendingPlan(null);
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {pendingIsDowngrade
                                ? t("downgradeTitle", {
                                      plan: pendingCopy?.name ?? "",
                                  })
                                : t("upgradeTitle", {
                                      plan: pendingCopy?.name ?? "",
                                  })}
                        </DialogTitle>
                        <DialogDescription>
                            {pendingIsDowngrade
                                ? periodEndLabel
                                    ? t("downgradeBodyWithDate", {
                                          plan: pendingCopy?.name ?? "",
                                          date: periodEndLabel,
                                      })
                                    : t("downgradeBody", {
                                          plan: pendingCopy?.name ?? "",
                                      })
                                : t("upgradeBody", {
                                      plan: pendingCopy?.name ?? "",
                                  })}
                        </DialogDescription>
                    </DialogHeader>
                    {errorMsg && (
                        <p className="text-sm text-destructive">{t("error")}</p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={submitting}
                            onClick={() => setPendingPlan(null)}
                        >
                            {t("cancel")}
                        </Button>
                        <Button
                            type="button"
                            disabled={submitting}
                            onClick={() => void confirmChange()}
                        >
                            {submitting ? t("pending") : t("confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <PlusUpgradeModal
                open={checkoutPlan !== null}
                plan={checkoutPlan ?? "plus"}
                onClose={() => setCheckoutPlan(null)}
                onUpgraded={() => {
                    void reloadProfile();
                    void refreshSubscription();
                }}
            />
        </section>
    );
}
