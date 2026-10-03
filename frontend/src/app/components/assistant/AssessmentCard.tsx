"use client";

import { useState } from "react";
import { AlertTriangle, FileSpreadsheet, Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusDot } from "../shared/StatusDot";
import type { StatusKind } from "../shared/statusTokens";
import type { AssessmentSnapshot, AssessmentStatus } from "../shared/types";
import { checkerPath, classificationDecisions, decisionSteps } from "./assessmentDecisions";

/** Status of a finding → its dot (and the statusDot label). */
const DOT: Record<AssessmentStatus, StatusKind> = {
    material: "problem",
    gap: "gap",
    legal: "assessment",
    insufficient: "insufficient",
    ok: "clear",
};
/** The model's emoji, kept (hidden) in each dot so copying the card keeps it. */
const TOKEN: Record<AssessmentStatus, string> = {
    material: "\u{1F534}",
    gap: "\u{1F7E1}",
    legal: "\u{1F535}",
    insufficient: "\u26AA",
    ok: "\u{1F7E2}",
};
const STATUS_ORDER: AssessmentStatus[] = ["material", "gap", "legal", "insufficient", "ok"];

// The record's Croatian labels → i18n keys (shown as is in Croatian).
const CATEGORY: Record<string, string> = { zakon: "law", smjernica: "guidance", kodeks: "code", interno: "internal" };
const VERIFICATION: Record<string, string> = {
    provjereno: "verified",
    djelomično: "partial",
    nedostaje: "missing",
    "nije provjereno": "notVerified",
    "potrebna provjera": "checkNeeded",
};
const APPLICABILITY: Record<string, string> = {
    sada: "now",
    kasnije: "later",
    "ne primjenjuje se": "notApplicable",
    neutvrđeno: "undetermined",
};
const WEIGHT: Record<string, string> = {
    izjava: "statement",
    dokument: "document",
    "izvještaj treće strane": "thirdParty",
    opaženo: "observed",
    nema: "none",
};
const FACT_STATUS: Record<string, string> = {
    user_asserted: "userAsserted",
    document_supported: "documentSupported",
    observed: "observed",
    inferred: "inferred",
    unknown: "unknown",
    conflicting: "conflicting",
};
const WARNING_TINT: Record<string, string> = {
    STOP: "bg-status-problem",
    REVIEW: "bg-status-gap",
    STANDARD: "bg-status-clear",
};

/** Rows shown before "show all". */
const COLLAPSED_ROWS = 8;
/** Characters of a Checker answer's reasoning shown in the card (all of it in Excel). */
const REASONING_CHARS = 220;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export interface ContinueAssessment {
    workflow: { id: string; title: string; type: "assistant" } | null;
    text: string;
}

/**
 * The REZULTAT card: the latest version of the assessment record an answer
 * kept (record_assessment) — counts per status as soft dots, the internal
 * warning level, what changed against the previous version, the
 * classification per use case and the path through the Compliance Checker
 * (decisions CHK-…, the decisive one marked, each with its evidence), one
 * compact row per finding, unread documents and conflicting sources, an
 * Excel download (findings, then decisions) and "Nastavi procjenu", which
 * selects the task again in the composer with the assessment id filled in.
 */
export function AssessmentCard({
    assessment: a,
    onContinue,
    className,
}: {
    assessment: AssessmentSnapshot;
    onContinue?: (args: ContinueAssessment) => void;
    className?: string;
}) {
    const t = useTranslations("assessmentCard");
    const tDot = useTranslations("statusDot");
    const tExport = useTranslations("assistant.tableExport");
    const [expanded, setExpanded] = useState(false);
    const [showChecker, setShowChecker] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);

    const label = (map: Record<string, string>, group: string, value: string) =>
        map[value] ? t(`${group}.${map[value]}`) : value;
    const rows = expanded ? a.findings : a.findings.slice(0, COLLAPSED_ROWS);
    const classified = classificationDecisions(a);
    const checker = checkerPath(a);
    /** A step's evidence: its documents and pages, else the status of its facts. */
    const evidenceText = (s: { evidence: string[]; factStatuses: string[] }) =>
        s.evidence.length
            ? s.evidence.join(" · ")
            : s.factStatuses.map((v) => label(FACT_STATUS, "factStatus", v)).join(" · ") || "—";

    const download = async () => {
        if (busy) return;
        setBusy(true);
        setFailed(false);
        try {
            const { downloadTableAsXlsx } = await import("./tableXlsx");
            const header = [
                "id", "check", "requirement", "category", "applicability", "status",
                "verification", "weight", "evidence", "action", "owner", "due", "closure",
            ].map((k) => t(`xlsx.${k}`));
            const body = a.findings.map((f) => [
                f.id,
                f.check_id ?? "",
                f.requirement,
                label(CATEGORY, "category", f.category),
                label(APPLICABILITY, "applicability", f.applicability),
                tDot(DOT[f.status]),
                label(VERIFICATION, "verification", f.verification),
                label(WEIGHT, "weight", f.evidence_weight),
                f.evidence.map((e) => `${e.filename ?? e.doc_id}${e.page ? `, ${e.page}` : ""}: „${e.quote}”`).join("\n"),
                f.action ?? "",
                f.owner_role ?? "",
                f.due ?? "",
                f.closure_criterion,
            ]);
            const decisionHeader = [
                "id", "useCase", "topic", "classification", "limitation", "reasoning", "sources", "evidence",
            ].map((k) => t(`decisionsXlsx.${k}`));
            const decisionBody = decisionSteps(a).map((s) => [
                s.decision.id,
                s.decision.use_case_id,
                s.decision.topic,
                s.decision.classification ?? "",
                s.decision.limitation ?? "",
                s.decision.reasoning,
                s.decision.legal_sources.join("\n"),
                evidenceText(s),
            ]);
            await downloadTableAsXlsx(
                [header, ...body],
                {
                    fileName: t("xlsx.fileName", { id: a.assessment_id, version: a.version }),
                    sheetName: t("xlsx.sheetName"),
                },
                decisionBody.length
                    ? [{ sheetName: t("decisionsXlsx.sheetName"), rows: [decisionHeader, ...decisionBody] }]
                    : [],
            );
        } catch (err) {
            console.error("[assessment] Excel export failed:", err);
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <section
            data-slot="assessment-card"
            aria-label={t("heading", { version: a.version })}
            className={cn("rounded-lg border border-border bg-card px-3 py-2.5", className)}
        >
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium uppercase tracking-wider">
                    {t("heading", { version: a.version })}
                </span>
                {a.warning && (
                    <Badge
                        variant="outline"
                        title={t("warningTitle")}
                        className={cn("text-foreground", WARNING_TINT[a.warning])}
                    >
                        {a.warning}
                    </Badge>
                )}
            </div>
            <p className="mt-1 text-sm text-foreground">
                {a.title}
                <span className="text-muted-foreground">
                    {" "}
                    · {a.assessment_id}
                    {a.task_id ? ` · ${a.task_id}` : ""}
                </span>
            </p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground">
                {STATUS_ORDER.map((s) => (
                    <span key={s} className="inline-flex items-center gap-1 tabular-nums">
                        <StatusDot status={DOT[s]} token={TOKEN[s]} />
                        {a.counts[s] ?? 0}
                    </span>
                ))}
                <span className="text-muted-foreground">{t("total", { count: a.total })}</span>
            </p>
            {a.changes && (
                <p className="mt-1 text-xs text-muted-foreground">
                    {t("changes", {
                        from: a.changes.from_version,
                        closed: a.changes.closed.length,
                        added: a.changes.added.length,
                        changed: a.changes.changed.length,
                        superseded: a.changes.superseded.length,
                    })}
                </p>
            )}

            {classified.length > 0 && (
                <div className="mt-2 text-xs">
                    <p className="font-medium text-muted-foreground">{t("classification")}</p>
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                        {classified.map((d) => (
                            <li key={d.id} className="text-foreground">
                                <span className="tabular-nums text-muted-foreground">{d.use_case_id} · </span>
                                <span className="font-medium">{d.classification}</span>
                                {d.limitation && <span className="text-muted-foreground"> · {d.limitation}</span>}
                                <span className="text-muted-foreground"> — {d.topic}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {checker.length > 0 && (
                <div className="mt-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={showChecker}
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={() => setShowChecker((v) => !v)}
                    >
                        {showChecker ? t("checker.hide") : t("checker.show", { count: checker.length })}
                    </Button>
                    {showChecker && (
                        <div className="mt-1 overflow-x-auto">
                            <table className="w-full border-collapse text-left text-xs">
                                <thead className="text-muted-foreground">
                                    <tr className="border-b border-border">
                                        {["question", "answer", "evidence"].map((k) => (
                                            <th key={k} className="px-1.5 py-1 font-medium">
                                                {t(`checker.columns.${k}`)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {checker.map((s) => (
                                        <tr key={s.decision.id} className="align-top text-foreground">
                                            <td className="min-w-32 px-1.5 py-1">
                                                {s.decision.topic}
                                                {s.decisive && (
                                                    <Badge
                                                        variant="outline"
                                                        title={t("checker.decisiveTitle")}
                                                        className="ml-1.5 bg-status-assessment text-foreground"
                                                    >
                                                        {t("checker.decisive")}
                                                    </Badge>
                                                )}
                                            </td>
                                            <td
                                                className="min-w-40 px-1.5 py-1 text-muted-foreground"
                                                title={s.decision.reasoning}
                                            >
                                                {clip(s.decision.reasoning, REASONING_CHARS)}
                                                {s.decision.limitation ? ` · ${s.decision.limitation}` : ""}
                                            </td>
                                            <td className="min-w-32 px-1.5 py-1 text-muted-foreground">
                                                {evidenceText(s)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {a.findings.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                    <table className="w-full border-collapse text-left text-xs">
                        <thead className="text-muted-foreground">
                            <tr className="border-b border-border">
                                {["id", "requirement", "category", "status", "verification", "evidence", "action"].map((k) => (
                                    <th key={k} className="px-1.5 py-1 font-medium">
                                        {t(`columns.${k}`)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {rows.map((f) => (
                                <tr key={f.id} className="align-top text-foreground">
                                    <td className="whitespace-nowrap px-1.5 py-1 tabular-nums">
                                        {f.id}
                                        {f.check_id && (
                                            <span className="block text-muted-foreground">{f.check_id}</span>
                                        )}
                                    </td>
                                    <td className="min-w-40 px-1.5 py-1">{f.requirement}</td>
                                    <td className="px-1.5 py-1 text-muted-foreground">
                                        {label(CATEGORY, "category", f.category)}
                                    </td>
                                    <td className="px-1.5 py-1 text-center">
                                        <StatusDot status={DOT[f.status]} token={TOKEN[f.status]} />
                                    </td>
                                    <td className="px-1.5 py-1 text-muted-foreground">
                                        {label(VERIFICATION, "verification", f.verification)}
                                    </td>
                                    <td className="px-1.5 py-1 text-center tabular-nums">{f.evidence.length}</td>
                                    <td className="min-w-32 px-1.5 py-1 text-muted-foreground">{f.action ?? "—"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {a.findings.length > COLLAPSED_ROWS && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="mt-1 h-7 px-2 text-xs text-muted-foreground"
                            onClick={() => setExpanded((v) => !v)}
                        >
                            {expanded ? t("showLess") : t("showAll", { count: a.findings.length })}
                        </Button>
                    )}
                </div>
            )}

            {(a.unread_documents.length > 0 || a.source_conflicts.length > 0) && (
                <div className="mt-2 flex flex-col gap-1 text-xs text-warning">
                    {[
                        ["unread", a.unread_documents],
                        ["conflicts", a.source_conflicts],
                    ].map(([key, items]) =>
                        (items as string[]).length > 0 ? (
                            <div key={key as string} className="flex items-start gap-1.5">
                                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span>
                                    {t(key as string)}: {(items as string[]).join(" · ")}
                                </span>
                            </div>
                        ) : null,
                    )}
                </div>
            )}

            <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                {failed && (
                    <span role="alert" className="text-xs text-destructive">
                        {tExport("failed")}
                    </span>
                )}
                {(a.findings.length > 0 || a.decisions.length > 0) && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={download}
                        disabled={busy}
                        className="h-7 px-2 text-xs text-muted-foreground"
                    >
                        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileSpreadsheet aria-hidden="true" />}
                        {tExport("download")}
                    </Button>
                )}
                {onContinue && (
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() =>
                            onContinue({
                                workflow: a.workflow ? { ...a.workflow, type: "assistant" } : null,
                                text: t("continuePrefix", { id: a.assessment_id }),
                            })
                        }
                    >
                        <RotateCcw aria-hidden="true" />
                        {t("continue")}
                    </Button>
                )}
            </div>
        </section>
    );
}
