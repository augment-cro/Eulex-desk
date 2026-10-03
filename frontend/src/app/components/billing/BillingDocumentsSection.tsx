"use client";

/**
 * Account → Billing: the user's quotes (virman) and fiscal invoices, both
 * as the original accounting PDFs. Invoices cover card payments too — the
 * ERP issues them from Stripe — so this is the one place to find every
 * official document. Hidden entirely when no billing provider is configured
 * or the profile's billing country gets no documents (only HR for now).
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    getBillingDocuments,
    type BankTransferQuote,
    type BillingDocuments,
    type FiscalInvoice,
} from "@/app/lib/mikeApi";
import { pdfFilename, saveBillingPdf } from "./billingPdf";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const QUOTE_BADGE: Record<BankTransferQuote["status"], BadgeVariant> = {
    creating: "outline",
    issued: "secondary",
    paid: "default",
    expired: "outline",
    cancelled: "outline",
    failed: "destructive",
};

export function BillingDocumentsSection() {
    const t = useTranslations("bankTransfer.documents");
    const locale = useLocale();
    const [docs, setDocs] = useState<BillingDocuments | null>(null);
    const [failed, setFailed] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [pdfError, setPdfError] = useState(false);

    const load = useCallback(async () => {
        try {
            setDocs(await getBillingDocuments());
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const fmtDate = (iso: string | null) =>
        iso
            ? new Intl.DateTimeFormat(locale === "hr" ? "hr-HR" : "en-GB", { dateStyle: "medium" }).format(
                  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso),
              )
            : "—";
    const fmtMoney = (n: number | null, currency: string | null) =>
        n === null
            ? "—"
            : new Intl.NumberFormat(locale === "hr" ? "hr-HR" : "en-GB", {
                  style: "currency",
                  currency: currency || "EUR",
              }).format(n);

    async function download(kind: "quotes" | "invoices", id: string, filename: string) {
        setBusy(id);
        setPdfError(false);
        try {
            await saveBillingPdf(kind, id, filename);
        } catch {
            setPdfError(true);
        } finally {
            setBusy(null);
        }
    }

    if (failed) {
        return (
            <section className="space-y-2">
                <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
                <p className="text-sm text-destructive">{t("loadFailed")}</p>
            </section>
        );
    }
    if (!docs || !docs.available) return null;

    const quoteStatus = (q: BankTransferQuote) => {
        if (q.status === "issued" && q.provisionalUntil && new Date(q.provisionalUntil) > new Date()) {
            return t("status.issuedProvisional", { date: fmtDate(q.provisionalUntil) });
        }
        if (q.status === "paid") {
            return q.accessUntil
                ? t("status.paidUntil", { date: fmtDate(q.accessUntil) })
                : t("status.paid");
        }
        return t(`status.${q.status}`);
    };

    return (
        <section className="space-y-4">
            <div>
                <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
            </div>
            {pdfError && <p className="text-sm text-destructive">{t("pdfFailed")}</p>}

            {docs.quotes.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-sm font-medium text-foreground">{t("quotes")}</h3>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {docs.quotes.map((q) => (
                            <li key={q.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">
                                        {t("quoteLabel", { number: q.number ?? "—" })} · {q.planName}
                                        {q.seats > 1 ? ` × ${q.seats}` : ""}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {fmtDate(q.createdAt)} · {fmtMoney(q.grossAmount, q.currency)}
                                        {q.status === "issued" && q.validUntil
                                            ? ` · ${t("validUntil", { date: fmtDate(q.validUntil) })}`
                                            : ""}
                                    </div>
                                </div>
                                <Badge variant={QUOTE_BADGE[q.status]}>{quoteStatus(q)}</Badge>
                                {q.canDownload && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={busy === q.id}
                                        onClick={() =>
                                            download("quotes", q.id, pdfFilename("ponuda", q.number, q.id))
                                        }
                                    >
                                        {t("pdf")}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">{t("invoices")}</h3>
                {docs.invoices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("noInvoices")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {docs.invoices.map((inv: FiscalInvoice) => (
                            <li
                                key={inv.documentId}
                                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">
                                        {t("invoiceLabel", { number: inv.number })}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        {fmtDate(inv.date)} · {fmtMoney(inv.amount, inv.currency)}
                                    </div>
                                </div>
                                {inv.paid !== null && (
                                    <Badge variant={inv.paid ? "default" : "secondary"}>
                                        {inv.paid ? t("invoicePaid") : t("invoiceOpen")}
                                    </Badge>
                                )}
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={busy === inv.documentId}
                                    onClick={() =>
                                        download(
                                            "invoices",
                                            inv.documentId,
                                            pdfFilename("racun", inv.number, inv.documentId),
                                        )
                                    }
                                >
                                    {t("pdf")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}
