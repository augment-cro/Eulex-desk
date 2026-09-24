"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { TIER_RANK } from "@/lib/tiers";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { track } from "@/app/lib/analytics";
import {
    cancelSubscriptionRenewal,
    getBillingStatus,
    type BillingSubscriptionView,
} from "@/app/lib/mikeApi";
import {
    PlusUpgradeModal,
    type UpgradePlan,
} from "@/app/components/shared/PlusUpgradeModal";

import { API_BASE } from "@/app/lib/apiBase";
/** Canonical tier keys. Mirrors backend lib/entitlements TierKey. */
export type TierKey =
    | "free"
    | "plus"
    | "pro"
    | "legal_pro"
    | "team"
    | "eulex_legal_team"
    | "enterprise";

/** The two pricing tabs. Individual covers the single-user tiers; the
 *  collaboration + on-demand tiers live under Team & Enterprise. */
const INDIVIDUAL_TIERS: readonly TierKey[] = ["free", "plus", "pro", "legal_pro"];
const TEAM_TIERS: readonly TierKey[] = ["team", "eulex_legal_team", "enterprise"];

/** Enterprise is on-demand — its CTA opens a sales contact, not checkout. */
const ENTERPRISE_CONTACT = "mailto:info@eulex.ai";

interface LocaleCopy {
    name: string;
    tagline: string;
    price: string;
    period: string;
    intro?: string;
    cta: string;
    features: string[];
}
interface PlanEntry {
    tierKey: TierKey;
    slug: string;
    order: number;
    popular: boolean;
    /** Daily token quota from tier_limits (absent on older payloads). */
    dailyTokens?: number;
    locales: { hr: LocaleCopy; en: LocaleCopy };
}

/**
 * Rank lookup that tolerates unknown keys: `currentTier` comes from the
 * profile (null while logged out / still loading) and plan keys come from
 * the backend catalog — an unrecognised key yields `null` so callers fall
 * back to today's behavior (show the CTA) instead of guessing a rank.
 */
function tierRank(key: string | null | undefined): number | null {
    if (!key || !(key in TIER_RANK)) return null;
    return TIER_RANK[key as keyof typeof TIER_RANK];
}

/**
 * Plan comparison cards for the account → General → Usage Plan section and
 * the upgrade `PlansModal`. Reads the single-source catalog from the public
 * GET /billing/plans (same data the eulex.ai pricing uses), localised to the
 * active UI locale, and splits it into two tabs: Individual vs Team &
 * Enterprise. Highlights the current tier and opens the in-app checkout modal
 * for the paid tiers (Enterprise links to sales instead).
 */
export function PlanCards({ currentTier }: { currentTier?: TierKey | null }) {
    const t = useTranslations("account.plan");
    const locale = useLocale();
    const loc: "hr" | "en" = locale === "hr" ? "hr" : "en";
    const { reloadProfile } = useUserProfile();

    const [plans, setPlans] = useState<PlanEntry[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [upgradePlan, setUpgradePlan] = useState<UpgradePlan | null>(null);

    // Live Stripe subscription snapshot — drives the cancel-renewal button
    // on the current plan's card. `null` = no active subscription (or the
    // lookup failed): the button simply stays hidden.
    const [subscription, setSubscription] =
        useState<BillingSubscriptionView | null>(null);
    const [cancelOpen, setCancelOpen] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState(false);

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
                        [...(data.plans ?? [])].sort((a, b) => a.order - b.order),
                    );
                }
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        // Only paid tiers can have a renewal to cancel — skip the lookup
        // for free/anonymous users so their cards never trigger the call.
        if (!currentTier || currentTier === "free") {
            setSubscription(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const status = await getBillingStatus();
                if (!cancelled) setSubscription(status.subscription);
            } catch {
                // Non-fatal: without a snapshot the cancel button stays
                // hidden; the rest of the cards render normally.
                if (!cancelled) setSubscription(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [currentTier]);

    if (failed) {
        return (
            <p className="text-sm text-muted-foreground">{t("loadError")}</p>
        );
    }
    if (!plans) {
        return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
    }

    const individualPlans = plans.filter((p) =>
        INDIVIDUAL_TIERS.includes(p.tierKey),
    );
    const teamPlans = plans.filter((p) => TEAM_TIERS.includes(p.tierKey));
    const defaultTab =
        currentTier && TEAM_TIERS.includes(currentTier) ? "team" : "individual";
    const currentRank = tierRank(currentTier);

    const periodEndLabel = subscription?.current_period_end
        ? new Intl.DateTimeFormat(loc === "hr" ? "hr-HR" : "en-GB", {
              dateStyle: "long",
          }).format(new Date(subscription.current_period_end * 1000))
        : null;

    const confirmCancelRenewal = async () => {
        setCancelling(true);
        setCancelError(false);
        try {
            const result = await cancelSubscriptionRenewal();
            track("plan_renewal_cancelled", { tier: currentTier ?? "unknown" });
            setSubscription((prev) =>
                prev
                    ? {
                          ...prev,
                          cancel_at_period_end: true,
                          current_period_end:
                              result.current_period_end ??
                              prev.current_period_end,
                      }
                    : prev,
            );
            setCancelOpen(false);
            void reloadProfile();
        } catch {
            setCancelError(true);
        } finally {
            setCancelling(false);
        }
    };

    const renderCard = (plan: PlanEntry) => {
        const c = plan.locales[loc] ?? plan.locales.en;
        const isCurrent = currentTier === plan.tierKey;
        const popular = plan.popular;
        const isEnterprise = plan.tierKey === "enterprise";
        const showVat = plan.tierKey !== "free" && !isEnterprise;
        // A plan ranked below the user's tier is already covered by what
        // they pay for — never dangle its checkout CTA (that would be a
        // downgrade offer, e.g. "Prijeđi na Plus" shown to Legal Pro).
        const planRank = tierRank(plan.tierKey);
        const isIncluded =
            !isCurrent &&
            currentRank !== null &&
            planRank !== null &&
            planRank < currentRank;

        return (
            <div
                key={plan.tierKey}
                className={cn(
                    "flex h-full flex-col rounded-2xl border bg-card p-5 text-card-foreground",
                    isCurrent
                        ? "border-ring ring-1 ring-ring"
                        : "border-border",
                )}
            >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="font-serif text-xl font-semibold">
                        {c.name}
                    </h3>
                    {popular && (
                        <Badge className="shrink-0 whitespace-nowrap bg-primary text-primary-foreground hover:bg-primary">
                            {t("popular")}
                        </Badge>
                    )}
                    {isCurrent && (
                        <Badge
                            variant="secondary"
                            className="shrink-0 whitespace-nowrap"
                        >
                            {t("current")}
                        </Badge>
                    )}
                </div>

                <p className="mt-1 min-h-[2.5rem] text-sm text-muted-foreground">
                    {c.tagline}
                </p>

                <div className="mt-3 flex flex-wrap items-baseline gap-x-1">
                    <span className="whitespace-nowrap text-2xl font-semibold">
                        {c.price}
                    </span>
                    {c.period && (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {c.period}
                        </span>
                    )}
                    {showVat && (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {t("vatNote")}
                        </span>
                    )}
                </div>

                <div className="my-4 h-px bg-border" />

                <div className="flex-1">
                    {c.intro && (
                        <p className="mb-2 text-sm font-medium">{c.intro}</p>
                    )}
                    <ul className="flex flex-col gap-2">
                        {c.features.map((f, i) => (
                            <li
                                key={i}
                                className="flex items-start gap-2 text-sm"
                            >
                                <Check
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground"
                                    aria-hidden="true"
                                />
                                <span className="text-muted-foreground">
                                    {f}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="mt-5">
                    {isCurrent ? (
                        <div className="flex flex-col gap-2">
                            <Button
                                variant="outline"
                                className="w-full"
                                disabled
                            >
                                {t("currentCta")}
                            </Button>
                            {plan.tierKey !== "free" &&
                                subscription &&
                                (subscription.cancel_at_period_end ? (
                                    <p className="text-center text-xs text-muted-foreground">
                                        {periodEndLabel
                                            ? t("cancelRenewal.endsNote", {
                                                  date: periodEndLabel,
                                              })
                                            : t("cancelRenewal.endsNoteNoDate")}
                                    </p>
                                ) : (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="w-full border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => {
                                            setCancelError(false);
                                            setCancelOpen(true);
                                        }}
                                    >
                                        {t("cancelRenewal.cta")}
                                    </Button>
                                ))}
                        </div>
                    ) : isIncluded ? (
                        <Button
                            variant="outline"
                            className="w-full text-muted-foreground"
                            disabled
                        >
                            {t("includedCta")}
                        </Button>
                    ) : isEnterprise ? (
                        <Button asChild variant="outline" className="w-full">
                            <a href={ENTERPRISE_CONTACT}>{c.cta}</a>
                        </Button>
                    ) : plan.tierKey === "free" ? null : (
                        <Button
                            type="button"
                            className="w-full"
                            variant={popular ? "default" : "outline"}
                            onClick={() => {
                                track("plan_selected", { tier: plan.tierKey });
                                setUpgradePlan(plan.tierKey as UpgradePlan);
                            }}
                        >
                            {c.cta}
                        </Button>
                    )}
                </div>
            </div>
        );
    };

    const gridClass =
        "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

    return (
        <>
            <Tabs defaultValue={defaultTab} className="w-full">
                <TabsList className="mx-auto">
                    <TabsTrigger value="individual">
                        {t("tabs.individual")}
                    </TabsTrigger>
                    <TabsTrigger value="team">
                        {t("tabs.teamsEnterprise")}
                    </TabsTrigger>
                </TabsList>
                <TabsContent value="individual" className="mt-4">
                    <div className={gridClass}>
                        {individualPlans.map(renderCard)}
                    </div>
                </TabsContent>
                <TabsContent value="team" className="mt-4">
                    <div className={gridClass}>{teamPlans.map(renderCard)}</div>
                </TabsContent>
            </Tabs>

            <PlusUpgradeModal
                open={upgradePlan !== null}
                plan={upgradePlan ?? "plus"}
                dailyTokens={
                    plans.find((p) => p.tierKey === upgradePlan)
                        ?.dailyTokens ?? null
                }
                onClose={() => setUpgradePlan(null)}
                onUpgraded={() => {
                    void reloadProfile();
                }}
            />

            <Dialog
                open={cancelOpen}
                onOpenChange={(open) => {
                    if (!cancelling) setCancelOpen(open);
                }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("cancelRenewal.title")}</DialogTitle>
                        <DialogDescription>
                            {periodEndLabel
                                ? t("cancelRenewal.bodyWithDate", {
                                      date: periodEndLabel,
                                  })
                                : t("cancelRenewal.body")}
                        </DialogDescription>
                    </DialogHeader>
                    {cancelError && (
                        <p className="text-sm text-destructive">
                            {t("cancelRenewal.error")}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={cancelling}
                            onClick={() => setCancelOpen(false)}
                        >
                            {t("cancelRenewal.keep")}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            className="border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive"
                            disabled={cancelling}
                            onClick={() => void confirmCancelRenewal()}
                        >
                            {cancelling
                                ? t("cancelRenewal.pending")
                                : t("cancelRenewal.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
