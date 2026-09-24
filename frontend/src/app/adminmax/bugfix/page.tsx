"use client";

/**
 * AdminMax → BugFix status. Live bug tracking from GitHub via
 * GET /adminmax/bugfix/status: issues newest-first, their linked fix PRs,
 * a server-derived status per issue, and the stable...main deploy lag.
 * The backend caches the composed payload for 60 s; the refresh button
 * simply re-fetches.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    AdminUnauthorizedError,
    getAdminToken,
    getBugfixStatus,
    type BugfixIssue,
    type BugfixIssueStatus,
    type BugfixStatusResponse,
} from "../lib/adminApi";

// Status → status-ladder tokens (see _ai/DESIGN.md): open bug = destructive,
// PR in review = warning, merged (waiting LIVE) = success, live (deployed,
// issue still open) = stronger success, closed = muted.
const STATUS_BADGE_CLASS: Record<BugfixIssueStatus, string> = {
    open: "border-destructive/30 bg-destructive/10 text-destructive",
    pr_open: "border-warning/30 bg-warning/10 text-warning",
    merged: "border-success/30 bg-success/10 text-success",
    live: "border-success/50 bg-success/20 text-success",
    closed: "border-border bg-muted text-muted-foreground",
};

const STATUS_LABEL_KEY: Record<BugfixIssueStatus, string> = {
    open: "statusOpen",
    pr_open: "statusPrOpen",
    merged: "statusMerged",
    live: "statusLive",
    closed: "statusClosed",
};

const STATUS_ORDER: BugfixIssueStatus[] = [
    "open",
    "pr_open",
    "merged",
    "live",
    "closed",
];

export default function AdminMaxBugfixPage() {
    const t = useTranslations("adminmaxBugfix");
    const locale = useLocale();
    const router = useRouter();
    const [data, setData] = useState<BugfixStatusResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!getAdminToken()) router.replace("/adminmax/login");
    }, [router]);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await getBugfixStatus();
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
    }, [router]);

    useEffect(() => {
        if (!getAdminToken()) return;
        load();
    }, [load]);

    function fmtDate(s: string | null): string {
        if (!s) return "—";
        try {
            return new Date(s).toLocaleDateString(locale, {
                year: "2-digit",
                month: "2-digit",
                day: "2-digit",
            });
        } catch {
            return s;
        }
    }

    function fmtDateTime(s: string): string {
        try {
            return new Date(s).toLocaleString(locale, {
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

    const configured = data?.configured === true ? data : null;
    const issues = configured?.issues ?? [];
    const counts = STATUS_ORDER.reduce(
        (acc, s) => {
            acc[s] = issues.filter((i) => i.status === s).length;
            return acc;
        },
        {} as Record<BugfixIssueStatus, number>,
    );
    const ahead = configured?.deploy.mainAheadOfStable ?? null;

    return (
        <div className="space-y-6">
            {/* ── header ─────────────────────────────────────────── */}
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
                <div>
                    <Link
                        href="/adminmax"
                        className="text-xs text-muted-foreground hover:text-foreground"
                    >
                        {t("backToList")}
                    </Link>
                    <h1 className="mt-1 font-serif text-2xl font-semibold tracking-tight">
                        {t("title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t("subtitle")}
                        {data?.repo ? (
                            <span className="ml-1 font-mono text-xs">
                                ({data.repo})
                            </span>
                        ) : null}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {configured?.fetchedAt && (
                        <span className="text-xs text-muted-foreground">
                            {t("fetchedAt", {
                                time: fmtDateTime(configured.fetchedAt),
                            })}
                        </span>
                    )}
                    <Button size="sm" onClick={load} disabled={loading}>
                        <RefreshCw
                            className={cn(
                                "h-3.5 w-3.5",
                                loading && "animate-spin",
                            )}
                            aria-hidden="true"
                        />
                        {loading ? t("loading") : t("refresh")}
                    </Button>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            {/* ── token not configured ───────────────────────────── */}
            {data && !data.configured && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-4">
                    <h2 className="text-sm font-semibold text-foreground">
                        {t("notConfiguredTitle")}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {t("notConfiguredBody", { repo: data.repo })}
                    </p>
                </div>
            )}

            {configured && (
                <>
                    {/* ── summary tiles + deploy card ────────────── */}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        {STATUS_ORDER.map((s) => (
                            <SummaryCard
                                key={s}
                                label={t(STATUS_LABEL_KEY[s])}
                                value={String(counts[s])}
                                badgeClass={STATUS_BADGE_CLASS[s]}
                            />
                        ))}
                        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                {t("deployTitle")}
                            </div>
                            <div className="mt-1 text-sm text-foreground">
                                {ahead == null
                                    ? t("deployUnknown")
                                    : t("deployAhead", { count: ahead })}
                            </div>
                        </div>
                    </div>

                    {/* ── issues table ───────────────────────────── */}
                    <div className="overflow-x-auto rounded-lg border border-border">
                        <table className="w-full min-w-[720px] text-sm">
                            <thead className="bg-muted text-muted-foreground">
                                <tr>
                                    <Th>{t("colNumber")}</Th>
                                    <Th>{t("colTitle")}</Th>
                                    <Th>{t("colStatus")}</Th>
                                    <Th>{t("colPr")}</Th>
                                    <Th>{t("colCreated")}</Th>
                                    <Th>{t("colClosed")}</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading && issues.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={6}
                                            className="px-4 py-6 text-center text-muted-foreground"
                                        >
                                            {t("loading")}
                                        </td>
                                    </tr>
                                )}
                                {!loading && issues.length === 0 && (
                                    <tr>
                                        <td
                                            colSpan={6}
                                            className="px-4 py-6 text-center text-muted-foreground"
                                        >
                                            {t("empty")}
                                        </td>
                                    </tr>
                                )}
                                {issues.map((issue) => (
                                    <IssueRow
                                        key={issue.number}
                                        issue={issue}
                                        statusLabel={t(
                                            STATUS_LABEL_KEY[issue.status],
                                        )}
                                        fmtDate={fmtDate}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                </>
            )}

            {!data && loading && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("loading")}
                </p>
            )}
        </div>
    );
}

function SummaryCard({
    label,
    value,
    badgeClass,
}: {
    label: string;
    value: string;
    badgeClass: string;
}) {
    return (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-lg text-foreground">
                    {value}
                </span>
                <span
                    className={cn(
                        "inline-block h-2.5 w-2.5 rounded-full border",
                        badgeClass,
                    )}
                    aria-hidden="true"
                />
            </div>
        </div>
    );
}

function IssueRow({
    issue,
    statusLabel,
    fmtDate,
}: {
    issue: BugfixIssue;
    statusLabel: string;
    fmtDate: (s: string | null) => string;
}) {
    return (
        <tr className="border-t border-border hover:bg-muted">
            <Td className="font-mono text-muted-foreground">
                <a
                    href={issue.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground hover:underline"
                >
                    #{issue.number}
                </a>
            </Td>
            <Td className="max-w-[380px]">
                <a
                    href={issue.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-medium text-foreground hover:underline"
                    title={issue.title}
                >
                    {issue.title}
                </a>
                {issue.labels.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {issue.labels.map((label) => (
                            <Badge
                                key={label}
                                variant="outline"
                                className="px-1.5 py-0 text-[10px] text-muted-foreground"
                            >
                                {label}
                            </Badge>
                        ))}
                    </div>
                )}
            </Td>
            <Td>
                <Badge
                    variant="outline"
                    className={cn(STATUS_BADGE_CLASS[issue.status])}
                >
                    {statusLabel}
                </Badge>
            </Td>
            <Td className="font-mono">
                {issue.linkedPr ? (
                    <a
                        href={issue.linkedPr.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground hover:underline"
                    >
                        #{issue.linkedPr.number}
                    </a>
                ) : (
                    <span className="text-muted-foreground">—</span>
                )}
            </Td>
            <Td className="whitespace-nowrap text-muted-foreground">
                {fmtDate(issue.createdAt)}
            </Td>
            <Td className="whitespace-nowrap text-muted-foreground">
                {fmtDate(issue.closedAt)}
            </Td>
        </tr>
    );
}

function Th({ children }: { children: React.ReactNode }) {
    return (
        <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide">
            {children}
        </th>
    );
}

function Td({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return <td className={cn("px-4 py-2.5 align-top", className)}>{children}</td>;
}
