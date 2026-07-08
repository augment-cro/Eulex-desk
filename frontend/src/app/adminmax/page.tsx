"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
    AdminUnauthorizedError,
    clearAdminToken,
    getAdminToken,
    listTiers,
    listUsers,
    triggerCsvDownload,
    type AdminTierLimit,
    type AdminUserSummary,
    type AdminUsersResponse,
    type AdminUsersSortDir,
    type AdminUsersSortKey,
} from "./lib/adminApi";

// ── formatters ────────────────────────────────────────────────────────────

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

// Compact token counts (19,0M / 482k) so all columns fit one screen —
// full precision lives in the title tooltip + user detail page.
function fmtCompact(n: number): string {
    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toLocaleString("hr-HR", { maximumFractionDigits: 1 })}M`;
    }
    if (n >= 1_000) {
        return `${(n / 1_000).toLocaleString("hr-HR", { maximumFractionDigits: 0 })}k`;
    }
    return String(n);
}

/** Date-only (07.05.26.) — hover shows the full timestamp via title. */
function fmtShortDate(s: string | null): string {
    if (!s) return "—";
    try {
        return new Date(s).toLocaleDateString("hr-HR", {
            year: "2-digit",
            month: "2-digit",
            day: "2-digit",
        });
    } catch {
        return s;
    }
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

// ── URL state helpers ─────────────────────────────────────────────────────

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

type SortKey = AdminUsersSortKey;

interface QueryState {
    from: string; // local datetime-local
    to: string;
    q: string;
    sort: SortKey;
    dir: AdminUsersSortDir;
    onlyActive: boolean;
    /** EFFECTIVE tier_level_id filter; null = all tiers. */
    tier: number | null;
    /** ISO timestamp — only users registered after (new-users deep link). */
    createdAfter: string;
    pageSize: number;
    page: number; // 1-based
}

function parseQueryState(
    params: URLSearchParams,
    fallback: { from: string; to: string },
): QueryState {
    const sortRaw = params.get("sort");
    const validSorts: SortKey[] = [
        "cost",
        "requests",
        "errors",
        "last_used",
        "email",
        "created",
        "last_login",
        "tier",
    ];
    const sort: SortKey =
        sortRaw && (validSorts as string[]).includes(sortRaw)
            ? (sortRaw as SortKey)
            : "created";

    const dirRaw = params.get("dir");
    const dir: AdminUsersSortDir = dirRaw === "asc" ? "asc" : "desc";

    const pageSizeRaw = parseInt(params.get("pageSize") || "", 10);
    const pageSize = (
        PAGE_SIZE_OPTIONS as readonly number[]
    ).includes(pageSizeRaw)
        ? pageSizeRaw
        : DEFAULT_PAGE_SIZE;

    const pageRaw = parseInt(params.get("page") || "", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    const tierRaw = parseInt(params.get("tier") || "", 10);
    const tier = Number.isFinite(tierRaw) && tierRaw > 0 ? tierRaw : null;

    return {
        from: params.get("from") || fallback.from,
        to: params.get("to") || fallback.to,
        q: params.get("q") || "",
        sort,
        dir,
        onlyActive: params.get("active") === "1",
        tier,
        createdAfter: params.get("createdAfter") || "",
        pageSize,
        page,
    };
}

function buildSearchString(state: QueryState, fallback: QueryState): string {
    const params = new URLSearchParams();
    if (state.from !== fallback.from) params.set("from", state.from);
    if (state.to !== fallback.to) params.set("to", state.to);
    if (state.q) params.set("q", state.q);
    if (state.sort !== "created") params.set("sort", state.sort);
    if (state.dir !== "desc") params.set("dir", state.dir);
    if (state.onlyActive) params.set("active", "1");
    if (state.tier !== null) params.set("tier", String(state.tier));
    if (state.createdAfter) params.set("createdAfter", state.createdAfter);
    if (state.pageSize !== DEFAULT_PAGE_SIZE)
        params.set("pageSize", String(state.pageSize));
    if (state.page !== 1) params.set("page", String(state.page));
    return params.toString();
}

// Compute a compact list of page numbers like [1, 2, "…", 7, 8, 9, "…", 27].
function paginationRange(current: number, total: number): (number | "…")[] {
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }
    const out: (number | "…")[] = [1];
    const left = Math.max(2, current - 1);
    const right = Math.min(total - 1, current + 1);
    if (left > 2) out.push("…");
    for (let i = left; i <= right; i++) out.push(i);
    if (right < total - 1) out.push("…");
    out.push(total);
    return out;
}

// ── component ────────────────────────────────────────────────────────────

export default function AdminMaxDashboardPage() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // Held once on mount — used as the "default" range when no URL state
    // is present. Refreshing the page without query params still gives
    // you the standard "last 30 days" view.
    const fallbackRangeRef = useRef(defaultRange());

    const fallbackState: QueryState = useMemo(
        () => ({
            from: fallbackRangeRef.current.from,
            to: fallbackRangeRef.current.to,
            q: "",
            sort: "created",
            dir: "desc",
            onlyActive: false,
            tier: null,
            createdAfter: "",
            pageSize: DEFAULT_PAGE_SIZE,
            page: 1,
        }),
        [],
    );

    const [state, setState] = useState<QueryState>(() =>
        parseQueryState(
            new URLSearchParams(searchParams?.toString() || ""),
            fallbackRangeRef.current,
        ),
    );

    // Local input value for the search box — debounced into state.q.
    const [searchInput, setSearchInput] = useState(state.q);
    useEffect(() => {
        const t = setTimeout(() => {
            if (searchInput !== state.q) {
                setState((s) => ({ ...s, q: searchInput, page: 1 }));
            }
        }, 250);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchInput]);

    // Sync state → URL (replace, not push, so back-button isn't polluted
    // by every keystroke).
    useEffect(() => {
        const s = buildSearchString(state, fallbackState);
        const url = s ? `?${s}` : window.location.pathname;
        window.history.replaceState(null, "", url);
    }, [state, fallbackState]);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<AdminUsersResponse | null>(null);
    const [exporting, setExporting] = useState(false);

    // Tier catalog for the filter dropdown + label fallbacks. Loaded once.
    const [tiers, setTiers] = useState<AdminTierLimit[]>([]);
    useEffect(() => {
        if (!getAdminToken()) return;
        listTiers()
            .then((r) => setTiers(r.tiers))
            .catch(() => {
                // Dropdown simply stays empty — the table still renders.
            });
    }, []);

    useEffect(() => {
        if (!getAdminToken()) {
            router.replace("/adminmax/login");
        }
    }, [router]);

    // Bump on Refresh button, even if nothing in state changed.
    const [refreshNonce, setRefreshNonce] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const offset = (state.page - 1) * state.pageSize;
            const res = await listUsers({
                from: localToIso(state.from),
                to: localToIso(state.to),
                limit: state.pageSize,
                offset,
                q: state.q || undefined,
                sort: state.sort,
                dir: state.dir,
                only_active: state.onlyActive || undefined,
                tier: state.tier ?? undefined,
                created_after: state.createdAfter || undefined,
            });
            setData(res);
            // If the server says we're past the last page (e.g. filter
            // shrank the set), rewind to page 1.
            const maxPage = Math.max(
                1,
                Math.ceil(res.pagination.total / state.pageSize),
            );
            if (state.page > maxPage) {
                setState((s) => ({ ...s, page: 1 }));
            }
        } catch (err) {
            if (err instanceof AdminUnauthorizedError) {
                router.replace("/adminmax/login");
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [
        router,
        state.from,
        state.to,
        state.q,
        state.sort,
        state.dir,
        state.onlyActive,
        state.tier,
        state.createdAfter,
        state.pageSize,
        state.page,
    ]);

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
    }, [load, refreshNonce]);

    async function exportGlobalCsv() {
        setExporting(true);
        try {
            const params = new URLSearchParams({
                from: localToIso(state.from),
                to: localToIso(state.to),
            });
            const fname = `adminmax_usage_all_${state.from.slice(0, 10)}_${state.to.slice(0, 10)}.csv`;
            await triggerCsvDownload(`/usage.csv?${params.toString()}`, fname);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setExporting(false);
        }
    }

    function logout() {
        clearAdminToken();
        router.replace("/adminmax/login");
    }

    function toggleSort(key: SortKey) {
        setState((s) =>
            s.sort === key
                ? { ...s, dir: s.dir === "asc" ? "desc" : "asc", page: 1 }
                : {
                      ...s,
                      sort: key,
                      // Sensible defaults: text asc, numeric desc.
                      dir: key === "email" ? "asc" : "desc",
                      page: 1,
                  },
        );
    }

    const total = data?.pagination.total ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    const showingFrom = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const showingTo = Math.min(state.page * state.pageSize, total);

    const totals = data?.totals;

    return (
        <div className="space-y-6">
            {/* ── header ──────────────────────────────────────────── */}
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <h1 className="font-serif text-2xl font-semibold tracking-tight">
                        AdminMax · Potrošnja
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Pregled tokena i troška po korisniku.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                    <label className="block text-xs">
                        <span className="mb-1 block uppercase tracking-wide text-muted-foreground">
                            Od
                        </span>
                        <input
                            type="datetime-local"
                            value={state.from}
                            onChange={(e) =>
                                setState((s) => ({
                                    ...s,
                                    from: e.target.value,
                                    page: 1,
                                }))
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
                            value={state.to}
                            onChange={(e) =>
                                setState((s) => ({
                                    ...s,
                                    to: e.target.value,
                                    page: 1,
                                }))
                            }
                            className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground"
                        />
                    </label>
                    <button
                        onClick={() => setRefreshNonce((n) => n + 1)}
                        disabled={loading}
                        className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
                    >
                        {loading ? "Učitavam…" : "Osvježi"}
                    </button>
                    <button
                        onClick={exportGlobalCsv}
                        disabled={exporting || total === 0}
                        className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
                    >
                        {exporting ? "Export…" : "CSV (svi)"}
                    </button>
                    <Link
                        href="/adminmax/analytics"
                        className="rounded-md border border-action/40 px-3 py-1.5 text-sm font-medium text-action hover:bg-action/10"
                    >
                        Analitika
                    </Link>
                    <Link
                        href="/adminmax/tiers"
                        className="rounded-md border border-action/40 px-3 py-1.5 text-sm font-medium text-action hover:bg-action/10"
                    >
                        Tier limiti
                    </Link>
                    <button
                        onClick={logout}
                        className="rounded-md border border-input px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                    >
                        Odjava
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {/* ── totals cards ───────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <SummaryCard
                    label="Ukupno korisnika"
                    value={fmtInt(totals?.total_users ?? 0)}
                    subValue="svi registrirani"
                />
                <SummaryCard
                    label="Novi korisnici"
                    value={fmtInt(totals?.new_users_count ?? 0)}
                    subValue={
                        totals?.new_users_since
                            ? `od ${fmtShortDate(totals.new_users_since)}`
                            : "od zadnje prijave"
                    }
                    onClick={
                        totals?.new_users_since
                            ? () =>
                                  setState((s) => ({
                                      ...s,
                                      createdAfter: totals.new_users_since,
                                      sort: "created",
                                      dir: "desc",
                                      page: 1,
                                  }))
                            : undefined
                    }
                />
                <SummaryCard
                    label="Ukupan trošak"
                    value={fmtUsd(totals?.cost_usd_total ?? 0)}
                    subValue={`${fmtInt(total)} korisnika u rasponu`}
                />
                <SummaryCard
                    label="Zahtjevi"
                    value={fmtInt(totals?.request_count ?? 0)}
                    subValue={
                        totals?.error_count
                            ? `Greške: ${fmtInt(totals.error_count)}`
                            : "Greške: 0"
                    }
                />
                <SummaryCard
                    label="Input tokeni"
                    value={fmtInt(totals?.input_tokens_total ?? 0)}
                    subValue={`Output: ${fmtInt(totals?.output_tokens_total ?? 0)}`}
                />
                <SummaryCard
                    label="Cache (read / write)"
                    value={fmtInt(totals?.cache_read_input_tokens_total ?? 0)}
                    subValue={`Write: ${fmtInt(
                        totals?.cache_creation_input_tokens_total ?? 0,
                    )}`}
                />
            </div>

            {/* ── filter bar ─────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                <input
                    type="search"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Traži po emailu ili imenu…"
                    className="min-w-[240px] flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={state.onlyActive}
                        onChange={(e) =>
                            setState((s) => ({
                                ...s,
                                onlyActive: e.target.checked,
                                page: 1,
                            }))
                        }
                        className="h-4 w-4 rounded border-border bg-card text-foreground"
                    />
                    Samo aktivni (≥1 zahtjev)
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Tier</span>
                    <select
                        value={state.tier ?? ""}
                        onChange={(e) =>
                            setState((s) => ({
                                ...s,
                                tier: e.target.value
                                    ? Number(e.target.value)
                                    : null,
                                page: 1,
                            }))
                        }
                        className="rounded-md border border-input bg-card px-2 py-1 text-sm text-foreground"
                    >
                        <option value="">Svi</option>
                        {tiers.map((t) => (
                            <option
                                key={t.tier_level_id}
                                value={t.tier_level_id}
                            >
                                {t.display_label}
                            </option>
                        ))}
                    </select>
                </label>
                {state.createdAfter && (
                    <button
                        onClick={() =>
                            setState((s) => ({
                                ...s,
                                createdAfter: "",
                                page: 1,
                            }))
                        }
                        className="flex items-center gap-1 rounded-full border border-brand/50 bg-brand/15 px-2.5 py-1 text-xs text-foreground hover:bg-brand/25"
                        title="Ukloni filter novih korisnika"
                    >
                        Novi od {fmtDate(state.createdAfter)} ✕
                    </button>
                )}
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Po stranici</span>
                    <select
                        value={state.pageSize}
                        onChange={(e) =>
                            setState((s) => ({
                                ...s,
                                pageSize: Number(e.target.value),
                                page: 1,
                            }))
                        }
                        className="rounded-md border border-input bg-card px-2 py-1 text-sm text-foreground"
                    >
                        {PAGE_SIZE_OPTIONS.map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                </label>
                <span className="ml-auto text-xs text-muted-foreground">
                    {total === 0
                        ? "Nema rezultata"
                        : `Prikaz ${fmtInt(showingFrom)}–${fmtInt(showingTo)} od ${fmtInt(total)}`}
                </span>
            </div>

            {/* ── table ──────────────────────────────────────────── */}
            {/* overflow-x-auto (NOT hidden): on narrow screens the table
                scrolls horizontally instead of clipping columns. Compact
                number formats keep everything on one screen on desktop. */}
            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <SortableTh
                                label="Email"
                                sortKey="email"
                                state={state}
                                onSort={toggleSort}
                            />
                            <SortableTh
                                label="Tier"
                                sortKey="tier"
                                state={state}
                                onSort={toggleSort}
                            />
                            <SortableTh
                                label="Registriran"
                                sortKey="created"
                                state={state}
                                onSort={toggleSort}
                            />
                            <SortableTh
                                label="Aktivnost"
                                sortKey="last_used"
                                state={state}
                                onSort={toggleSort}
                            />
                            <SortableTh
                                label="Trošak"
                                sortKey="cost"
                                state={state}
                                onSort={toggleSort}
                                align="right"
                            />
                            <SortableTh
                                label="Zahtjevi"
                                sortKey="requests"
                                state={state}
                                onSort={toggleSort}
                                align="right"
                            />
                            <Th align="right">Tokeni in / out</Th>
                            <Th align="right">Cache R / W</Th>
                            <SortableTh
                                label="Greške"
                                sortKey="errors"
                                state={state}
                                onSort={toggleSort}
                                align="right"
                            />
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr>
                                <td
                                    colSpan={9}
                                    className="px-4 py-6 text-center text-muted-foreground"
                                >
                                    Učitavam…
                                </td>
                            </tr>
                        )}
                        {!loading && total === 0 && (
                            <tr>
                                <td
                                    colSpan={9}
                                    className="px-4 py-6 text-center text-muted-foreground"
                                >
                                    Nema podataka u zadanom rasponu.
                                </td>
                            </tr>
                        )}
                        {!loading &&
                            data?.users.map((u: AdminUserSummary) => (
                                // Whole row navigates to the user detail —
                                // there is no separate "Detalji" column to
                                // get clipped off-screen anymore.
                                <tr
                                    key={u.id}
                                    onClick={() =>
                                        router.push(`/adminmax/users/${u.id}`)
                                    }
                                    className="cursor-pointer border-t border-border hover:bg-muted"
                                >
                                    <Td className="max-w-[240px]">
                                        <div className="truncate font-medium text-foreground">
                                            {u.email}
                                        </div>
                                        {u.display_name && (
                                            <div className="truncate text-xs text-muted-foreground">
                                                {u.display_name}
                                            </div>
                                        )}
                                    </Td>
                                    <Td>
                                        <TierBadge
                                            label={u.tier_label}
                                            slug={u.tier_slug}
                                            until={u.active_tier_until}
                                        />
                                    </Td>
                                    <Td
                                        className="whitespace-nowrap text-xs text-muted-foreground"
                                        title={fmtDate(u.created_at)}
                                    >
                                        {fmtShortDate(u.created_at)}
                                    </Td>
                                    <Td
                                        className="whitespace-nowrap text-xs text-muted-foreground"
                                        title={`Zadnja aktivnost: ${fmtDate(u.last_used)} · Zadnja prijava: ${fmtDate(u.last_login_at)}`}
                                    >
                                        <div>{fmtShortDate(u.last_used)}</div>
                                        {u.last_login_at && (
                                            <div className="text-[10px] text-muted-foreground">
                                                prijava{" "}
                                                {fmtShortDate(u.last_login_at)}
                                            </div>
                                        )}
                                    </Td>
                                    <Td
                                        align="right"
                                        className="whitespace-nowrap font-mono"
                                    >
                                        {fmtUsd(Number(u.cost_usd_total))}
                                    </Td>
                                    <Td align="right">
                                        {fmtInt(u.request_count)}
                                    </Td>
                                    <Td
                                        align="right"
                                        className="whitespace-nowrap font-mono text-xs"
                                        title={`Input: ${fmtInt(u.input_tokens_total)} · Output: ${fmtInt(u.output_tokens_total)}`}
                                    >
                                        {fmtCompact(u.input_tokens_total)} /{" "}
                                        {fmtCompact(u.output_tokens_total)}
                                    </Td>
                                    <Td
                                        align="right"
                                        className="whitespace-nowrap font-mono text-xs"
                                        title={`Cache read: ${fmtInt(u.cache_read_input_tokens_total)} · write: ${fmtInt(u.cache_creation_input_tokens_total)}`}
                                    >
                                        {fmtCompact(
                                            u.cache_read_input_tokens_total,
                                        )}{" "}
                                        /{" "}
                                        {fmtCompact(
                                            u.cache_creation_input_tokens_total,
                                        )}
                                    </Td>
                                    <Td align="right">
                                        {u.error_count > 0 ? (
                                            <span className="text-destructive">
                                                {u.error_count}
                                            </span>
                                        ) : (
                                            <span className="text-muted-foreground">
                                                0
                                            </span>
                                        )}
                                    </Td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>

            {/* ── pager ──────────────────────────────────────────── */}
            {total > state.pageSize && (
                <Pager
                    page={state.page}
                    totalPages={totalPages}
                    onChange={(p) => setState((s) => ({ ...s, page: p }))}
                />
            )}
        </div>
    );
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Compact tier pill. Paid tiers get an accent ring; the optional `until`
 * date is shown underneath so an expiring subscription is visible at a
 * glance without opening the user detail.
 */
function TierBadge({
    label,
    slug,
    until,
}: {
    label: string | null;
    slug: string | null;
    until: string | null;
}) {
    const isFree = !slug || slug === "eulex_free";
    return (
        <div>
            <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                    isFree
                        ? "border border-border text-muted-foreground"
                        : "border border-success/40 bg-success/15 text-success"
                }`}
            >
                {label ?? "Free"}
            </span>
            {!isFree && until && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                    do {fmtDate(until)}
                </div>
            )}
        </div>
    );
}

function SummaryCard({
    label,
    value,
    subValue,
    onClick,
}: {
    label: string;
    value: string;
    subValue?: string;
    /** When set, the card becomes an interactive button. */
    onClick?: () => void;
}) {
    const className = `rounded-lg border border-border bg-muted/40 px-4 py-3 text-left transition-colors ${
        onClick ? "cursor-pointer hover:bg-accent" : ""
    }`;
    const body = (
        <>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 font-mono text-lg text-foreground">{value}</div>
            {subValue && (
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {subValue}
                </div>
            )}
        </>
    );
    return onClick ? (
        <button type="button" onClick={onClick} className={`block w-full ${className}`}>
            {body}
        </button>
    ) : (
        <div className={className}>{body}</div>
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

function SortableTh({
    label,
    sortKey,
    state,
    onSort,
    align,
}: {
    label: string;
    sortKey: AdminUsersSortKey;
    state: QueryState;
    onSort: (k: AdminUsersSortKey) => void;
    align?: "right";
}) {
    const active = state.sort === sortKey;
    const arrow = !active ? "↕" : state.dir === "asc" ? "↑" : "↓";
    return (
        <th
            className={`px-3 py-2 text-xs font-medium uppercase tracking-wide ${
                align === "right" ? "text-right" : "text-left"
            }`}
        >
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={`inline-flex items-center gap-1 hover:text-foreground ${
                    active
                        ? "font-bold text-foreground"
                        : "text-muted-foreground"
                }`}
            >
                <span>{label}</span>
                <span className="text-[10px] opacity-60">{arrow}</span>
            </button>
        </th>
    );
}

function Td({
    children,
    align,
    className,
    title,
}: {
    children: React.ReactNode;
    align?: "right";
    className?: string;
    /** Full-precision tooltip for cells that render compact values. */
    title?: string;
}) {
    return (
        <td
            title={title}
            className={`px-3 py-2 ${align === "right" ? "text-right" : ""} ${
                className ?? ""
            }`}
        >
            {children}
        </td>
    );
}

function Pager({
    page,
    totalPages,
    onChange,
}: {
    page: number;
    totalPages: number;
    onChange: (p: number) => void;
}) {
    const items = paginationRange(page, totalPages);
    return (
        <div className="flex items-center justify-center gap-1">
            <button
                onClick={() => onChange(Math.max(1, page - 1))}
                disabled={page <= 1}
                className="rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
            >
                « Prethodna
            </button>
            {items.map((it, i) =>
                it === "…" ? (
                    <span
                        key={`gap-${i}`}
                        className="px-2 text-xs text-muted-foreground"
                    >
                        …
                    </span>
                ) : (
                    <button
                        key={it}
                        onClick={() => onChange(it)}
                        className={`rounded-md px-2.5 py-1 text-xs ${
                            it === page
                                ? "bg-action text-action-foreground"
                                : "border border-input text-muted-foreground hover:bg-accent"
                        }`}
                    >
                        {it}
                    </button>
                ),
            )}
            <button
                onClick={() => onChange(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages}
                className="rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
            >
                Sljedeća »
            </button>
        </div>
    );
}
