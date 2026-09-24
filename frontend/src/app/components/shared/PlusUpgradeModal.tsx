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
import { COUNTRIES } from "@/lib/countries";
import { cn } from "@/lib/utils";
import { track } from "@/app/lib/analytics";
import { refreshRateLimitStatus } from "../../hooks/useRateLimitStatus";
import { useUserProfile } from "@/contexts/UserProfileContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

import { API_BASE } from "@/app/lib/apiBase";
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

function formatPrice(
    amountCents: number | undefined,
    currency: string,
    perMonthSuffix: string,
): string {
    if (!amountCents) return `€19${perMonthSuffix}`;
    const amount = amountCents / 100;
    const symbol = currency === "EUR" ? "€" : currency;
    return `${symbol}${amount.toFixed(amount % 1 === 0 ? 0 : 2)}${perMonthSuffix}`;
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
    // Localised country names live under "countries.<CODE>" (same table
    // the Settings page uses); lib/countries.ts labels are the fallback.
    const tCountries = useTranslations("countries");
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

    // ── billing details (tracker #33) ───────────────────────────────
    // Name + country are MANDATORY before the subscription is created:
    // the backend writes them onto the Stripe customer ahead of
    // sub.create so the very first invoice carries VAT. Organisation and
    // VAT ID are optional (a company name takes the invoice "Bill to"
    // line; an EU VAT ID enables reverse charge cross-border). Prefilled
    // from Settings → General; the step is shown only while a required
    // field is missing, and whatever the user confirms is saved back to
    // the profile by the backend.
    const { profile } = useUserProfile();
    const [billingName, setBillingName] = useState("");
    const [billingCountry, setBillingCountry] = useState("");
    const [billingOrg, setBillingOrg] = useState("");
    const [billingVat, setBillingVat] = useState("");
    // Business invoice (tracker #35). Zakon o PDV-u čl. 79. st. 1. t. 3.:
    // the invoice must carry the buyer's name, ADDRESS and OIB / VAT ID —
    // so once the user says "invoice to a company" the company name,
    // street, city and OIB/VAT ID all become mandatory. Postal code and
    // phone stay optional.
    const [billingBusiness, setBillingBusiness] = useState(false);
    const [billingLine1, setBillingLine1] = useState("");
    const [billingCity, setBillingCity] = useState("");
    const [billingPostal, setBillingPostal] = useState("");
    // Optional for everyone (tracker #37) — čl. 79. ZPDV does not ask for
    // a phone; we take it only if the user wants it on the account.
    const [billingPhone, setBillingPhone] = useState("");
    // Flips true once the user submits a complete billing step (or the
    // profile already had name + country). Gates the checkout call.
    const [billingReady, setBillingReady] = useState(false);
    const [billingTouched, setBillingTouched] = useState(false);
    // Set when /change-plan handled the request itself (tracker #34): an
    // existing subscriber's upgrade is prorated and applied at once, a
    // downgrade is scheduled for the period end. No payment form then —
    // Stripe charged the saved card for the prorated difference.
    const [changeDone, setChangeDone] = useState<{
        action: "upgraded" | "scheduled";
        periodEnd: number | null;
    } | null>(null);
    const billingBusinessComplete =
        !billingBusiness ||
        (billingOrg.trim().length > 0 &&
            billingVat.trim().length > 0 &&
            billingLine1.trim().length > 0 &&
            billingCity.trim().length > 0);
    const billingComplete =
        billingName.trim().length > 0 &&
        /^[A-Z]{2}$/.test(billingCountry) &&
        billingBusinessComplete;

    useEffect(() => {
        if (!open) return;
        const name = (profile?.displayName ?? "").trim();
        const country = (profile?.country ?? "").trim().toUpperCase();
        setBillingName(name);
        setBillingCountry(/^[A-Z]{2}$/.test(country) ? country : "");
        const org = (profile?.organisation ?? "").trim();
        const vat = (profile?.vatNumber ?? "").trim();
        const line1 = (profile?.addressLine1 ?? "").trim();
        const city = (profile?.addressCity ?? "").trim();
        setBillingOrg(org);
        setBillingVat(vat);
        setBillingLine1(line1);
        setBillingCity(city);
        setBillingPostal((profile?.addressPostalCode ?? "").trim());
        setBillingPhone((profile?.phone ?? "").trim());
        // A stored company name or VAT ID means "business invoice" — and
        // then the address is mandatory too, so the step reappears until
        // street + city are on file.
        const business = org.length > 0 || vat.length > 0;
        setBillingBusiness(business);
        const businessOk =
            !business || (org.length > 0 && vat.length > 0 && line1.length > 0 && city.length > 0);
        setBillingReady(
            name.length > 0 && /^[A-Z]{2}$/.test(country) && businessOk,
        );
        setBillingTouched(false);
        // Snapshot the profile when the modal opens; later profile
        // refreshes must not clobber what the user is typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) {
            setSub(null);
            setError(null);
            setAttempt(0);
            setPromoOpen(false);
            setPromoInput("");
            setAppliedPromo(null);
            setPromoError(null);
            setBillingReady(false);
            setChangeDone(null);
            stableClientSecret.current = null;
            return;
        }
        // Nothing is created server-side until billing details are in.
        if (!billingReady) return;
        // Already handled by /change-plan — don't start a checkout.
        if (changeDone) return;
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
                // ── existing subscriber? change the plan, don't add one ──
                // (tracker #34) /change-plan prorates an upgrade and
                // applies it now, or schedules a downgrade for the period
                // end. Only when it answers `action: "checkout"` (no live
                // subscription) do we fall through and create one. Any
                // other failure also falls through: checkout's own 409
                // guard is the backstop against a duplicate.
                try {
                    const cpRes = await fetch(`${API_BASE}/billing/change-plan`, {
                        method: "POST",
                        headers: {
                            ...authHeaders(),
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            tier: plan,
                            ...(seats ? { seats } : {}),
                            country: billingCountry,
                        }),
                    });
                    const cp = (await cpRes.json()) as {
                        action?: "upgraded" | "scheduled" | "checkout";
                        current_period_end?: number | null;
                    };
                    if (
                        cpRes.ok &&
                        (cp.action === "upgraded" || cp.action === "scheduled")
                    ) {
                        if (cancelled) return;
                        track("plan_change_completed", {
                            tier: plan,
                            action: cp.action,
                        });
                        setChangeDone({
                            action: cp.action,
                            periodEnd: cp.current_period_end ?? null,
                        });
                        try {
                            await refreshRateLimitStatus();
                        } catch {
                            // best-effort
                        }
                        onUpgraded?.();
                        return;
                    }
                } catch {
                    // fall through to checkout
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
                    // Mandatory billing details (tracker #33) — the
                    // backend refuses to create a subscription without
                    // name + country, and persists all four to the profile.
                    name: billingName.trim(),
                    country: billingCountry,
                    business: billingBusiness,
                    organisation: billingBusiness ? billingOrg.trim() || null : null,
                    vat_number: billingBusiness ? billingVat.trim() || null : null,
                    address_line1: billingLine1.trim() || null,
                    address_city: billingCity.trim() || null,
                    address_postal_code: billingPostal.trim() || null,
                    phone: billingPhone.trim() || null,
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
                // Backstop (tracker #34): the pre-flight above should have
                // routed an existing subscriber to /change-plan; if the
                // backend still refuses a second subscription, say so —
                // never retry into a duplicate.
                if (subRes.status === 409 && subBody.code === "ACTIVE_SUBSCRIPTION_EXISTS") {
                    if (!cancelled) setError(t("billingActiveSubExists"));
                    return;
                }
                // Billing-detail rejections (tracker #33) send the user
                // back to the billing step instead of the generic error
                // card — these are things they can fix in place.
                if (
                    subRes.status === 400 &&
                    (subBody.code === "COUNTRY_REQUIRED" ||
                        subBody.code === "NAME_REQUIRED" ||
                        subBody.code === "ORGANISATION_REQUIRED" ||
                        subBody.code === "VAT_ID_REQUIRED" ||
                        subBody.code === "ADDRESS_REQUIRED" ||
                        subBody.code === "TAX_LOCATION_UNRESOLVED")
                ) {
                    if (!cancelled) {
                        setBillingReady(false);
                        setBillingTouched(true);
                        setError(
                            subBody.code === "TAX_LOCATION_UNRESOLVED"
                                ? t("billingTaxUnresolved")
                                : t("billingRequired"),
                        );
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
    }, [
        open,
        t,
        attempt,
        plan,
        seats,
        appliedPromo,
        billingReady,
        billingName,
        billingCountry,
        billingOrg,
        billingVat,
        billingBusiness,
        billingLine1,
        billingCity,
        billingPostal,
        billingPhone,
        changeDone,
        onUpgraded,
    ]);

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
                            ? formatPrice(
                                  sub.amountDue,
                                  sub.currency ?? "EUR",
                                  t("perMonthSuffix"),
                              )
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

                {/* ── billing details step (tracker #33) ─────────────
                    Shown until name + country are confirmed. Nothing is
                    created on the server before this passes. */}
                {!billingReady && (
                    <form
                        className="mt-4 space-y-3 rounded-lg border border-border p-3"
                        onSubmit={(e) => {
                            e.preventDefault();
                            setBillingTouched(true);
                            if (!billingComplete) return;
                            setError(null);
                            setBillingReady(true);
                        }}
                        noValidate
                    >
                        <p className="text-sm font-medium text-foreground">
                            {t("billingTitle")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {t("billingHint")}
                        </p>
                        <div>
                            <label
                                htmlFor="checkout-billing-name"
                                className="mb-1 block text-xs text-muted-foreground"
                            >
                                {t("billingName")} *
                            </label>
                            <Input
                                id="checkout-billing-name"
                                value={billingName}
                                onChange={(e) => setBillingName(e.target.value)}
                                autoComplete="name"
                                required
                                aria-invalid={
                                    billingTouched && !billingName.trim()
                                        ? true
                                        : undefined
                                }
                            />
                        </div>
                        <div>
                            <label
                                htmlFor="checkout-billing-country"
                                className="mb-1 block text-xs text-muted-foreground"
                            >
                                {t("billingCountry")} *
                            </label>
                            <select
                                id="checkout-billing-country"
                                value={billingCountry}
                                onChange={(e) =>
                                    setBillingCountry(e.target.value.toUpperCase())
                                }
                                required
                                aria-invalid={
                                    billingTouched && !billingCountry
                                        ? true
                                        : undefined
                                }
                                className={cn(
                                    "h-10 w-full rounded-md border border-input bg-surface-elevated px-3 text-sm text-foreground",
                                    "focus:outline-none focus:ring-2 focus:ring-ring/10",
                                    billingTouched &&
                                        !billingCountry &&
                                        "border-destructive",
                                )}
                            >
                                <option value="">{t("billingCountryPlaceholder")}</option>
                                {COUNTRIES.map((c) => (
                                    <option key={c.code} value={c.code}>
                                        {tCountries.has(c.code)
                                            ? tCountries(c.code)
                                            : c.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label
                                htmlFor="checkout-billing-phone"
                                className="mb-1 block text-xs text-muted-foreground"
                            >
                                {t("billingPhone")}
                            </label>
                            <Input
                                id="checkout-billing-phone"
                                type="tel"
                                value={billingPhone}
                                onChange={(e) => setBillingPhone(e.target.value)}
                                autoComplete="tel"
                                placeholder={t("billingPhonePlaceholder")}
                            />
                        </div>
                        {/* Business invoice toggle (tracker #35). Typing a
                            company name or OIB/VAT ID switches it on too —
                            either one makes the whole set mandatory
                            (čl. 79. ZPDV: name, address, OIB/VAT ID). */}
                        <label className="flex items-center gap-2 text-sm text-foreground">
                            <input
                                type="checkbox"
                                checked={billingBusiness}
                                onChange={(e) => setBillingBusiness(e.target.checked)}
                                className="h-4 w-4 rounded border-input accent-primary"
                            />
                            {t("billingBusiness")}
                        </label>
                        {billingBusiness && (
                            <div className="space-y-3 rounded-md border border-border bg-accent/40 p-3">
                                <p className="text-xs text-muted-foreground">
                                    {t("billingBusinessHint")}
                                </p>
                                <div>
                                    <label
                                        htmlFor="checkout-billing-org"
                                        className="mb-1 block text-xs text-muted-foreground"
                                    >
                                        {t("billingOrganisation")} *
                                    </label>
                                    <Input
                                        id="checkout-billing-org"
                                        value={billingOrg}
                                        onChange={(e) => setBillingOrg(e.target.value)}
                                        autoComplete="organization"
                                        required
                                        aria-invalid={
                                            billingTouched && !billingOrg.trim()
                                                ? true
                                                : undefined
                                        }
                                    />
                                </div>
                                <div>
                                    <label
                                        htmlFor="checkout-billing-vat"
                                        className="mb-1 block text-xs text-muted-foreground"
                                    >
                                        {t("billingVatId")} *
                                    </label>
                                    <Input
                                        id="checkout-billing-vat"
                                        value={billingVat}
                                        onChange={(e) =>
                                            setBillingVat(e.target.value.toUpperCase())
                                        }
                                        placeholder={t("billingVatPlaceholder")}
                                        className="uppercase placeholder:normal-case"
                                        required
                                        aria-invalid={
                                            billingTouched && !billingVat.trim()
                                                ? true
                                                : undefined
                                        }
                                    />
                                    <p className="mt-1 text-[11px] text-muted-foreground">
                                        {t("billingVatHint")}
                                    </p>
                                </div>
                                <div>
                                    <label
                                        htmlFor="checkout-billing-line1"
                                        className="mb-1 block text-xs text-muted-foreground"
                                    >
                                        {t("billingAddressLine1")} *
                                    </label>
                                    <Input
                                        id="checkout-billing-line1"
                                        value={billingLine1}
                                        onChange={(e) => setBillingLine1(e.target.value)}
                                        autoComplete="street-address"
                                        required
                                        aria-invalid={
                                            billingTouched && !billingLine1.trim()
                                                ? true
                                                : undefined
                                        }
                                    />
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <div className="col-span-2">
                                        <label
                                            htmlFor="checkout-billing-city"
                                            className="mb-1 block text-xs text-muted-foreground"
                                        >
                                            {t("billingAddressCity")} *
                                        </label>
                                        <Input
                                            id="checkout-billing-city"
                                            value={billingCity}
                                            onChange={(e) => setBillingCity(e.target.value)}
                                            autoComplete="address-level2"
                                            required
                                            aria-invalid={
                                                billingTouched && !billingCity.trim()
                                                    ? true
                                                    : undefined
                                            }
                                        />
                                    </div>
                                    <div>
                                        <label
                                            htmlFor="checkout-billing-postal"
                                            className="mb-1 block text-xs text-muted-foreground"
                                        >
                                            {t("billingAddressPostal")}
                                        </label>
                                        <Input
                                            id="checkout-billing-postal"
                                            value={billingPostal}
                                            onChange={(e) => setBillingPostal(e.target.value)}
                                            autoComplete="postal-code"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                        {billingTouched && !billingComplete && (
                            <p className="text-xs text-destructive">
                                {t("billingRequired")}
                            </p>
                        )}
                        <div className="flex justify-end">
                            <Button type="submit" disabled={loading}>
                                {t("billingContinue")}
                            </Button>
                        </div>
                    </form>
                )}

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

                {/* ── plan changed via /change-plan (tracker #34) ──
                    Existing subscriber: no payment form. Upgrade was
                    prorated and charged to the saved card; downgrade
                    takes effect at the paid-through date. */}
                {changeDone && (
                    <div className="mt-5 space-y-3 rounded-xl border border-border bg-accent p-4 text-sm text-foreground">
                        <p className="font-medium">
                            {changeDone.action === "upgraded"
                                ? t("billingPlanUpgraded", {
                                      plan: tPlan(`tiers.${plan}.name`),
                                  })
                                : t("billingPlanScheduled", {
                                      plan: tPlan(`tiers.${plan}.name`),
                                      date: changeDone.periodEnd
                                          ? new Intl.DateTimeFormat(
                                                locale === "hr" ? "hr-HR" : "en-GB",
                                                { dateStyle: "long" },
                                            ).format(new Date(changeDone.periodEnd * 1000))
                                          : "—",
                                  })}
                        </p>
                        <div className="flex justify-end">
                            <Button type="button" onClick={onClose}>
                                {t("billingPlanClose")}
                            </Button>
                        </div>
                    </div>
                )}

                {!changeDone && stableClientSecret.current && stripeP && (
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
