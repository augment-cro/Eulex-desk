"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    getAdminToken,
    getChatThread,
    getTierHistory,
    getUser,
    grantUserCredits,
    listMessages,
    listTiers,
    listUsage,
    listUserCredits,
    setUserTier,
    suspendUser,
    triggerCsvDownload,
    updateUserProfile,
    voidCreditGrant,
    type AdminChatThreadMessage,
    type AdminChatThreadResponse,
    type AdminCreditGrant,
    type AdminCreditsResponse,
    type AdminMessageRow,
    type AdminTierLimit,
    type AdminUsageRow,
    type AdminUserDetailResponse,
    type TierHistoryRow,
} from "../../lib/adminApi";

const PAGE_SIZE = 50;

function fmtUsd(n: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
    }).format(n);
}

function fmtInt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function fmtDate(s: string | null): string {
    if (!s) return "—";
    try {
        return new Date(s).toLocaleString("hr-HR", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    } catch {
        return s;
    }
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

function localToIso(local: string): string {
    return new Date(local).toISOString();
}

/**
 * Best-effort plain-text rendering of an assistant message stored as
 * an AssistantEvent[] array in chat_messages.content. We only extract
 * `text` / `content` fields from `content` and `reasoning` events so
 * the admin sees something readable without rendering markdown.
 */
function summarizeContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const parts: string[] = [];
    for (const ev of content as Record<string, unknown>[]) {
        if (typeof ev?.text === "string") parts.push(String(ev.text));
        else if (typeof ev?.content === "string")
            parts.push(String(ev.content));
        else if (ev?.type === "tool_call_start" && typeof ev.name === "string")
            parts.push(`⧗ ${ev.name}`);
        else if (ev?.type === "doc_created" && typeof ev.filename === "string")
            parts.push(`📄 ${ev.filename}`);
    }
    return parts.join("\n");
}

export default function AdminMaxUserDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id: userId } = use(params);
    const router = useRouter();
    const [range, setRange] = useState(defaultRange);
    const [tab, setTab] = useState<
        "usage" | "messages" | "credits" | "subscription"
    >("usage");
    const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);
    const [usagePage, setUsagePage] = useState(0);
    const [usage, setUsage] = useState<AdminUsageRow[]>([]);
    const [usageTotal, setUsageTotal] = useState(0);
    const [msgPage, setMsgPage] = useState(0);
    const [messages, setMessages] = useState<AdminMessageRow[]>([]);
    const [messagesTotal, setMessagesTotal] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    async function load() {
        setLoading(true);
        setError(null);
        const fromIso = localToIso(range.from);
        const toIso = localToIso(range.to);
        try {
            const [d, u, m] = await Promise.all([
                getUser(userId, { from: fromIso, to: toIso }),
                listUsage(userId, {
                    from: fromIso,
                    to: toIso,
                    limit: PAGE_SIZE,
                    offset: usagePage * PAGE_SIZE,
                }),
                listMessages(userId, {
                    from: fromIso,
                    to: toIso,
                    limit: PAGE_SIZE,
                    offset: msgPage * PAGE_SIZE,
                }),
            ]);
            setDetail(d);
            setUsage(u.rows);
            setUsageTotal(u.total);
            setMessages(m.rows);
            setMessagesTotal(m.total);
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
    }, [usagePage, msgPage]);

    async function exportUserCsv() {
        setExporting(true);
        try {
            const params = new URLSearchParams({
                from: localToIso(range.from),
                to: localToIso(range.to),
            });
            const fname = `adminmax_usage_${userId}_${range.from.slice(0, 10)}_${range.to.slice(0, 10)}.csv`;
            await triggerCsvDownload(
                `/users/${userId}/usage.csv?${params.toString()}`,
                fname,
            );
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setExporting(false);
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <Link
                        href="/adminmax"
                        className="text-xs text-muted-foreground hover:text-foreground"
                    >
                        ← Natrag na popis
                    </Link>
                    <h1 className="mt-1 font-serif text-2xl font-semibold tracking-tight">
                        {detail?.user.email ?? userId}
                    </h1>
                    {detail?.user.display_name && (
                        <p className="text-sm text-muted-foreground">
                            {detail.user.display_name}
                        </p>
                    )}
                    {detail && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span
                                className={`inline-block rounded-full px-2 py-0.5 font-medium ${
                                    detail.tier.active_tier_level_id != null
                                        ? "border border-success/40 bg-success/15 text-success"
                                        : "border border-border text-muted-foreground"
                                }`}
                            >
                                {detail.tier.tier_label ?? "Free"}
                            </span>
                            {detail.tier.active_tier_until && (
                                <span>
                                    do {fmtDate(detail.tier.active_tier_until)}
                                </span>
                            )}
                            <span>
                                · Registriran:{" "}
                                {fmtDate(detail.user.created_at)}
                            </span>
                            <span>
                                · Zadnja prijava:{" "}
                                {fmtDate(detail.login.last_login_at)}
                            </span>
                            {detail.supabase.auth?.banned_until &&
                                new Date(
                                    detail.supabase.auth.banned_until,
                                ) > new Date() && (
                                    <span className="rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                                        Suspendiran
                                    </span>
                                )}
                        </div>
                    )}
                </div>
                <div className="flex items-end gap-3">
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
                            className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
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
                            className="rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                        />
                    </label>
                    <button
                        onClick={() => {
                            setUsagePage(0);
                            setMsgPage(0);
                            load();
                        }}
                        disabled={loading}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                        {loading ? "Učitavam…" : "Osvježi"}
                    </button>
                    <button
                        onClick={exportUserCsv}
                        disabled={exporting}
                        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                        {exporting ? "Export…" : "CSV (korisnik)"}
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {detail && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <SummaryCard
                        label="Trošak"
                        value={fmtUsd(detail.totals.cost_usd_total)}
                    />
                    <SummaryCard
                        label="Zahtjevi"
                        value={fmtInt(detail.totals.request_count)}
                        subValue={`Greške: ${detail.totals.error_count}`}
                    />
                    <SummaryCard
                        label="Input"
                        value={fmtInt(detail.totals.input_tokens_total)}
                    />
                    <SummaryCard
                        label="Output"
                        value={fmtInt(detail.totals.output_tokens_total)}
                    />
                    <SummaryCard
                        label="Cache R / W"
                        value={fmtInt(detail.totals.cache_read_input_tokens_total)}
                        subValue={`W: ${fmtInt(detail.totals.cache_creation_input_tokens_total)}`}
                    />
                </div>
            )}

            <div className="flex gap-2 border-b border-border">
                <TabButton
                    active={tab === "usage"}
                    onClick={() => setTab("usage")}
                >
                    Zapisi potrošnje ({fmtInt(usageTotal)})
                </TabButton>
                <TabButton
                    active={tab === "messages"}
                    onClick={() => setTab("messages")}
                >
                    Poruke ({fmtInt(messagesTotal)})
                </TabButton>
                <TabButton
                    active={tab === "credits"}
                    onClick={() => setTab("credits")}
                >
                    Krediti
                </TabButton>
                <TabButton
                    active={tab === "subscription"}
                    onClick={() => setTab("subscription")}
                >
                    Pretplata
                </TabButton>
            </div>

            {tab === "usage" ? (
                <UsageTable
                    rows={usage}
                    page={usagePage}
                    total={usageTotal}
                    onPage={setUsagePage}
                />
            ) : tab === "messages" ? (
                <MessagesList
                    rows={messages}
                    page={msgPage}
                    total={messagesTotal}
                    onPage={setMsgPage}
                    userId={userId}
                />
            ) : tab === "credits" ? (
                <CreditsPanel userId={userId} />
            ) : (
                <SubscriptionPanel
                    userId={userId}
                    detail={detail}
                    onChanged={load}
                />
            )}
        </div>
    );
}

// ── Subscription panel ───────────────────────────────────────────────────
//
// The UMP "memberships" replacement: current tier + manual assignment
// (PATCH /users/:id/tier), Supabase auth facts, suspend/unban, and the
// append-only tier history (Stripe / UMP sync / admin).
function SubscriptionPanel({
    userId,
    detail,
    onChanged,
}: {
    userId: string;
    detail: AdminUserDetailResponse | null;
    onChanged: () => void | Promise<void>;
}) {
    const [tiers, setTiers] = useState<AdminTierLimit[]>([]);
    const [history, setHistory] = useState<TierHistoryRow[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [suspending, setSuspending] = useState(false);

    const [levelInput, setLevelInput] = useState<string>("");
    const [untilInput, setUntilInput] = useState<string>("");
    const [reasonInput, setReasonInput] = useState<string>("");

    // Operator-editable profile fields (naziv + država).
    const [nameInput, setNameInput] = useState<string>("");
    const [countryInput, setCountryInput] = useState<string>("");
    const [savingProfile, setSavingProfile] = useState(false);

    useEffect(() => {
        listTiers()
            .then((r) => setTiers(r.tiers))
            .catch((err) =>
                setError(err instanceof Error ? err.message : String(err)),
            );
        getTierHistory(userId)
            .then((r) => setHistory(r.history))
            .catch(() => {
                // History table simply stays empty.
            });
    }, [userId]);

    // Seed the form from the current state once the detail arrives.
    useEffect(() => {
        if (!detail) return;
        setLevelInput(
            detail.tier.active_tier_level_id != null
                ? String(detail.tier.active_tier_level_id)
                : "",
        );
        setUntilInput(
            detail.tier.active_tier_until
                ? new Date(
                      new Date(detail.tier.active_tier_until).getTime() -
                          new Date().getTimezoneOffset() * 60_000,
                  )
                      .toISOString()
                      .slice(0, 16)
                : "",
        );
        setNameInput(detail.user.display_name ?? "");
        setCountryInput(detail.user.country ?? "");
    }, [detail]);

    async function onSaveProfile() {
        setSavingProfile(true);
        setError(null);
        try {
            await updateUserProfile(userId, {
                display_name: nameInput.trim() || null,
                country: countryInput.trim() || null,
            });
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSavingProfile(false);
        }
    }

    // Quick subscription-duration helpers: set "Vrijedi do" to now + N
    // months (or clear it for no-expiry), so the operator doesn't have to
    // hand-pick a date.
    function setUntilMonthsFromNow(months: number) {
        const d = new Date();
        d.setMonth(d.getMonth() + months);
        setUntilInput(
            new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
                .toISOString()
                .slice(0, 16),
        );
    }

    async function onSave() {
        setSaving(true);
        setError(null);
        try {
            await setUserTier(userId, {
                tier_level_id: levelInput ? Number(levelInput) : null,
                until: untilInput ? new Date(untilInput).toISOString() : null,
                reason: reasonInput || undefined,
            });
            setReasonInput("");
            await onChanged();
            const h = await getTierHistory(userId);
            setHistory(h.history);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    const banned =
        detail?.supabase.auth?.banned_until != null &&
        new Date(detail.supabase.auth.banned_until) > new Date();

    async function onSuspendToggle() {
        if (!detail) return;
        const action = banned ? "unban" : "ban";
        const confirmMsg = banned
            ? "Reaktivirati ovog korisnika (ukloniti suspenziju)?"
            : "Suspendirati ovog korisnika? Neće se moći prijaviti dok se suspenzija ne ukloni.";
        if (!window.confirm(confirmMsg)) return;
        setSuspending(true);
        setError(null);
        try {
            await suspendUser(userId, action);
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSuspending(false);
        }
    }

    const sb = detail?.supabase;

    return (
        <div className="space-y-5">
            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {/* ── profil: naziv + država ─────────────────────────── */}
            <div className="rounded-lg border border-border bg-muted/40 p-4">
                <h2 className="text-sm font-semibold text-foreground">
                    Profil korisnika
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                    Naziv (ime / tvrtka) i država korisnika. Vidljivo samo u
                    adminu i za pretplatu (Stripe adresa).
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                            Naziv
                        </span>
                        <input
                            type="text"
                            value={nameInput}
                            onChange={(e) => setNameInput(e.target.value)}
                            placeholder="Ime i prezime ili naziv tvrtke"
                            className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                        />
                    </label>
                    <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                            Država
                        </span>
                        <input
                            type="text"
                            value={countryInput}
                            onChange={(e) => setCountryInput(e.target.value)}
                            placeholder="npr. Hrvatska / HR"
                            className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                        />
                    </label>
                </div>
                <button
                    onClick={onSaveProfile}
                    disabled={savingProfile}
                    className="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
                >
                    {savingProfile ? "Spremam…" : "Spremi profil"}
                </button>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                {/* ── manual tier assignment ─────────────────────── */}
                <div className="rounded-lg border border-border bg-muted/40 p-4">
                    <h2 className="text-sm font-semibold text-foreground">
                        Pretplata (ručno upravljanje)
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Promjena vrijedi odmah — auth middleware čita
                        user_tier_state na svakom zahtjevu. Stripe webhook
                        može kasnije pregaziti ručnu promjenu ako korisnik
                        ima aktivnu Stripe pretplatu.
                    </p>
                    <div className="mt-3 space-y-3">
                        <label className="block text-xs">
                            <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                                Tier
                            </span>
                            <select
                                value={levelInput}
                                onChange={(e) => setLevelInput(e.target.value)}
                                className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                            >
                                <option value="">Free (bez overridea)</option>
                                {tiers.map((t) => (
                                    <option
                                        key={t.tier_level_id}
                                        value={t.tier_level_id}
                                    >
                                        {t.display_label} (id {t.tier_level_id})
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="block text-xs">
                            <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                                Vrijedi do (prazno = bez isteka)
                            </span>
                            <input
                                type="datetime-local"
                                value={untilInput}
                                onChange={(e) => setUntilInput(e.target.value)}
                                className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                            />
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {[
                                    { label: "+1 mj", months: 1 },
                                    { label: "+3 mj", months: 3 },
                                    { label: "+6 mj", months: 6 },
                                    { label: "+1 god", months: 12 },
                                ].map((opt) => (
                                    <button
                                        key={opt.months}
                                        type="button"
                                        onClick={() =>
                                            setUntilMonthsFromNow(opt.months)
                                        }
                                        className="rounded-md border border-action/40 px-2 py-0.5 text-xs font-medium text-action hover:bg-action/10"
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => setUntilInput("")}
                                    className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-accent"
                                >
                                    Bez isteka
                                </button>
                            </div>
                        </label>
                        <label className="block text-xs">
                            <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                                Razlog (audit)
                            </span>
                            <input
                                type="text"
                                value={reasonInput}
                                onChange={(e) =>
                                    setReasonInput(e.target.value)
                                }
                                placeholder="npr. uplata na račun, kompenzacija…"
                                className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                            />
                        </label>
                        <button
                            onClick={onSave}
                            disabled={saving}
                            className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:opacity-50"
                        >
                            {saving ? "Spremam…" : "Spremi tier"}
                        </button>
                    </div>
                </div>

                {/* ── auth / Supabase info ───────────────────────── */}
                <div className="rounded-lg border border-border bg-muted/40 p-4">
                    <h2 className="text-sm font-semibold text-foreground">
                        Prijava i račun
                    </h2>
                    <dl className="mt-3 space-y-2 text-sm">
                        <InfoRow
                            label="Zadnja prijava"
                            value={fmtDate(detail?.login.last_login_at ?? null)}
                        />
                        <InfoRow
                            label="Aktivnih sesija (sati)"
                            value={fmtInt(detail?.login.login_count ?? 0)}
                        />
                        <InfoRow
                            label="Stripe customer"
                            value={detail?.tier.stripe_customer_id ?? "—"}
                            mono
                        />
                        {sb?.configured === false ? (
                            <InfoRow
                                label="Supabase"
                                value="Nije konfiguriran (SUPABASE_SECRET_KEY)"
                            />
                        ) : !sb?.supabase_user_id ? (
                            <InfoRow
                                label="Supabase"
                                value="Nema Supabase računa (legacy WP login)"
                            />
                        ) : (
                            <>
                                <InfoRow
                                    label="Provider prijave"
                                    value={
                                        sb.auth
                                            ? (sb.auth.providers.length > 0
                                                  ? sb.auth.providers.join(", ")
                                                  : (sb.auth.provider ?? "—"))
                                            : (sb.error ?? "—")
                                    }
                                />
                                <InfoRow
                                    label="Email potvrđen"
                                    value={
                                        sb.auth?.email_confirmed_at
                                            ? `Da (${fmtDate(sb.auth.email_confirmed_at)})`
                                            : "Ne"
                                    }
                                />
                                <InfoRow
                                    label="Zadnja Supabase prijava"
                                    value={fmtDate(
                                        sb.auth?.last_sign_in_at ?? null,
                                    )}
                                />
                                <InfoRow
                                    label="Status"
                                    value={
                                        banned
                                            ? `Suspendiran do ${fmtDate(sb.auth?.banned_until ?? null)}`
                                            : "Aktivan"
                                    }
                                />
                            </>
                        )}
                    </dl>
                    {sb?.supabase_user_id && sb.configured && (
                        <button
                            onClick={onSuspendToggle}
                            disabled={suspending}
                            className={`mt-4 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                                banned
                                    ? "bg-success text-success-foreground hover:bg-success/90"
                                    : "border border-destructive/40 text-destructive hover:bg-destructive/10"
                            }`}
                        >
                            {suspending
                                ? "Spremam…"
                                : banned
                                  ? "Ukloni suspenziju"
                                  : "Suspendiraj korisnika"}
                        </button>
                    )}
                </div>
            </div>

            {/* ── tier history ───────────────────────────────────── */}
            <div className="overflow-hidden rounded-lg border border-border">
                <div className="border-b border-border bg-muted px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Povijest pretplate
                </div>
                <table className="w-full text-sm">
                    <tbody>
                        {history.length === 0 && (
                            <tr>
                                <td className="px-4 py-4 text-center text-muted-foreground">
                                    Nema zabilježenih promjena.
                                </td>
                            </tr>
                        )}
                        {history.map((h) => (
                            <tr
                                key={h.id}
                                className="border-t border-border"
                            >
                                <td className="px-4 py-2 text-xs text-muted-foreground">
                                    {fmtDate(h.created_at)}
                                </td>
                                <td className="px-4 py-2">
                                    <span className="text-muted-foreground">
                                        {h.old_label ??
                                            (h.old_tier_level_id != null
                                                ? `id ${h.old_tier_level_id}`
                                                : "Free")}
                                    </span>
                                    <span className="px-2 text-muted-foreground">
                                        →
                                    </span>
                                    <span className="text-foreground">
                                        {h.new_label ??
                                            (h.new_tier_level_id != null
                                                ? `id ${h.new_tier_level_id}`
                                                : "Free")}
                                    </span>
                                    {h.new_until && (
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            do {fmtDate(h.new_until)}
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-2">
                                    <span
                                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                            h.source === "admin"
                                                ? "border border-warning/40 text-warning"
                                                : h.source === "stripe"
                                                  ? "border border-action/40 text-action"
                                                  : "border border-border text-muted-foreground"
                                        }`}
                                    >
                                        {h.source}
                                    </span>
                                </td>
                                <td className="px-4 py-2 text-xs text-muted-foreground">
                                    {h.reason ?? ""}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function InfoRow({
    label,
    value,
    mono,
}: {
    label: string;
    value: string;
    mono?: boolean;
}) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </dt>
            <dd
                className={`truncate text-right text-foreground ${mono ? "font-mono text-xs" : ""}`}
            >
                {value}
            </dd>
        </div>
    );
}

// ── Credits panel ────────────────────────────────────────────────────────
//
// AdminMax UI for the bank_transfer + admin_manual paths. Stripe grants
// land here too (read-only — admin can void them but not edit). New
// grants can only be `bank_transfer` or `admin_manual`; the Stripe
// path is webhook-driven.
function CreditsPanel({ userId }: { userId: string }) {
    const [data, setData] = useState<AdminCreditsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);

    async function load() {
        setLoading(true);
        setError(null);
        try {
            const res = await listUserCredits(userId);
            setData(res);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]);

    async function onVoid(creditId: string) {
        const reason = window.prompt("Razlog stornacije (opcionalno):") ?? undefined;
        if (!window.confirm("Stornirati ovaj credit pack?")) return;
        try {
            await voidCreditGrant(creditId, reason);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="space-y-4">
            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            <div className="flex items-center justify-between gap-3">
                <div className="rounded-lg border border-border bg-card px-4 py-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Aktivni bonus tokeni
                    </div>
                    <div className="mt-1 font-mono text-lg text-success">
                        {fmtInt(data?.balance.bonus_remaining ?? 0)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                        {data?.balance.pack_count ?? 0} aktivnih paketa
                    </div>
                </div>
                <button
                    onClick={() => setShowForm((v) => !v)}
                    className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-success-foreground hover:bg-success/90"
                >
                    {showForm ? "Zatvori" : "+ Dodaj credit pack"}
                </button>
            </div>

            {showForm && (
                <GrantCreditForm
                    userId={userId}
                    onCreated={async () => {
                        setShowForm(false);
                        await load();
                    }}
                />
            )}

            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Datum
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Metoda
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Tokeni
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide">
                                Iskorišteno
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Referenca
                            </th>
                            <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide">
                                Bilješke
                            </th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {!loading && data?.grants.length === 0 && (
                            <tr>
                                <td
                                    colSpan={7}
                                    className="px-4 py-6 text-center text-muted-foreground"
                                >
                                    Nema dodijeljenih credit packova.
                                </td>
                            </tr>
                        )}
                        {data?.grants.map((g) => (
                            <CreditRow
                                key={g.id}
                                grant={g}
                                onVoid={() => onVoid(g.id)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function CreditRow({
    grant,
    onVoid,
}: {
    grant: AdminCreditGrant;
    onVoid: () => void;
}) {
    const granted = Number(grant.tokens_granted);
    const consumed = Number(grant.tokens_consumed);
    const voided = !!grant.voided_at;
    const expired = grant.expires_at && new Date(grant.expires_at) < new Date();
    const dimmed = voided || expired;
    return (
        <tr
            className={`border-t border-border ${
                dimmed ? "opacity-50" : "hover:bg-accent"
            }`}
        >
            <td className="px-4 py-2 text-xs text-muted-foreground">
                {fmtDate(grant.granted_at)}
            </td>
            <td className="px-4 py-2 text-xs">
                <span
                    className={
                        grant.payment_method === "stripe"
                            ? "rounded bg-accent px-1.5 py-0.5 text-accent-foreground"
                            : grant.payment_method === "bank_transfer"
                              ? "rounded bg-success/10 px-1.5 py-0.5 text-success"
                              : "rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                    }
                >
                    {grant.payment_method}
                </span>
            </td>
            <td className="px-4 py-2 text-right font-mono text-sm text-foreground">
                {fmtInt(granted)}
            </td>
            <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">
                {fmtInt(consumed)}
            </td>
            <td className="px-4 py-2 text-xs text-muted-foreground">
                {grant.external_reference ?? grant.stripe_event_id ?? "—"}
            </td>
            <td className="px-4 py-2 text-xs text-muted-foreground">
                {grant.notes ?? (voided ? grant.voided_reason : "—")}
            </td>
            <td className="px-4 py-2 text-right">
                {!voided && (
                    <button
                        onClick={onVoid}
                        className="text-xs text-destructive hover:text-destructive/80"
                    >
                        Storniraj
                    </button>
                )}
                {voided && (
                    <span className="text-xs text-muted-foreground">stornirano</span>
                )}
            </td>
        </tr>
    );
}

function GrantCreditForm({
    userId,
    onCreated,
}: {
    userId: string;
    onCreated: () => Promise<void>;
}) {
    const [tokens, setTokens] = useState("1000000");
    const [method, setMethod] = useState<"bank_transfer" | "admin_manual">(
        "bank_transfer",
    );
    const [reference, setReference] = useState("");
    const [amountEur, setAmountEur] = useState("");
    const [notes, setNotes] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <form
            className="rounded-lg border border-border bg-card p-4"
            onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError(null);
                try {
                    await grantUserCredits(userId, {
                        tokens_granted: Number(tokens) || 0,
                        payment_method: method,
                        external_reference: reference.trim() || undefined,
                        amount_eur_cents:
                            amountEur.trim().length > 0
                                ? Math.round(Number(amountEur) * 100)
                                : undefined,
                        notes: notes.trim() || undefined,
                    });
                    setTokens("1000000");
                    setReference("");
                    setAmountEur("");
                    setNotes("");
                    await onCreated();
                } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusy(false);
                }
            }}
        >
            {error && (
                <div className="mb-3 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                        Tokeni
                    </span>
                    <input
                        type="number"
                        value={tokens}
                        min={1}
                        step={100000}
                        onChange={(e) => setTokens(e.target.value)}
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 font-mono text-sm text-foreground"
                        required
                    />
                </label>
                <label className="text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                        Metoda
                    </span>
                    <select
                        value={method}
                        onChange={(e) =>
                            setMethod(
                                e.target.value as
                                    | "bank_transfer"
                                    | "admin_manual",
                            )
                        }
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                    >
                        <option value="bank_transfer">Bankovna uplata</option>
                        <option value="admin_manual">Admin (kompenzacija)</option>
                    </select>
                </label>
                <label className="text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                        Iznos (EUR)
                    </span>
                    <input
                        type="number"
                        step="0.01"
                        min={0}
                        value={amountEur}
                        onChange={(e) => setAmountEur(e.target.value)}
                        placeholder="opcionalno"
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 font-mono text-sm text-foreground"
                    />
                </label>
                <label className="col-span-1 sm:col-span-2 text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                        Referenca (broj izvoda / fakture)
                    </span>
                    <input
                        type="text"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                    />
                </label>
                <label className="text-xs">
                    <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                        Bilješke
                    </span>
                    <input
                        type="text"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className="w-full rounded-md border border-input bg-surface-elevated px-2 py-1.5 text-sm text-foreground"
                    />
                </label>
            </div>
            <div className="mt-3 flex justify-end">
                <button
                    type="submit"
                    disabled={busy || !(Number(tokens) > 0)}
                    className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {busy ? "Spremam…" : "Dodaj credit pack"}
                </button>
            </div>
        </form>
    );
}

function SummaryCard({
    label,
    value,
    subValue,
}: {
    label: string;
    value: string;
    subValue?: string;
}) {
    return (
        <div className="rounded-lg border border-border bg-card px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
            {subValue && (
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {subValue}
                </div>
            )}
        </div>
    );
}

function TabButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
        >
            {children}
        </button>
    );
}

function UsageTable({
    rows,
    page,
    total,
    onPage,
}: {
    rows: AdminUsageRow[];
    page: number;
    total: number;
    onPage: (p: number) => void;
}) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return (
        <div className="space-y-3">
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <Th>Vrijeme</Th>
                            <Th>Model</Th>
                            <Th align="right">Iter</Th>
                            <Th align="right">Input</Th>
                            <Th align="right">Output</Th>
                            <Th align="right">Cache R / W</Th>
                            <Th align="right">USD</Th>
                            <Th align="right">Trajanje</Th>
                            <Th>Status</Th>
                            <Th>Chat</Th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && (
                            <tr>
                                <td
                                    colSpan={10}
                                    className="px-4 py-6 text-center text-muted-foreground"
                                >
                                    Nema zapisa u rasponu.
                                </td>
                            </tr>
                        )}
                        {rows.map((r) => (
                            <tr
                                key={r.id}
                                className={`border-t border-border ${
                                    r.status === "error"
                                        ? "bg-destructive/10"
                                        : "hover:bg-accent"
                                }`}
                            >
                                <Td className="text-xs text-foreground">
                                    {fmtDate(r.created_at)}
                                </Td>
                                <Td className="font-mono text-xs">{r.model}</Td>
                                <Td align="right" className="font-mono text-xs">
                                    {r.iterations}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {fmtInt(r.input_tokens)}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {fmtInt(r.output_tokens)}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {fmtInt(r.cache_read_input_tokens)} /{" "}
                                    {fmtInt(r.cache_creation_input_tokens)}
                                </Td>
                                <Td align="right" className="font-mono">
                                    {fmtUsd(Number(r.cost_usd))}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {r.duration_ms != null
                                        ? `${(r.duration_ms / 1000).toFixed(1)}s`
                                        : "—"}
                                </Td>
                                <Td>
                                    {r.status === "ok" ? (
                                        <span className="text-xs text-success">
                                            ok
                                        </span>
                                    ) : (
                                        <span
                                            className="text-xs text-destructive"
                                            title={r.error_message ?? ""}
                                        >
                                            {r.status}
                                        </span>
                                    )}
                                </Td>
                                <Td className="font-mono text-xs text-muted-foreground">
                                    {r.chat_id?.slice(0, 8) ?? "—"}
                                </Td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pagination page={page} totalPages={totalPages} onPage={onPage} />
        </div>
    );
}

function MessagesList({
    rows,
    page,
    total,
    onPage,
    userId,
}: {
    rows: AdminMessageRow[];
    page: number;
    total: number;
    onPage: (p: number) => void;
    userId: string;
}) {
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const [openChatId, setOpenChatId] = useState<string | null>(null);
    return (
        <div className="space-y-3">
            <ul className="space-y-3">
                {rows.length === 0 && (
                    <li className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                        Nema poruka u rasponu.
                    </li>
                )}
                {rows.map((m) => (
                    <MessageRow
                        key={m.id}
                        message={m}
                        onOpenThread={() => setOpenChatId(m.chat_id)}
                    />
                ))}
            </ul>
            <Pagination page={page} totalPages={totalPages} onPage={onPage} />
            {openChatId && (
                <ChatThreadModal
                    chatId={openChatId}
                    userId={userId}
                    onClose={() => setOpenChatId(null)}
                />
            )}
        </div>
    );
}

/**
 * Single message row. Long content collapses to ~1500 chars to keep the
 * list scannable; "Prikaži cijelu poruku" expands inline. The "Otvori
 * razgovor" button opens a modal showing the WHOLE chat thread (every
 * Q+A pair) for full forensic context.
 */
const PREVIEW_LIMIT = 1500;
function MessageRow({
    message,
    onOpenThread,
}: {
    message: AdminMessageRow;
    onOpenThread: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const text = summarizeContent(message.content);
    const isLong = text.length > PREVIEW_LIMIT;
    const display = expanded || !isLong ? text : text.slice(0, PREVIEW_LIMIT) + "…";
    return (
        <li className="rounded-md border border-border bg-card px-4 py-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            message.role === "assistant"
                                ? "bg-success/10 text-success"
                                : "bg-surface-elevated text-foreground"
                        }`}
                    >
                        {message.role}
                    </span>
                    <span>{fmtDate(message.created_at)}</span>
                    {message.is_flagged && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                            flagged
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onOpenThread}
                    className="font-mono text-xs text-foreground hover:text-success"
                    title="Otvori cijeli razgovor"
                >
                    {message.chat_title ?? message.chat_id.slice(0, 8)} ↗
                </button>
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {display || (
                    <span className="text-muted-foreground">(prazna poruka)</span>
                )}
            </pre>
            <div className="mt-2 flex items-center gap-3">
                {isLong && (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="text-xs font-medium text-success hover:text-success/80"
                    >
                        {expanded
                            ? "Skupi"
                            : `Prikaži cijelu poruku (${text.length.toLocaleString("hr-HR")} znakova)`}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onOpenThread}
                    className="text-xs font-medium text-foreground underline underline-offset-3"
                >
                    Otvori cijeli razgovor (Q + A) →
                </button>
            </div>
        </li>
    );
}

/**
 * Modal that loads /adminmax/chats/:chatId/full and renders every
 * message in chronological order. Long messages can be expanded
 * individually, but the default view truncates to ~3000 chars per
 * bubble so the thread is scrollable.
 */
function ChatThreadModal({
    chatId,
    userId,
    onClose,
}: {
    chatId: string;
    userId: string;
    onClose: () => void;
}) {
    const [data, setData] = useState<AdminChatThreadResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await getChatThread(chatId, userId);
                if (!cancelled) setData(res);
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
    }, [chatId, userId]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/70 px-4 py-6"
            role="dialog"
            aria-modal="true"
            onClick={onClose}
        >
            <div
                className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 border-b border-border bg-muted px-5 py-3">
                    <div className="min-w-0">
                        <div className="font-serif text-base font-semibold text-foreground">
                            {data?.chat.title ?? "Razgovor"}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                            {chatId}
                            {data?.chat.project_id && (
                                <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
                                    project
                                </span>
                            )}
                        </div>
                        {data?.user && (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                                {data.user.email}
                                {data.user.display_name && (
                                    <span className="ml-2 text-muted-foreground">
                                        ({data.user.display_name})
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {error && (
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {error}
                        </div>
                    )}
                    {loading && (
                        <div className="text-sm text-muted-foreground">
                            Učitavam razgovor…
                        </div>
                    )}
                    {data && data.messages.length === 0 && (
                        <div className="text-sm text-muted-foreground">
                            Razgovor nema poruka.
                        </div>
                    )}
                    <ul className="space-y-3">
                        {data?.messages.map((m) => (
                            <ThreadMessage key={m.id} message={m} />
                        ))}
                    </ul>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-5 py-2">
                    <span className="text-[11px] text-muted-foreground">
                        {data ? `${data.messages.length} poruka` : ""}
                    </span>
                    {data && (
                        <span className="font-mono text-xs text-foreground">
                            <span className="text-muted-foreground">Ukupno: </span>
                            <span className="text-success">
                                {fmtUsd(data.totals.cost_usd_total)}
                            </span>
                            <span className="ml-2 text-muted-foreground">
                                {fmtInt(data.totals.input_tokens_total)} in /{" "}
                                {fmtInt(data.totals.output_tokens_total)} out
                            </span>
                            {data.totals.error_count > 0 && (
                                <span className="ml-2 text-destructive">
                                    · {data.totals.error_count} grešaka
                                </span>
                            )}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function ThreadMessage({ message }: { message: AdminChatThreadMessage }) {
    const [expanded, setExpanded] = useState(false);
    const text = summarizeContent(message.content);
    const isLong = text.length > 3000;
    const display = expanded || !isLong ? text : text.slice(0, 3000) + "…";
    const isAssistant = message.role === "assistant";
    return (
        <li
            className={`rounded-md border px-4 py-3 ${
                isAssistant
                    ? "border-success/20 bg-success/10"
                    : "border-border bg-muted"
            }`}
        >
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            isAssistant
                                ? "bg-success/20 text-success"
                                : "bg-surface-elevated text-foreground"
                        }`}
                    >
                        {isAssistant ? "Asistent (A)" : "Korisnik (Q)"}
                    </span>
                    <span>{fmtDate(message.created_at)}</span>
                    {message.is_flagged && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                            flagged
                        </span>
                    )}
                </div>
                {message.usage && (
                    <div className="flex items-center gap-2 font-mono text-[11px] whitespace-nowrap">
                        <span
                            className={
                                message.usage.had_error
                                    ? "text-destructive"
                                    : "text-success"
                            }
                            title="Trošak ovog odgovora"
                        >
                            {fmtUsd(message.usage.cost_usd)}
                        </span>
                        <span
                            className="text-muted-foreground"
                            title="Input / Output tokeni"
                        >
                            {fmtInt(message.usage.input_tokens)} in /{" "}
                            {fmtInt(message.usage.output_tokens)} out
                        </span>
                        {message.usage.model && (
                            <span className="hidden text-muted-foreground/70 sm:inline">
                                {message.usage.model}
                            </span>
                        )}
                    </div>
                )}
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {display || (
                    <span className="text-muted-foreground">(prazna poruka)</span>
                )}
            </pre>
            {isLong && (
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-2 text-xs font-medium text-success hover:text-success/80"
                >
                    {expanded
                        ? "Skupi"
                        : `Prikaži cijelu poruku (${text.length.toLocaleString("hr-HR")} znakova)`}
                </button>
            )}
        </li>
    );
}

function Pagination({
    page,
    totalPages,
    onPage,
}: {
    page: number;
    totalPages: number;
    onPage: (p: number) => void;
}) {
    if (totalPages <= 1) return null;
    return (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <button
                onClick={() => onPage(Math.max(0, page - 1))}
                disabled={page === 0}
                className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-40"
            >
                ←
            </button>
            <span>
                {page + 1} / {totalPages}
            </span>
            <button
                onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
                disabled={page >= totalPages - 1}
                className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-40"
            >
                →
            </button>
        </div>
    );
}

function Th({
    children,
    align,
}: {
    children: React.ReactNode;
    align?: "right";
}) {
    return (
        <th
            className={`px-3 py-2 text-xs font-medium uppercase tracking-wide ${
                align === "right" ? "text-right" : "text-left"
            }`}
        >
            {children}
        </th>
    );
}

function Td({
    children,
    align,
    className,
}: {
    children: React.ReactNode;
    align?: "right";
    className?: string;
}) {
    return (
        <td
            className={`px-3 py-2 ${align === "right" ? "text-right" : ""} ${
                className ?? ""
            }`}
        >
            {children}
        </td>
    );
}
