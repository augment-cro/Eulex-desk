"use client";

/**
 * Persistent "new users since last look" corner badge for the AdminMax
 * shell. Polls GET /adminmax/new-users every 60s; clicking the bubble
 * opens a panel with the most recent signups, a deep-link into the users
 * table filtered to them, and the "mark seen" reset (POST /new-users/seen
 * — global state in admin_state, shared by every operator).
 *
 * Renders nothing on /adminmax/login or when no admin token is present.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    getAdminToken,
    getNewUsers,
    markNewUsersSeen,
    type NewUsersResponse,
} from "../lib/adminApi";

const POLL_MS = 60_000;

function fmtDateTime(s: string): string {
    try {
        return new Date(s).toLocaleString("hr-HR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return s;
    }
}

export default function NewUsersBadge() {
    const pathname = usePathname();
    const [data, setData] = useState<NewUsersResponse | null>(null);
    const [open, setOpen] = useState(false);
    const [marking, setMarking] = useState(false);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        if (!getAdminToken()) {
            setData(null);
            return;
        }
        try {
            setData(await getNewUsers());
        } catch {
            // Silent — the badge is an enhancement, never an error surface.
        }
    }, []);

    useEffect(() => {
        load();
        const t = setInterval(load, POLL_MS);
        return () => clearInterval(t);
    }, [load]);

    // Close the panel on outside click.
    useEffect(() => {
        if (!open) return;
        function onDown(e: MouseEvent) {
            if (
                panelRef.current &&
                !panelRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    async function onMarkSeen() {
        setMarking(true);
        try {
            await markNewUsersSeen();
            await load();
            setOpen(false);
        } catch {
            // ignore — next poll will resync
        } finally {
            setMarking(false);
        }
    }

    if (pathname?.startsWith("/adminmax/login")) return null;
    if (!data) return null;

    const count = data.count;

    return (
        <div ref={panelRef} className="fixed bottom-5 right-5 z-50">
            {open && (
                <div className="absolute bottom-12 right-0 w-80 rounded-lg border border-border bg-card p-3 shadow-xl">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-semibold text-foreground">
                            Novi korisnici
                        </span>
                        <span className="text-xs text-muted-foreground">
                            od {fmtDateTime(data.since)}
                        </span>
                    </div>
                    {count === 0 ? (
                        <p className="py-2 text-sm text-muted-foreground">
                            Nema novih korisnika od zadnjeg pregleda.
                        </p>
                    ) : (
                        <ul className="max-h-56 space-y-1 overflow-y-auto">
                            {data.recent.map((u) => (
                                <li key={u.id}>
                                    <Link
                                        href={`/adminmax/users/${u.id}`}
                                        className="block rounded-md px-2 py-1.5 hover:bg-accent"
                                        onClick={() => setOpen(false)}
                                    >
                                        <span className="block truncate text-sm text-foreground">
                                            {u.email}
                                        </span>
                                        <span className="block text-xs text-muted-foreground">
                                            {u.display_name
                                                ? `${u.display_name} · `
                                                : ""}
                                            {fmtDateTime(u.created_at)}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                        <Link
                            href={`/adminmax?sort=created&dir=desc&createdAfter=${encodeURIComponent(data.since)}`}
                            className="text-xs font-medium text-action hover:text-action/80"
                            onClick={() => setOpen(false)}
                        >
                            Prikaži sve →
                        </Link>
                        <button
                            onClick={onMarkSeen}
                            disabled={marking || count === 0}
                            className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-50"
                        >
                            {marking ? "Spremam…" : "Označi viđeno"}
                        </button>
                    </div>
                </div>
            )}
            <button
                onClick={() => setOpen((o) => !o)}
                aria-label={`Novi korisnici: ${count}`}
                className={`relative flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition-colors ${
                    count > 0
                        ? "border-brand/60 bg-brand text-brand-foreground hover:bg-brand/90"
                        : "border-border bg-card text-muted-foreground hover:bg-accent"
                }`}
            >
                {/* user-plus glyph, inline so the admin shell stays dependency-free */}
                <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                    aria-hidden="true"
                >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <line x1="19" x2="19" y1="8" y2="14" />
                    <line x1="22" x2="16" y1="11" y2="11" />
                </svg>
                {count > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[11px] font-bold text-destructive-foreground">
                        {count > 99 ? "99+" : count}
                    </span>
                )}
            </button>
        </div>
    );
}
