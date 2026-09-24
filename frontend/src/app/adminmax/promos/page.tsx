"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    clearAdminToken,
    createPromo,
    getAdminToken,
    listPromos,
    setPromoActive,
    type AdminPromoCode,
} from "../lib/adminApi";

/**
 * Paid plans a promo code can be restricted to. Keys match the backend
 * plan registry (lib/stripe.ts getPlanDefs); the backend also returns
 * tier slugs in `plans`, hence the slug aliases in PLAN_LABELS.
 */
const PLAN_OPTIONS = [
    { key: "plus", label: "Plus" },
    { key: "pro", label: "Pro" },
    { key: "legal_pro", label: "Legal Pro" },
    { key: "team", label: "Team" },
    { key: "eulex_legal_team", label: "Legal Team" },
] as const;

const PLAN_LABELS: Record<string, string> = {
    plus: "Plus",
    eulex_plus: "Plus",
    pro: "Pro",
    legal_pro: "Legal Pro",
    team: "Team",
    eulex_legal_team: "Legal Team",
};

function fmtEur(cents: number): string {
    return new Intl.NumberFormat("hr-HR", {
        style: "currency",
        currency: "EUR",
    }).format(cents / 100);
}

function fmtDate(s: string | null): string {
    if (!s) return "—";
    try {
        return new Date(s).toLocaleDateString("hr-HR", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
    } catch {
        return s;
    }
}

function durationLabel(p: AdminPromoCode): string {
    switch (p.duration) {
        case "forever":
            return "Trajno";
        case "once":
            return "Prva naplata";
        case "repeating":
            return p.duration_in_months
                ? `${p.duration_in_months} mj.`
                : "Ponavljajuće";
        default:
            return "—";
    }
}

function discountLabel(p: AdminPromoCode): string {
    if (p.percent_off != null) return `${p.percent_off}%`;
    if (p.amount_off != null) {
        return fmtEur(p.amount_off) + (p.currency ? ` ${p.currency}` : "");
    }
    return "—";
}

export default function AdminMaxPromosPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [configured, setConfigured] = useState(true);
    const [promos, setPromos] = useState<AdminPromoCode[]>([]);
    const [togglingId, setTogglingId] = useState<string | null>(null);

    useEffect(() => {
        if (!getAdminToken()) {
            router.replace("/adminmax/login");
        }
    }, [router]);

    async function load() {
        setLoading(true);
        setError(null);
        try {
            const res = await listPromos();
            setConfigured(res.configured);
            setPromos(res.promos);
        } catch (err) {
            if (err instanceof AdminUnauthorizedError) {
                router.replace("/adminmax/login");
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function toggle(p: AdminPromoCode) {
        setTogglingId(p.id);
        setError(null);
        try {
            await setPromoActive(p.id, !p.active);
            setPromos((rows) =>
                rows.map((r) =>
                    r.id === p.id ? { ...r, active: !p.active } : r,
                ),
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setTogglingId(null);
        }
    }

    function logout() {
        clearAdminToken();
        router.replace("/adminmax/login");
    }

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <h1 className="font-serif text-2xl font-semibold tracking-tight">
                        AdminMax · Promo kodovi
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Stripe kuponi + promotion kodovi. Iskorištenja broji
                        Stripe; računi/prihod dolaze iz billing_revenue
                        atribucije (od uvođenja stupca promo_code nadalje).
                    </p>
                </div>
                <div className="flex items-end gap-3">
                    <Link
                        href="/adminmax"
                        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
                    >
                        ← Potrošnja
                    </Link>
                    <button
                        onClick={load}
                        disabled={loading}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {loading ? "Učitavam…" : "Osvježi"}
                    </button>
                    <button
                        onClick={logout}
                        className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                    >
                        Odjava
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {!configured && !loading && (
                <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                    Stripe nije konfiguriran na ovom okruženju.
                </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Kod
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Popust
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Trajanje
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Paketi
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Vrijedi do
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Iskorišteno
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Računi
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Pretplatnici
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Prihod
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Status
                            </th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {promos.length === 0 && !loading && (
                            <tr>
                                <td
                                    colSpan={11}
                                    className="px-4 py-6 text-center text-muted-foreground/70"
                                >
                                    Nema promo kodova.
                                </td>
                            </tr>
                        )}
                        {promos.map((p) => (
                            <tr
                                key={p.id}
                                className="border-t border-border align-middle"
                            >
                                <td className="px-4 py-2 font-mono font-medium">
                                    {p.code}
                                </td>
                                <td className="px-4 py-2 text-right">
                                    {discountLabel(p)}
                                </td>
                                <td className="px-4 py-2">
                                    {durationLabel(p)}
                                </td>
                                <td className="px-4 py-2">
                                    {p.plans.length === 0
                                        ? "Svi"
                                        : p.plans
                                              .map(
                                                  (s) => PLAN_LABELS[s] ?? s,
                                              )
                                              .join(", ")}
                                </td>
                                <td className="px-4 py-2">
                                    {fmtDate(p.expires_at)}
                                </td>
                                <td className="px-4 py-2 text-right">
                                    {p.times_redeemed}
                                    {p.max_redemptions
                                        ? ` / ${p.max_redemptions}`
                                        : ""}
                                </td>
                                <td className="px-4 py-2 text-right">
                                    {p.stats?.invoices ?? 0}
                                </td>
                                <td className="px-4 py-2 text-right">
                                    {p.stats?.subscribers ?? 0}
                                </td>
                                <td className="px-4 py-2 text-right">
                                    {p.stats ? fmtEur(p.stats.revenue_cents) : "—"}
                                </td>
                                <td className="px-4 py-2">
                                    <span
                                        className={
                                            p.active
                                                ? "rounded-full bg-action/10 px-2 py-0.5 text-xs font-medium text-action"
                                                : "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                                        }
                                    >
                                        {p.active ? "Aktivan" : "Neaktivan"}
                                    </span>
                                </td>
                                <td className="px-4 py-2 text-right">
                                    <button
                                        onClick={() => toggle(p)}
                                        disabled={togglingId === p.id}
                                        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                                    >
                                        {togglingId === p.id
                                            ? "…"
                                            : p.active
                                              ? "Deaktiviraj"
                                              : "Aktiviraj"}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {configured && (
                <NewPromoForm
                    onCreated={async () => {
                        await load();
                    }}
                    onError={(msg) => setError(msg)}
                />
            )}
        </div>
    );
}

function NewPromoForm({
    onCreated,
    onError,
}: {
    onCreated: () => Promise<void>;
    onError: (msg: string) => void;
}) {
    const [code, setCode] = useState("");
    const [percent, setPercent] = useState("20");
    const [duration, setDuration] = useState<"forever" | "once" | "repeating">(
        "forever",
    );
    const [months, setMonths] = useState("12");
    const [selectedPlans, setSelectedPlans] = useState<string[]>([
        "pro",
        "legal_pro",
        "team",
        "eulex_legal_team",
    ]);
    const [expiresAt, setExpiresAt] = useState("");
    const [maxRedemptions, setMaxRedemptions] = useState("");
    const [saving, setSaving] = useState(false);

    function togglePlan(key: string) {
        setSelectedPlans((prev) =>
            prev.includes(key)
                ? prev.filter((k) => k !== key)
                : [...prev, key],
        );
    }

    async function submit() {
        const pct = Number(percent);
        if (!code.trim() || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
            onError("Unesi kod i postotak (1–100).");
            return;
        }
        setSaving(true);
        try {
            await createPromo({
                code: code.trim(),
                percent_off: pct,
                duration,
                ...(duration === "repeating"
                    ? { duration_in_months: Number(months) || 12 }
                    : {}),
                // Prazan odabir = kod vrijedi na svim proizvodima.
                ...(selectedPlans.length ? { plans: selectedPlans } : {}),
                ...(expiresAt ? { expires_at: expiresAt } : {}),
                ...(maxRedemptions
                    ? { max_redemptions: Number(maxRedemptions) }
                    : {}),
            });
            setCode("");
            await onCreated();
        } catch (err) {
            onError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="space-y-4 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Novi promo kod
            </h2>
            <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Kod
                    <input
                        value={code}
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                        placeholder="HOK2026"
                        className="w-40 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm text-foreground"
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Popust (%)
                    <input
                        value={percent}
                        onChange={(e) => setPercent(e.target.value)}
                        inputMode="numeric"
                        className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-right text-sm text-foreground"
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Trajanje popusta
                    <select
                        value={duration}
                        onChange={(e) =>
                            setDuration(
                                e.target.value as
                                    | "forever"
                                    | "once"
                                    | "repeating",
                            )
                        }
                        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                    >
                        <option value="forever">Trajno</option>
                        <option value="once">Samo prva naplata</option>
                        <option value="repeating">Određeni broj mjeseci</option>
                    </select>
                </label>
                {duration === "repeating" && (
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                        Mjeseci
                        <input
                            value={months}
                            onChange={(e) => setMonths(e.target.value)}
                            inputMode="numeric"
                            className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-right text-sm text-foreground"
                        />
                    </label>
                )}
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Kod se može upisati do
                    <input
                        type="date"
                        value={expiresAt}
                        onChange={(e) => setExpiresAt(e.target.value)}
                        className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
                    />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    Maks. iskorištenja
                    <input
                        value={maxRedemptions}
                        onChange={(e) => setMaxRedemptions(e.target.value)}
                        inputMode="numeric"
                        placeholder="∞"
                        className="w-24 rounded-md border border-input bg-background px-2 py-1.5 text-right text-sm text-foreground"
                    />
                </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
                <span className="text-xs font-medium text-muted-foreground">
                    Paketi:
                </span>
                {PLAN_OPTIONS.map((opt) => (
                    <label
                        key={opt.key}
                        className="flex items-center gap-1.5 text-sm text-foreground"
                    >
                        <input
                            type="checkbox"
                            checked={selectedPlans.includes(opt.key)}
                            onChange={() => togglePlan(opt.key)}
                            className="h-4 w-4 rounded border-input"
                        />
                        {opt.label}
                    </label>
                ))}
                <span className="text-xs text-muted-foreground/70">
                    (ništa odabrano = svi proizvodi)
                </span>
            </div>
            <div>
                <button
                    onClick={submit}
                    disabled={saving}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                    {saving ? "Kreiram…" : "Kreiraj promo kod"}
                </button>
            </div>
        </div>
    );
}
