"use client";

/**
 * Plus subscription upgrade modal — opened from `RateLimitBanner` for
 * Free users that hit their daily token cap.
 *
 * The Eulex Desk app owns the entire flow:
 *   • POST /billing/plus/checkout → returns clientSecret
 *   • Stripe Elements `confirmPayment` confirms the PaymentIntent
 *   • The Stripe webhook (server-side) flips the local tier override
 *     and pushes the membership change to the partner site.
 *   • We `refreshRateLimitStatus()` immediately so the banner clears.
 */

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Stripe as StripeClient } from "@stripe/stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { getStoredTokens } from "@/lib/oauth";
import { track } from "@/app/lib/analytics";
import { refreshRateLimitStatus } from "../../hooks/useRateLimitStatus";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() || "http://localhost:3001";

type ConfigResponse = {
    plusEnabled: boolean;
    proEnabled?: boolean;
    teamEnabled?: boolean;
    legalProEnabled?: boolean;
    eulexLegalTeamEnabled?: boolean;
    publishableKey: string | null;
    partnerPushEnabled?: boolean;
};

export type UpgradePlan =
    | "plus"
    | "pro"
    | "team"
    | "legal_pro"
    | "eulex_legal_team";

type CreateSubscriptionResponse = {
    subscriptionId?: string;
    clientSecret?: string;
    type?: "payment" | "setup";
    amountDue?: number;
    subtotal?: number;
    taxAmount?: number;
    currency?: string;
    code?: string;
    message?: string;
};

function authHeaders(): Record<string, string> {
    const tokens = getStoredTokens();
    if (!tokens?.access_token) throw new Error("Not authenticated");
    return { Authorization: `Bearer ${tokens.access_token}` };
}

function formatPrice(amountCents?: number, currency = "EUR"): string {
    if (!amountCents) return `€19/mj`;
    const amount = amountCents / 100;
    const symbol = currency === "EUR" ? "€" : currency;
    return `${symbol}${amount.toFixed(amount % 1 === 0 ? 0 : 2)}/mj`;
}

let _stripeCache: { key: string; promise: Promise<StripeClient | null> } | null =
    null;
function getStripeClient(publishableKey: string): Promise<StripeClient | null> {
    if (_stripeCache && _stripeCache.key === publishableKey)
        return _stripeCache.promise;
    const promise = loadStripe(publishableKey);
    _stripeCache = { key: publishableKey, promise };
    return promise;
}

export function PlusUpgradeModal({
    open,
    onClose,
    onUpgraded,
    plan = "plus",
    dailyTokens = null,
}: {
    open: boolean;
    onClose: () => void;
    onUpgraded?: () => void;
    /** Which plan to check out. Defaults to "plus" (the banner callers). */
    plan?: UpgradePlan;
    /**
     * Daily token quota of the plan being bought, from GET /billing/plans
     * (`dailyTokens`) — the DB-backed truth, never hardcoded in copy.
     * `null`/`0` when the caller has no plans data → generic perk line.
     */
    dailyTokens?: number | null;
}) {
    const t = useTranslations("rateLimit");
    const tPlan = useTranslations("account.plan");
    const locale = useLocale();
    // Team tiers are per-seat (min 5). No seat picker yet — default to the
    // floor; Plus/Pro/Legal Pro are single-quantity.
    const seats =
        plan === "team" || plan === "eulex_legal_team" ? 5 : undefined;
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [sub, setSub] = useState<CreateSubscriptionResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    // Promo code: applying re-creates the subscription server-side with
    // the discount (backend cancels the stale incomplete one), so the
    // payment form remounts with the new clientSecret + amountDue.
    const [promoOpen, setPromoOpen] = useState(false);
    const [promoInput, setPromoInput] = useState("");
    const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
    const [promoError, setPromoError] = useState<string | null>(null);
    // Keep the first clientSecret stable in a ref so Elements never
    // remounts when `sub` gets an updated amountDue (tax came in, or
    // retry generated a new sub). Elements reads clientSecret only once
    // at mount — changing it unmounts+remounts the whole payment form.
    const stableClientSecret = useRef<string | null>(null);

    useEffect(() => {
        if (!open) {
            setSub(null);
            setError(null);
            setAttempt(0);
            setPromoOpen(false);
            setPromoInput("");
            setAppliedPromo(null);
            setPromoError(null);
            stableClientSecret.current = null;
            return;
        }
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const cfgRes = await fetch(`${API_BASE}/billing/plus/config`, {
                    headers: authHeaders(),
                });
                if (!cfgRes.ok) throw new Error(await cfgRes.text());
                const cfg = (await cfgRes.json()) as ConfigResponse;
                if (cancelled) return;
                setConfig(cfg);
                const planEnabled =
                    plan === "plus"
                        ? cfg.plusEnabled
                        : plan === "pro"
                          ? !!cfg.proEnabled
                          : plan === "team"
                            ? !!cfg.teamEnabled
                            : plan === "legal_pro"
                              ? !!cfg.legalProEnabled
                              : !!cfg.eulexLegalTeamEnabled;
                if (!planEnabled || !cfg.publishableKey) {
                    setError(
                        t.has("plusProxyDisabled")
                            ? t("plusProxyDisabled")
                            : "Subscription checkout is not yet enabled. Please try again later.",
                    );
                    return;
                }
                // Plus keeps its dedicated endpoint (live even before the
                // multi-product backend deploys); Pro/Team go through the
                // general checkout with the plan + seat count.
                const endpoint =
                    plan === "plus"
                        ? `${API_BASE}/billing/plus/checkout`
                        : `${API_BASE}/billing/checkout`;
                const checkoutBody = {
                    ...(plan === "plus" ? {} : { plan, seats }),
                    ...(appliedPromo ? { promo_code: appliedPromo } : {}),
                };
                const subRes = await fetch(endpoint, {
                    method: "POST",
                    headers: {
                        ...authHeaders(),
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(checkoutBody),
                });
                let subBody: CreateSubscriptionResponse & {
                    detail?: string;
                } = {};
                try {
                    subBody = await subRes.json();
                } catch {
                    // body wasn't JSON — leave subBody empty so we
                    // fall through to the generic message below
                }
                // Bad promo code is a recoverable input error, not a
                // checkout failure: surface it next to the promo field
                // and re-run without the code (clearing appliedPromo
                // retriggers this effect with a clean body).
                if (subRes.status === 400 && subBody.code === "INVALID_PROMO_CODE") {
                    if (!cancelled) {
                        setPromoError(
                            t.has("promoInvalid")
                                ? t("promoInvalid")
                                : "Nepoznat ili neaktivan promo kod",
                        );
                        setAppliedPromo(null);
                    }
                    return;
                }
                if (!subRes.ok || !subBody.clientSecret) {
                    const friendly =
                        (typeof subBody.message === "string" &&
                            subBody.message) ||
                        (typeof subBody.detail === "string" && subBody.detail) ||
                        (t.has("plusUpgradeError")
                            ? t("plusUpgradeError")
                            : "Could not start checkout right now.");
                    throw new Error(friendly);
                }
                if (!cancelled) {
                    // Capture clientSecret into stable ref on first load.
                    // Subsequent calls (retry / tax update) may return a
                    // different secret — we intentionally ignore that so
                    // Elements doesn't remount.
                    if (!stableClientSecret.current && subBody.clientSecret) {
                        stableClientSecret.current = subBody.clientSecret;
                        // Stripe checkout session is ready — the user is
                        // about to see the payment form. Fire once per open.
                        track("checkout_started", { tier: plan });
                    }
                    setSub(subBody);
                }
            } catch (err) {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, t, attempt, plan, seats, appliedPromo]);

    function applyPromo() {
        const code = promoInput.trim();
        if (!code) return;
        setPromoError(null);
        // Force a fresh subscription + Elements remount so the discounted
        // clientSecret (and amountDue) replace the full-price one.
        stableClientSecret.current = null;
        setSub(null);
        setAppliedPromo(code);
    }

    function removePromo() {
        setPromoError(null);
        setPromoInput("");
        stableClientSecret.current = null;
        setSub(null);
        setAppliedPromo(null);
    }

    const stripeP = useMemo(() => {
        if (!config?.publishableKey) return null;
        return getStripeClient(config.publishableKey);
    }, [config?.publishableKey]);

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            {/* z-[210]/[211]: this checkout is often opened FROM inside
                PlansModal (z-[200]/[201]). Without an explicit lift it would
                render at the dialog default (z-50) and sit BEHIND the plan
                modal — the Stripe form (and its errors) would be invisible.
                Keep one tier above PlansModal so the payment step is on top. */}
            <DialogContent
                overlayClassName="z-[210]"
                className="z-[211] flex max-h-[92vh] w-full max-w-lg flex-col overflow-y-auto"
            >
                <DialogHeader>
                    <DialogTitle className="font-serif text-2xl">
                        {tPlan("upgradeTo", {
                            plan: tPlan(`tiers.${plan}.name`),
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {sub?.amountDue
                            ? formatPrice(sub.amountDue, sub.currency ?? "EUR")
                            : `${tPlan(`tiers.${plan}.price`)} ${tPlan(`tiers.${plan}.period`)}`}{" "}
                        ·{" "}
                        {t.has("plusUpgradeCancelAnytime")
                            ? t("plusUpgradeCancelAnytime")
                            : "Otkaži kada želiš"}
                    </DialogDescription>
                </DialogHeader>

                <ul className="mt-4 space-y-2 rounded-xl bg-gradient-to-br from-warning/10 to-warning/5 p-4 text-sm text-foreground ring-1 ring-warning/20">
                    {/* Daily quota perk — interpolated from the plan catalog
                        (DB truth), not hardcoded copy. Generic line when the
                        caller had no plans data. */}
                    <FeatureLi>
                        {dailyTokens && dailyTokens > 0
                            ? t("plusUpgradePerks.tokens", {
                                  tokens: new Intl.NumberFormat(
                                      locale === "hr" ? "hr-HR" : "en-US",
                                  ).format(dailyTokens),
                              })
                            : t("plusUpgradePerks.tokensFallback")}
                    </FeatureLi>
                    {(tPlan.raw(`tiers.${plan}.features`) as string[]).map(
                        (f, i) => (
                            <FeatureLi key={i}>{f}</FeatureLi>
                        ),
                    )}
                </ul>

                {sub?.taxAmount != null && sub.taxAmount > 0 && sub.subtotal != null && (
                    <div className="mt-4 space-y-1 rounded-lg border border-border p-3 text-sm">
                        <Row
                            label={
                                t.has("plusUpgradeSubscription")
                                    ? t("plusUpgradeSubscription")
                                    : "Pretplata"
                            }
                            value={`€${(sub.subtotal / 100).toFixed(2)}`}
                        />
                        <Row
                            label={
                                t.has("plusUpgradeVat")
                                    ? t("plusUpgradeVat")
                                    : "PDV"
                            }
                            value={`€${(sub.taxAmount / 100).toFixed(2)}`}
                            muted
                        />
                        <div className="mt-1 border-t border-border pt-1">
                            <Row
                                label={
                                    t.has("plusUpgradeTotal")
                                        ? t("plusUpgradeTotal")
                                        : "Ukupno"
                                }
                                value={`€${((sub.amountDue ?? 0) / 100).toFixed(2)}`}
                                bold
                            />
                        </div>
                    </div>
                )}

                {/* ── promo code ─────────────────────────────────── */}
                <div className="mt-3">
                    {appliedPromo && sub ? (
                        <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                            <span>
                                {t.has("promoApplied")
                                    ? t("promoApplied", { code: appliedPromo })
                                    : `Kod ${appliedPromo} primijenjen`}
                            </span>
                            <button
                                type="button"
                                onClick={removePromo}
                                className="text-xs font-medium text-emerald-700 underline hover:text-emerald-900"
                            >
                                {t.has("promoRemove")
                                    ? t("promoRemove")
                                    : "Ukloni"}
                            </button>
                        </div>
                    ) : !promoOpen ? (
                        <button
                            type="button"
                            onClick={() => setPromoOpen(true)}
                            className="text-xs font-medium text-blue-600 hover:underline"
                        >
                            {t.has("promoHave")
                                ? t("promoHave")
                                : "Imam promo kod"}
                        </button>
                    ) : (
                        <div>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={promoInput}
                                    onChange={(e) => {
                                        setPromoInput(e.target.value);
                                        setPromoError(null);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            applyPromo();
                                        }
                                    }}
                                    placeholder={
                                        t.has("promoPlaceholder")
                                            ? t("promoPlaceholder")
                                            : "Promo kod"
                                    }
                                    className="h-9 flex-1 rounded-md border border-gray-200 px-3 text-sm uppercase placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-black/10"
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={applyPromo}
                                    disabled={!promoInput.trim() || loading}
                                    className="h-9"
                                >
                                    {t.has("promoApply")
                                        ? t("promoApply")
                                        : "Primijeni"}
                                </Button>
                            </div>
                            {promoError && (
                                <p className="mt-1.5 text-xs text-red-600">
                                    {promoError}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {error && !loading && (
                    <div className="mt-4 flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                        <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="mt-0.5 shrink-0"
                            aria-hidden
                        >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        <div className="flex-1">
                            <div className="font-medium">
                                {t.has("plusUpgradeError")
                                    ? t("plusUpgradeError")
                                    : "Could not start checkout."}
                            </div>
                            <div className="mt-0.5 text-xs text-destructive/90">
                                {error}
                            </div>
                            <button
                                type="button"
                                onClick={() => setAttempt((n) => n + 1)}
                                className="mt-2 inline-flex items-center gap-1 rounded-md border border-destructive/20 bg-background px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                            >
                                <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden
                                >
                                    <polyline points="23 4 23 10 17 10" />
                                    <path d="M20.49 15A9 9 0 1 1 18.36 6.64L23 10" />
                                </svg>
                                {t.has("plusUpgradeRetry")
                                    ? t("plusUpgradeRetry")
                                    : "Try again"}
                            </button>
                        </div>
                    </div>
                )}

                {loading && (
                    <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            className="animate-spin"
                            aria-hidden
                        >
                            <circle
                                cx="12"
                                cy="12"
                                r="9"
                                fill="none"
                                stroke="currentColor"
                                strokeOpacity="0.25"
                                strokeWidth="3"
                            />
                            <path
                                d="M21 12a9 9 0 0 0-9-9"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                            />
                        </svg>
                        <span>
                            {t.has("plusUpgradeLoading")
                                ? t("plusUpgradeLoading")
                                : t.has("loading")
                                  ? t("loading")
                                  : "Učitavam…"}
                        </span>
                    </div>
                )}

                {stableClientSecret.current && stripeP && (
                    <div className="mt-5">
                        <Elements
                            stripe={stripeP}
                            options={{
                                clientSecret: stableClientSecret.current,
                                locale: locale === "en" ? "en" : "hr",
                                appearance: {
                                    theme: "stripe",
                                    variables: {
                                        // Stripe renders inside its own iframe — CSS vars
                                        // from our document don't resolve there. literal-ok
                                        colorPrimary: "#0f172a", // literal-ok
                                        colorText: "#0f172a", // literal-ok
                                        borderRadius: "8px",
                                    },
                                },
                            }}
                        >
                            <PlusCheckoutForm
                                onCancel={onClose}
                                onSuccess={async () => {
                                    try {
                                        await refreshRateLimitStatus();
                                    } catch {
                                        // status refresh is best-effort
                                    }
                                    onUpgraded?.();
                                    onClose();
                                }}
                            />
                        </Elements>
                    </div>
                )}

                <p className="mt-4 text-center text-[11px] text-muted-foreground">
                    {t.has("plusUpgradeSecure")
                        ? t("plusUpgradeSecure")
                        : "Sigurna naplata · Stripe"}
                </p>
            </DialogContent>
        </Dialog>
    );
}

function FeatureLi({ children }: { children: React.ReactNode }) {
    return (
        <li className="flex items-start gap-2">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--foreground)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 shrink-0"
                aria-hidden
            >
                <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{children}</span>
        </li>
    );
}

function Row({
    label,
    value,
    bold,
    muted,
}: {
    label: string;
    value: string;
    bold?: boolean;
    muted?: boolean;
}) {
    return (
        <div
            className={`flex items-center justify-between ${
                bold ? "font-semibold text-foreground" : ""
            } ${muted ? "text-muted-foreground" : ""}`}
        >
            <span>{label}</span>
            <span>{value}</span>
        </div>
    );
}

/**
 * Stripe Elements form. Confirms the SetupIntent / PaymentIntent
 * inline (`redirect: 'if_required'`) so the user never leaves the
 * Eulex Desk app. On success we POST `/billing/plus/activate-membership`
 * which forwards to WordPress, which assigns UMP level 2 and updates
 * our DB override.
 */
function PlusCheckoutForm({
    onCancel,
    onSuccess,
}: {
    onCancel: () => void;
    onSuccess: () => void;
}) {
    const stripe = useStripe();
    const elements = useElements();
    const t = useTranslations("rateLimit");
    const [submitting, setSubmitting] = useState(false);
    const [errMsg, setErrMsg] = useState<string | null>(null);
    // PaymentElement mounts asynchronously after Stripe.js finishes
    // loading the per-payment-method scripts. If the user clicks
    // Subscribe before that finishes Stripe throws "elements should
    // have a mounted Payment Element" — we keep submit disabled until
    // the element fires its onReady so the click physically can't
    // happen too early. Also drives the inline spinner so the user
    // knows we're still doing something.
    const [paymentReady, setPaymentReady] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!stripe || !elements || !paymentReady) return;
        setSubmitting(true);
        setErrMsg(null);
        try {
            // elements.submit() validates the PaymentElement and forces
            // it to fully mount before confirmPayment runs. Without
            // this Stripe occasionally rejects with "elements should
            // have a mounted Payment Element" when confirmPayment fires
            // during the brief window where the iframe finished
            // network-loading but hadn't bound to the parent Elements
            // instance yet. Errors here are validation failures the
            // user can fix (missing card details) — show them and
            // bail out before we touch the PaymentIntent.
            const submitResult = await elements.submit();
            if (submitResult.error) {
                setErrMsg(
                    submitResult.error.message ??
                        "Greška pri potvrdi plaćanja",
                );
                setSubmitting(false);
                return;
            }
            const result = await stripe.confirmPayment({
                elements,
                confirmParams: {
                    return_url: `${window.location.origin}/account/billing?plus=success`,
                },
                redirect: "if_required",
            });
            if (result.error) {
                setErrMsg(result.error.message ?? "Greška pri potvrdi plaćanja");
                setSubmitting(false);
                return;
            }
            // No frontend "activate" call — the Stripe webhook
            // (`customer.subscription.created` / `invoice.paid`) is
            // authoritative. We just refresh the local snapshot and
            // close the modal.
            onSuccess();
        } catch (err) {
            setErrMsg(err instanceof Error ? err.message : String(err));
            setSubmitting(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
                <PaymentElement
                    options={{ layout: "tabs" }}
                    onReady={() => setPaymentReady(true)}
                />
                {!paymentReady && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-background/80 text-xs text-muted-foreground">
                        <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            className="animate-spin mr-2"
                            aria-hidden
                        >
                            <circle
                                cx="12"
                                cy="12"
                                r="9"
                                fill="none"
                                stroke="currentColor"
                                strokeOpacity="0.25"
                                strokeWidth="3"
                            />
                            <path
                                d="M21 12a9 9 0 0 0-9-9"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                                strokeLinecap="round"
                            />
                        </svg>
                        {t.has("plusUpgradeLoadingPayment")
                            ? t("plusUpgradeLoadingPayment")
                            : "Učitavam naplatu…"}
                    </div>
                )}
            </div>
            {errMsg && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {errMsg}
                </div>
            )}
            <div className="flex justify-end gap-2">
                <Button
                    type="button"
                    variant="outline"
                    onClick={onCancel}
                    disabled={submitting}
                >
                    {t.has("plusUpgradeCancel")
                        ? t("plusUpgradeCancel")
                        : "Odustani"}
                </Button>
                <Button
                    type="submit"
                    disabled={!stripe || !paymentReady || submitting}
                >
                    {submitting
                        ? t.has("plusUpgradeProcessing")
                            ? t("plusUpgradeProcessing")
                            : "Obrađujem…"
                        : t.has("plusUpgradeSubmit")
                          ? t("plusUpgradeSubmit")
                          : "Pretplati se"}
                </Button>
            </div>
        </form>
    );
}
