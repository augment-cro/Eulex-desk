"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    clearAdminToken,
    getAdminToken,
    getDatabasesOverview,
    type DatabasesOverview,
    type DbJurisdiction,
    type DbLayer,
    type DbLayerStatus,
    type DbSnapshotMeta,
    type DbSource,
    type DbStatValue,
} from "../lib/adminApi";

// ── formatters ────────────────────────────────────────────────────────────

function fmtInt(n: number): string {
    return new Intl.NumberFormat("hr-HR").format(n);
}

function fmtVal(v: DbStatValue | undefined): string {
    if (v === null || v === undefined) return "—";
    if (typeof v === "number") return fmtInt(v);
    if (typeof v === "boolean") return v ? "da" : "ne";
    return v;
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

const TRIGGER_LABEL: Record<DbSnapshotMeta["trigger"], string> = {
    manual: "ručno (gumb)",
    cron: "automatski (raspored)",
    boot: "prvi sken",
};

const STATUS_LABEL: Record<DbLayerStatus, string> = {
    ok: "OK",
    partial: "djelomično",
    empty: "prazno",
    error: "greška",
    unconfigured: "nije konfigurirano",
};

const STATUS_CLS: Record<DbLayerStatus, string> = {
    ok: "bg-brand/30 text-foreground",
    partial: "bg-amber-200/60 text-foreground",
    empty: "bg-muted text-muted-foreground",
    error: "bg-destructive/15 text-destructive",
    unconfigured: "border border-dashed border-border text-muted-foreground",
};

function StatusPill({ status }: { status: DbLayerStatus }) {
    return (
        <span
            className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLS[status]}`}
        >
            {STATUS_LABEL[status]}
        </span>
    );
}

function TierBadge({ tier }: { tier: number }) {
    const dots = [0, 1, 2].map((i) => (
        <span
            key={i}
            className={`inline-block h-2.5 w-2.5 rounded-full ${
                i < tier ? "bg-foreground" : "bg-border"
            }`}
        />
    ));
    return (
        <span className="inline-flex items-center gap-1" title={`Stupanj ${tier}/3`}>
            {dots}
            <span className="ml-1 text-xs text-muted-foreground">{tier}/3</span>
        </span>
    );
}

/** Small "n / label" cell: primary number with a muted caption under it. */
function Num({
    v,
    label,
    approx,
}: {
    v: DbStatValue | undefined;
    label?: string;
    approx?: boolean;
}) {
    return (
        <div className="leading-tight">
            <div className="tabular-nums">
                {approx && typeof v === "number" ? "≈" : ""}
                {fmtVal(v)}
            </div>
            {label && (
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {label}
                </div>
            )}
        </div>
    );
}

// ── page ──────────────────────────────────────────────────────────────────

export default function AdminMaxDatabasesPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<DatabasesOverview | null>(null);
    const [open, setOpen] = useState<string | null>(null);

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    async function load(refresh = false) {
        setLoading(true);
        setError(null);
        try {
            setData(await getDatabasesOverview(refresh));
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

    function logout() {
        clearAdminToken();
        router.replace("/adminmax/login");
    }

    const rows = data?.jurisdictions ?? [];

    return (
        <div className="space-y-6">
            <div className="flex items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <h1 className="font-serif text-2xl font-semibold tracking-tight">
                        AdminMax · Baze
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Inventar podatkovnih izvora po jurisdikciji, kako ga
                        prijavljuje vanjski ops servis: SQL (akti, članci,
                        veze, TOC) → vektori → graf. Stupanj = broj slojeva
                        koji imaju podatke. Otvaranje taba samo čita spremljeni
                        snapshot; novi sken radi zakazani job, gumb „Osvježi
                        sada” ili MCP alat get_databases.
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
                        onClick={() => load(true)}
                        disabled={loading}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        title="Zatraži novi sken od ops servisa (može trajati nekoliko minuta)"
                    >
                        {loading ? "Skeniram…" : "Osvježi sada"}
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

            {loading && !data && (
                <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
                    Učitavam zadnji spremljeni snapshot…
                </div>
            )}

            {data && data.available === false && (
                <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
                    Inventar baza nije dostupan: backend nema konfiguriran
                    vanjski ops servis (OPS_INVENTORY_URL).
                    {data.detail ? ` (${data.detail})` : ""}
                </div>
            )}

            {data && data.available !== false && (
                <>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
                        <Tile label="Jurisdikcija" value={fmtInt(data.totals.jurisdictions)} />
                        <Tile label="Stupanj 3 (SQL+vek+graf)" value={fmtInt(data.totals.tier3)} />
                        <Tile label="Stupanj 2" value={fmtInt(data.totals.tier2)} />
                        <Tile label="Stupanj 1" value={fmtInt(data.totals.tier1)} />
                        <Tile label="Dokumenata / akata (SQL)" value={fmtInt(data.totals.sql_documents)} />
                        <Tile label="Vektora" value={fmtInt(data.totals.vectors)} />
                        <Tile label="Čvorova u grafu" value={fmtInt(data.totals.graph_nodes)} />
                    </div>

                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>
                            <span className="font-medium text-foreground">
                                Stanje na dan {fmtDate(data.snapshot?.taken_at ?? data.generated_at)}
                            </span>
                            {data.snapshot
                                ? ` · ${TRIGGER_LABEL[data.snapshot.trigger]} · sken ${Math.round(data.snapshot.scan_ms / 1000)} s`
                                : " · još nema spremljenog skena"}
                            {loading && " · skeniram…"}
                        </span>
                        <span>Automatski sken: {data.schedule}</span>
                    </div>
                    {data.history.length > 1 && (
                        <details className="text-xs text-muted-foreground">
                            <summary className="cursor-pointer">
                                Povijest skenova ({data.history.length})
                            </summary>
                            <ul className="mt-1 space-y-0.5 pl-4">
                                {data.history.map((h) => (
                                    <li key={h.id}>
                                        {fmtDate(h.taken_at)} · {TRIGGER_LABEL[h.trigger]} ·{" "}
                                        {Math.round(h.scan_ms / 1000)} s
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}

                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full text-sm">
                            <thead className="bg-muted text-muted-foreground">
                                <tr>
                                    <Th>Jurisdikcija</Th>
                                    <Th>Stupanj</Th>
                                    <Th>SQL</Th>
                                    <Th right>Akti / verzije</Th>
                                    <Th right>Članci</Th>
                                    <Th right>Veze int. / ekst.</Th>
                                    <Th right>TOC</Th>
                                    <Th right>Sudska praksa</Th>
                                    <Th>Vektori</Th>
                                    <Th>Graf</Th>
                                    <Th>Servisi</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.length === 0 && (
                                    <tr>
                                        <td colSpan={11} className="px-4 py-6 text-center text-muted-foreground/70">
                                            {data.snapshot
                                                ? "Snapshot je prazan — provjeri konfiguraciju izvora ispod."
                                                : "Još nema spremljenog skena. Klikni „Osvježi sada” ili pričekaj zakazani sken."}
                                        </td>
                                    </tr>
                                )}
                                {rows.map((r) => (
                                    <JurisdictionRow
                                        key={r.code}
                                        row={r}
                                        open={open === r.code}
                                        onToggle={() => setOpen(open === r.code ? null : r.code)}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <h2 className="font-serif text-lg font-semibold tracking-tight">
                        Izvori (baze)
                    </h2>
                    <div className="grid gap-3 md:grid-cols-2">
                        {data.sources.map((s) => (
                            <SourceCard key={s.key} s={s} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

function Tile({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border bg-card px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
        </div>
    );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
    return (
        <th
            className={`px-3 py-2 text-xs font-medium uppercase tracking-wide ${
                right ? "text-right" : "text-left"
            }`}
        >
            {children}
        </th>
    );
}

function JurisdictionRow({
    row,
    open,
    onToggle,
}: {
    row: DbJurisdiction;
    open: boolean;
    onToggle: () => void;
}) {
    const s = row.sql.stats;
    const acts = s.documents ?? s.acts ?? s.regulations ?? s.articles;
    const versions = s.versions;
    const articles = s.articles ?? s.segments_estimate ?? s.provisions;
    const toc = s.toc_documents ?? s.toc_nodes ?? s.toc_paths;
    return (
        <>
            <tr
                className="cursor-pointer border-t border-border hover:bg-accent/60"
                onClick={onToggle}
            >
                <td className="px-3 py-2 whitespace-nowrap">
                    <span className="mr-1.5">{row.flag}</span>
                    <span className="font-medium">{row.name}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                        {row.services.scope ?? row.code}
                    </span>
                </td>
                <td className="px-3 py-2">
                    <TierBadge tier={row.tier} />
                </td>
                <td className="px-3 py-2">
                    <StatusPill status={row.sql.status} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                    {fmtVal(acts)}
                    {versions !== undefined && versions !== null && (
                        <span className="text-muted-foreground"> / {fmtVal(versions)}</span>
                    )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                    {s.segments_estimate !== undefined && s.articles === undefined ? "≈" : ""}
                    {fmtVal(articles)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                    {fmtVal(s.internal_links)}
                    <span className="text-muted-foreground"> / {fmtVal(s.external_links)}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtVal(toc)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtVal(s.case_law)}</td>
                <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                        <StatusPill status={row.vector.status} />
                        <span className="tabular-nums">{fmtVal(row.vector.stats.records)}</span>
                    </div>
                </td>
                <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                        <StatusPill status={row.graph.status} />
                        <span className="tabular-nums">
                            {fmtVal(row.graph.stats.nodes)}
                            <span className="text-muted-foreground"> / {fmtVal(row.graph.stats.relations)}</span>
                        </span>
                    </div>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.services.api ?? "—"}
                    {row.services.mcp && <div>{row.services.mcp}</div>}
                </td>
            </tr>
            {open && (
                <tr className="border-t border-border bg-muted/40">
                    <td colSpan={11} className="px-4 py-3">
                        <div className="grid gap-4 md:grid-cols-3">
                            <LayerDetail title="SQL" layer={row.sql} />
                            <LayerDetail title="Vektori" layer={row.vector} />
                            <LayerDetail title="Graf" layer={row.graph} />
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}

function LayerDetail({ title, layer }: { title: string; layer: DbLayer }) {
    const entries = Object.entries(layer.stats);
    return (
        <div className="rounded-md border border-border bg-card p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
                <div className="font-medium">{title}</div>
                <StatusPill status={layer.status} />
            </div>
            <div className="mb-2 text-xs text-muted-foreground">{layer.source}</div>
            {layer.error && (
                <div className="mb-2 rounded border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    {layer.error}
                </div>
            )}
            {entries.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {entries.map(([k, v]) => (
                        <div key={k} className="contents">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="text-right tabular-nums">
                                <Num v={v} approx={k.endsWith("_estimate")} />
                            </dd>
                        </div>
                    ))}
                </dl>
            )}
            {layer.notes.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {layer.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function SourceCard({ s }: { s: DbSource }) {
    const status: DbLayerStatus = s.status === "ok" ? "ok" : s.status;
    return (
        <div className="rounded-lg border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.kind}</div>
                    <div className="text-sm font-medium">{s.label}</div>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                    {s.latency_ms !== null && (
                        <span className="text-xs text-muted-foreground">{fmtInt(s.latency_ms)} ms</span>
                    )}
                    <StatusPill status={status} />
                </div>
            </div>
            {s.error && (
                <div className="mt-2 rounded border border-destructive/20 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                    {s.error}
                </div>
            )}
            {Object.keys(s.details).length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {Object.entries(s.details).map(([k, v]) => (
                        <div key={k} className="contents">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="break-all text-right tabular-nums">{fmtVal(v)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}
