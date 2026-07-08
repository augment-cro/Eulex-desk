"use client";

/**
 * AdminMax → Analitika. Growth/usage/revenue time series from
 * GET /adminmax/analytics + current tier distribution, plus the manual
 * trigger for the weekly summary email (same content the cron sends).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import {
    AdminUnauthorizedError,
    getAdminToken,
    getAnalytics,
    sendWeeklySummary,
    type AnalyticsResponse,
} from "../lib/adminApi";

function fmtInt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function fmtUsd(n: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
    }).format(n);
}

function fmtEur(cents: number): string {
    return new Intl.NumberFormat("hr-HR", {
        style: "currency",
        currency: "EUR",
    }).format(cents / 100);
}

function defaultRange(): { from: string; to: string } {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    const toLocal = (d: Date) =>
        new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
            .toISOString()
            .slice(0, 16);
    return { from: toLocal(from), to: toLocal(to) };
}

// Recharts renders to SVG; CSS custom properties resolve there, so we feed
// it our design tokens as var() strings instead of hardcoded hex.
const AXIS_STYLE = { fontSize: 11, fill: "var(--color-muted-foreground)" } as const;
const TOOLTIP_STYLE = {
    backgroundColor: "var(--color-card)",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    fontSize: 12,
} as const;
// Chart series colors → brand tokens (green / cyan / amber / red).
const CHART_GRID = "var(--color-border)";
const CHART_GREEN = "var(--color-chart-1)";
const CHART_BLUE = "var(--color-chart-3)";
const CHART_AMBER = "var(--color-warning)";
const CHART_RED = "var(--color-destructive)";

export default function AdminMaxAnalyticsPage() {
    const router = useRouter();
    const [range, setRange] = useState(defaultRange);
    const [data, setData] = useState<AnalyticsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [summaryState, setSummaryState] = useState<
        "idle" | "sending" | "sent"
    >("idle");

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await getAnalytics({
                from: new Date(range.from).toISOString(),
                to: new Date(range.to).toISOString(),
            });
            setData(res);
        } catch (err) {
            if (err instanceof AdminUnauthorizedError) {
                router.replace("/adminmax/login");
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [range.from, range.to, router]);

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
    }, [load]);

    async function onSendSummary() {
        setSummaryState("sending");
        setError(null);
        try {
            const r = await sendWeeklySummary();
            setSummaryState("sent");
            console.log("[adminmax] weekly summary sent to", r.sent_to);
            setTimeout(() => setSummaryState("idle"), 4000);
        } catch (err) {
            setSummaryState("idle");
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const daily = data?.daily ?? [];
    const chartData = daily.map((d) => ({
        ...d,
        day: d.day.slice(5), // MM-DD for the axis
        revenue_eur: d.revenue_eur_cents / 100,
    }));
    const totalPaidUsers = (data?.tiers ?? [])
        .filter((t) => t.label && !/free/i.test(t.label))
        .reduce((s, t) => s + t.users, 0);
    const maxTierUsers = Math.max(
        1,
        ...(data?.tiers ?? []).map((t) => t.users),
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <Link
                        href="/adminmax"
                        className="text-xs text-muted-foreground hover:text-foreground"
                    >
                        ← Natrag na popis
                    </Link>
                    <h1 className="mt-1 font-serif text-2xl font-semibold tracking-tight">
                        AdminMax · Analitika
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Registracije, aktivnost, trošak i prihod kroz vrijeme.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                            Od
                        </span>
                        <input
                            type="datetime-local"
                            value={range.from}
                            onChange={(e) =>
                                setRange((r) => ({ ...r, from: e.target.value }))
                            }
                            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                        />
                    </label>
                    <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                            Do
                        </span>
                        <input
                            type="datetime-local"
                            value={range.to}
                            onChange={(e) =>
                                setRange((r) => ({ ...r, to: e.target.value }))
                            }
                            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                        />
                    </label>
                    <button
                        onClick={load}
                        disabled={loading}
                        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
                    >
                        {loading ? "Učitavam…" : "Osvježi"}
                    </button>
                    <button
                        onClick={onSendSummary}
                        disabled={summaryState === "sending"}
                        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
                        title="Šalje isti email koji tjedni cron šalje na info@eulex.ai"
                    >
                        {summaryState === "sending"
                            ? "Šaljem…"
                            : summaryState === "sent"
                              ? "✓ Poslano"
                              : "Pošalji tjedni sažetak"}
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {/* ── totals ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Card
                    label="Novi korisnici"
                    value={fmtInt(data?.totals.new_users ?? 0)}
                />
                <Card
                    label="Aktivni korisnici"
                    value={fmtInt(data?.totals.active_users ?? 0)}
                />
                <Card
                    label="Zahtjevi"
                    value={fmtInt(data?.totals.requests ?? 0)}
                />
                <Card
                    label="Trošak (LLM)"
                    value={fmtUsd(data?.totals.cost_usd ?? 0)}
                />
                <Card
                    label="Prihod"
                    value={fmtEur(data?.totals.revenue_eur_cents ?? 0)}
                />
            </div>

            {/* ── prihod / pretplate (run-rate iz billing_revenue) ── */}
            <RevenueSection rm={data?.revenue_metrics} />

            <div className="grid gap-4 lg:grid-cols-2">
                {/* ── signups ────────────────────────────────────── */}
                <ChartPanel title="Registracije po danu">
                    <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={chartData}>
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke={CHART_GRID}
                            />
                            <XAxis dataKey="day" tick={AXIS_STYLE} />
                            <YAxis tick={AXIS_STYLE} allowDecimals={false} />
                            <Tooltip contentStyle={TOOLTIP_STYLE} />
                            <Bar
                                dataKey="signups"
                                name="Registracije"
                                fill={CHART_GREEN}
                                radius={[3, 3, 0, 0]}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </ChartPanel>

                {/* ── activity ───────────────────────────────────── */}
                <ChartPanel title="Aktivnost po danu">
                    <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={chartData}>
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke={CHART_GRID}
                            />
                            <XAxis dataKey="day" tick={AXIS_STYLE} />
                            <YAxis tick={AXIS_STYLE} allowDecimals={false} />
                            <Tooltip contentStyle={TOOLTIP_STYLE} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Line
                                type="monotone"
                                dataKey="active_users"
                                name="Aktivni korisnici"
                                stroke={CHART_BLUE}
                                dot={false}
                                strokeWidth={2}
                            />
                            <Line
                                type="monotone"
                                dataKey="requests"
                                name="Zahtjevi"
                                stroke={CHART_AMBER}
                                dot={false}
                                strokeWidth={2}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </ChartPanel>

                {/* ── money ──────────────────────────────────────── */}
                <ChartPanel title="Trošak (USD) i prihod (EUR) po danu">
                    <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={chartData}>
                            <CartesianGrid
                                strokeDasharray="3 3"
                                stroke={CHART_GRID}
                            />
                            <XAxis dataKey="day" tick={AXIS_STYLE} />
                            <YAxis tick={AXIS_STYLE} />
                            <Tooltip contentStyle={TOOLTIP_STYLE} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Line
                                type="monotone"
                                dataKey="cost_usd"
                                name="Trošak (USD)"
                                stroke={CHART_RED}
                                dot={false}
                                strokeWidth={2}
                            />
                            <Line
                                type="monotone"
                                dataKey="revenue_eur"
                                name="Prihod (EUR)"
                                stroke={CHART_GREEN}
                                dot={false}
                                strokeWidth={2}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </ChartPanel>

                {/* ── tier distribution ──────────────────────────── */}
                <ChartPanel
                    title={`Korisnici po tieru (plaćenih: ${fmtInt(totalPaidUsers)})`}
                >
                    <div className="space-y-2 py-1">
                        {(data?.tiers ?? []).map((t) => (
                            <div key={t.tier_level_id}>
                                <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground">
                                        {t.label ?? `Tier ${t.tier_level_id}`}
                                    </span>
                                    <span className="font-mono text-muted-foreground">
                                        {fmtInt(t.users)}
                                    </span>
                                </div>
                                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                                    <div
                                        className={`h-full rounded-full ${
                                            t.label && /free/i.test(t.label)
                                                ? "bg-muted-foreground"
                                                : "bg-success"
                                        }`}
                                        style={{
                                            width: `${Math.max(2, (t.users / maxTierUsers) * 100)}%`,
                                        }}
                                    />
                                </div>
                            </div>
                        ))}
                        {(data?.tiers ?? []).length === 0 && (
                            <p className="py-4 text-center text-sm text-muted-foreground">
                                Nema podataka.
                            </p>
                        )}
                    </div>
                </ChartPanel>
            </div>
        </div>
    );
}

function Card({
    label,
    value,
    hint,
    title,
}: {
    label: string;
    value: string;
    hint?: string;
    /** Native hover tooltip explaining the metric. */
    title?: string;
}) {
    return (
        <div
            title={title}
            className={`rounded-lg border border-border bg-muted/40 px-4 py-3 ${
                title ? "cursor-help" : ""
            }`}
        >
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
            {hint && (
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {hint}
                </div>
            )}
        </div>
    );
}

/**
 * Subscription run-rate metrics from billing_revenue. Values are NOW-anchored
 * (not the date-range above): MRR = last 30d collected, ARR = trailing 365d,
 * NRR + bridge compare the last 30d vs the prior 30d per paying user.
 */
function RevenueSection({
    rm,
}: {
    rm: AnalyticsResponse["revenue_metrics"] | undefined;
}) {
    const eur = (cents: number) => fmtEur(cents);
    const b = rm?.bridge;
    return (
        <div className="space-y-3">
            <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold text-foreground">
                    Prihod (pretplate)
                </h2>
                <span className="text-xs text-muted-foreground">
                    run-rate, neovisno o rasponu
                </span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Card
                    label="MRR"
                    value={eur(rm?.mrr_cents ?? 0)}
                    hint="naplaćeno zadnjih 30 dana"
                    title="MRR — Monthly Recurring Revenue (mjesečni ponavljajući prihod). Zbroj pretplatničkih faktura naplaćenih kroz Stripe u zadnjih 30 dana."
                />
                <Card
                    label="ARR"
                    value={eur(rm?.arr_cents ?? 0)}
                    hint="zadnjih 365 dana"
                    title="ARR — Annual Recurring Revenue (godišnji ponavljajući prihod). Pretplatnički prihod u zadnjih 365 dana; ovako se godišnji paketi pravilno raspoređuju."
                />
                <Card
                    label="ARPU"
                    value={eur(rm?.arpu_cents ?? 0)}
                    hint={`${fmtInt(rm?.active_payers ?? 0)} plaćenih / 30 dana`}
                    title="ARPU — Average Revenue Per User (prosječni prihod po plaćenom korisniku). MRR podijeljen s brojem korisnika koji su platili u zadnjih 30 dana."
                />
                <Card
                    label="NRR"
                    value={rm?.nrr_pct == null ? "—" : `${rm.nrr_pct}%`}
                    hint="zadržavanje prihoda (30d vs prošlih 30d)"
                    title="NRR — Net Revenue Retention. Koliko je prihoda od korisnika koji su plaćali prošlih 30 dana zadržano u zadnjih 30 dana (uključuje proširenja, smanjenja i otkaze). >100% = rast i bez novih korisnika."
                />
            </div>
            {b && (
                <div
                    className="rounded-lg border border-border bg-muted/40 px-4 py-3"
                    title="MRR bridge — razlaže promjenu pretplatničkog prihoda u zadnjih 30 dana u odnosu na prethodnih 30 dana, po plaćenom korisniku."
                >
                    <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                        MRR kretanje (30d vs prethodnih 30d)
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-4">
                        <BridgeItem
                            label="Novi"
                            cents={b.new_cents}
                            sign="+"
                            tone="success"
                            title="Prihod od korisnika koji nisu plaćali u prethodnih 30 dana (novi plaćeni)."
                        />
                        <BridgeItem
                            label="Proširenje"
                            cents={b.expansion_cents}
                            sign="+"
                            tone="success"
                            title="Povećanje prihoda postojećih korisnika (nadogradnja na viši paket / više sjedala)."
                        />
                        <BridgeItem
                            label="Smanjenje"
                            cents={b.contraction_cents}
                            sign="−"
                            tone="destructive"
                            title="Pad prihoda postojećih korisnika koji i dalje plaćaju (downgrade)."
                        />
                        <BridgeItem
                            label="Otkazano"
                            cents={b.churned_cents}
                            sign="−"
                            tone="destructive"
                            title="Izgubljeni prihod od korisnika koji su prestali plaćati (churn)."
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

function BridgeItem({
    label,
    cents,
    sign,
    tone,
    title,
}: {
    label: string;
    cents: number;
    sign: "+" | "−";
    tone: "success" | "destructive";
    title?: string;
}) {
    return (
        <div
            title={title}
            className={`flex items-baseline justify-between gap-2 ${
                title ? "cursor-help" : ""
            }`}
        >
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className={tone === "success" ? "text-success" : "text-destructive"}>
                {cents > 0 ? sign : ""}
                {fmtEur(cents)}
            </span>
        </div>
    );
}

function ChartPanel({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-lg border border-border bg-muted/40 p-4">
            <h2 className="mb-3 text-sm font-semibold text-foreground">
                {title}
            </h2>
            {children}
        </div>
    );
}
