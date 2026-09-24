"use client";

/**
 * AdminMax → Audit. Read-only view of the admin action audit trail
 * (GET /adminmax/audit): every mutating /adminmax/* action and data
 * export, newest first. The table is append-only on the backend —
 * there is deliberately no delete/edit surface here.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    getAdminToken,
    listAudit,
    type AdminAuditRow,
} from "../lib/adminApi";

const PAGE_SIZE = 50;

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

/** Croatian gloss for known action verbs; unknown verbs show raw. */
const ACTION_LABEL: Record<string, string> = {
    "user.tier.set": "Tier dodijeljen",
    "user.tier.clear": "Tier uklonjen",
    "user.profile.update": "Profil uređen",
    "user.suspend": "Korisnik suspendiran",
    "user.unsuspend": "Suspenzija ukinuta",
    "credits.grant": "Krediti dodijeljeni",
    "credits.void": "Krediti poništeni",
    "tier.update": "Tier limit uređen",
    "tier.create": "Tier kreiran",
    "export.usage_csv": "CSV export",
    "email.weekly_summary.send": "Tjedni sažetak poslan",
    "email.expiry_reminders.send": "Podsjetnici isteka poslani",
};

export default function AdminMaxAuditPage() {
    const router = useRouter();
    const [range, setRange] = useState(defaultRange);
    const [q, setQ] = useState("");
    const [appliedQ, setAppliedQ] = useState("");
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState<AdminAuditRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await listAudit({
                from: new Date(range.from).toISOString(),
                to: new Date(range.to).toISOString(),
                q: appliedQ || undefined,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
            });
            setRows(res.rows);
            setTotal(res.total);
        } catch (err) {
            if (err instanceof AdminUnauthorizedError) {
                router.replace("/adminmax/login");
                return;
            }
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [range.from, range.to, appliedQ, page, router]);

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
    }, [load]);

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
                        AdminMax · Audit
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Trag svih administratorskih akcija i exporta
                        (append-only).
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
                            onChange={(e) => {
                                setRange((r) => ({ ...r, from: e.target.value }));
                                setPage(0);
                            }}
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
                            onChange={(e) => {
                                setRange((r) => ({ ...r, to: e.target.value }));
                                setPage(0);
                            }}
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
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    setAppliedQ(q.trim());
                    setPage(0);
                }}
                className="flex flex-wrap items-center gap-2"
            >
                <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Akcija (npr. credits.grant), user id, tier…"
                    className="w-full max-w-md rounded-md border border-input bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
                />
                <button
                    type="submit"
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
                >
                    Traži
                </button>
                {appliedQ && (
                    <button
                        type="button"
                        onClick={() => {
                            setQ("");
                            setAppliedQ("");
                            setPage(0);
                        }}
                        className="text-xs text-muted-foreground hover:text-foreground"
                    >
                        Očisti filtar („{appliedQ}“)
                    </button>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                    {fmtInt(total)} zapisa
                </span>
            </form>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <Th>Vrijeme</Th>
                            <Th>Akcija</Th>
                            <Th>Cilj</Th>
                            <Th>Detalji</Th>
                            <Th>IP</Th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map((r) => (
                            <AuditRow key={r.id} row={r} />
                        ))}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td
                                    colSpan={5}
                                    className="bg-card px-3 py-8 text-center text-sm text-muted-foreground"
                                >
                                    Nema zapisa za odabrani raspon/filtar.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            <Pagination
                page={page}
                totalPages={totalPages}
                onPage={(p) => setPage(p)}
            />
        </div>
    );
}

function AuditRow({ row }: { row: AdminAuditRow }) {
    const [expanded, setExpanded] = useState(false);
    const payloadText = row.payload
        ? JSON.stringify(row.payload, null, expanded ? 2 : 0)
        : null;
    const isUserTarget = row.target_type === "user" && row.target_id;
    return (
        <tr className="bg-card align-top">
            <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                {fmtDate(row.created_at)}
            </Td>
            <Td>
                <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-xs text-accent-foreground">
                    {row.action}
                </span>
                <div className="mt-0.5 text-xs text-muted-foreground">
                    {ACTION_LABEL[row.action] ?? ""}
                </div>
            </Td>
            <Td className="font-mono text-xs">
                {isUserTarget ? (
                    <Link
                        href={`/adminmax/users/${row.target_id}`}
                        className="text-foreground underline-offset-2 hover:underline"
                    >
                        {row.target_id!.slice(0, 8)}…
                    </Link>
                ) : (
                    <span className="text-muted-foreground">
                        {row.target_type
                            ? `${row.target_type}:${row.target_id ?? "—"}`
                            : "—"}
                    </span>
                )}
            </Td>
            <Td className="max-w-[32rem]">
                {payloadText ? (
                    <button
                        type="button"
                        onClick={() => setExpanded((v) => !v)}
                        className="text-left"
                        title={expanded ? "Skupi" : "Proširi"}
                    >
                        <pre
                            className={`whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground ${
                                expanded ? "" : "line-clamp-2"
                            }`}
                        >
                            {payloadText}
                        </pre>
                    </button>
                ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                )}
            </Td>
            <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                {row.ip ?? "—"}
            </Td>
        </tr>
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
