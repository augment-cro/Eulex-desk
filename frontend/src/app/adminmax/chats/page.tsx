"use client";

/**
 * AdminMax → Razgovori. Workspace-wide chat list from GET /adminmax/chats
 * — every conversation across every user, newest activity first, with a
 * cost/message rollup per chat. Search covers chat title, owner
 * email/name AND message content (forensic / PII-compliance oversight).
 * Row click opens the shared ChatThreadModal with the full Q+A thread.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AdminUnauthorizedError,
    getAdminToken,
    listChats,
    type AdminChatListRow,
} from "../lib/adminApi";
import { ChatThreadModal } from "../components/ChatThreadModal";

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

export default function AdminMaxChatsPage() {
    const router = useRouter();
    const [range, setRange] = useState(defaultRange);
    const [q, setQ] = useState("");
    const [appliedQ, setAppliedQ] = useState("");
    const [page, setPage] = useState(0);
    const [rows, setRows] = useState<AdminChatListRow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [openChat, setOpenChat] = useState<{
        chatId: string;
        userId: string;
    } | null>(null);

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await listChats({
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
                        AdminMax · Razgovori
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        Svi razgovori u sustavu — pretraga po naslovu,
                        korisniku i sadržaju poruka.
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
                    placeholder="Naslov, email korisnika ili tekst poruke…"
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
                    {fmtInt(total)} razgovora
                </span>
            </form>

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-muted text-muted-foreground">
                        <tr>
                            <Th>Zadnja aktivnost</Th>
                            <Th>Korisnik</Th>
                            <Th>Naslov</Th>
                            <Th align="right">Poruke</Th>
                            <Th align="right">Zahtjevi</Th>
                            <Th align="right">Trošak</Th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.map((r) => (
                            <tr
                                key={r.id}
                                onClick={() =>
                                    setOpenChat({
                                        chatId: r.id,
                                        userId: r.user_id,
                                    })
                                }
                                className="cursor-pointer bg-card hover:bg-accent/50"
                            >
                                <Td className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                                    {fmtDate(r.last_activity_at)}
                                </Td>
                                <Td>
                                    <Link
                                        href={`/adminmax/users/${r.user_id}`}
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-foreground underline-offset-2 hover:underline"
                                    >
                                        {r.email ?? r.user_id.slice(0, 8)}
                                    </Link>
                                    {r.display_name && (
                                        <span className="ml-1 text-xs text-muted-foreground">
                                            ({r.display_name})
                                        </span>
                                    )}
                                </Td>
                                <Td className="max-w-[28rem]">
                                    <span className="line-clamp-1 text-foreground">
                                        {r.title ?? (
                                            <span className="text-muted-foreground">
                                                (bez naslova)
                                            </span>
                                        )}
                                    </span>
                                    {r.project_id && (
                                        <span className="ml-1 rounded bg-accent px-1 py-0.5 text-[10px] text-accent-foreground">
                                            project
                                        </span>
                                    )}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {fmtInt(r.message_count)}
                                </Td>
                                <Td align="right" className="font-mono text-xs">
                                    {fmtInt(r.request_count)}
                                    {r.error_count > 0 && (
                                        <span className="ml-1 text-destructive">
                                            ({r.error_count}!)
                                        </span>
                                    )}
                                </Td>
                                <Td
                                    align="right"
                                    className="font-mono text-xs text-success"
                                >
                                    {fmtUsd(r.cost_usd_total)}
                                </Td>
                            </tr>
                        ))}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td
                                    colSpan={6}
                                    className="bg-card px-3 py-8 text-center text-sm text-muted-foreground"
                                >
                                    Nema razgovora za odabrani raspon/filtar.
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

            {openChat && (
                <ChatThreadModal
                    chatId={openChat.chatId}
                    userId={openChat.userId}
                    onClose={() => setOpenChat(null)}
                />
            )}
        </div>
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
