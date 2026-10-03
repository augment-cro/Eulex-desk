"use client";

/**
 * "Virman – pošalji mi ponudu": the bank-transfer branch of the plan
 * checkout. Collects the company block (all fields mandatory — they go on
 * the quote and later the invoice), asks the backend to issue the quote
 * with the billing provider, and shows what happens next. The provider e-mails the quote
 * with the payment barcode; the PDF is also downloadable here.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
    BillingApiError,
    requestBankTransferQuote,
    type BankTransferCompany,
    type BankTransferConfig,
    type BankTransferQuote,
} from "@/app/lib/mikeApi";
import { refreshRateLimitStatus } from "@/app/hooks/useRateLimitStatus";
import { pdfFilename, saveBillingPdf } from "./billingPdf";

type FieldKey = keyof BankTransferCompany;

const FIELDS: { key: FieldKey; autoComplete: string; inputMode?: "numeric" }[] = [
    { key: "name", autoComplete: "organization" },
    { key: "oib", autoComplete: "off", inputMode: "numeric" },
    { key: "street", autoComplete: "address-line1" },
    { key: "postalCode", autoComplete: "postal-code", inputMode: "numeric" },
    { key: "city", autoComplete: "address-level2" },
];

/** Backend validation codes → the field they point at. */
const CODE_FIELD: Record<string, FieldKey> = {
    ORGANISATION_REQUIRED: "name",
    OIB_REQUIRED: "oib",
    OIB_INVALID: "oib",
    ADDRESS_REQUIRED: "street",
    POSTAL_CODE_REQUIRED: "postalCode",
    CITY_REQUIRED: "city",
};

const KNOWN_ERRORS = new Set([
    ...Object.keys(CODE_FIELD),
    "STRIPE_SUBSCRIPTION_ACTIVE",
    "COUNTRY_UNSUPPORTED",
    "QUOTE_IN_PROGRESS",
    "QUOTE_LIMIT",
    "BANK_TRANSFER_DISABLED",
    "BANK_TRANSFER_NOT_READY",
    "EMAIL_INVALID",
    "PLAN_INVALID",
]);

/** Client-side mirror of the backend check (OIB, ISO 7064 MOD 11,10). */
function oibValid(raw: string): boolean {
    const oib = raw.replace(/[\s.-]/g, "").toUpperCase().replace(/^HR/, "");
    if (!/^\d{11}$/.test(oib)) return false;
    let a = 10;
    for (let i = 0; i < 10; i++) {
        a = (a + Number(oib[i])) % 10;
        if (a === 0) a = 10;
        a = (a * 2) % 11;
    }
    return (11 - a) % 10 === Number(oib[10]);
}

function firstInvalid(c: BankTransferCompany): FieldKey | null {
    if (!c.name.trim()) return "name";
    if (!oibValid(c.oib)) return "oib";
    if (!c.street.trim()) return "street";
    if (!/^\d{5}$/.test(c.postalCode.replace(/\s/g, ""))) return "postalCode";
    if (!c.city.trim()) return "city";
    return null;
}

export function BankTransferQuotePanel({
    plan,
    planName,
    seats,
    config,
    onBack,
    onDone,
}: {
    plan: string;
    planName: string;
    seats?: number;
    config: BankTransferConfig;
    onBack: () => void;
    /** Closes the flow; gets the issued quote (null if none was made). */
    onDone: (quote: BankTransferQuote | null) => void;
}) {
    const t = useTranslations("bankTransfer");
    const locale = useLocale();
    const [company, setCompany] = useState<BankTransferCompany>({
        name: config.company?.name ?? "",
        oib: config.company?.oib ?? "",
        street: config.company?.street ?? "",
        postalCode: config.company?.postalCode ?? "",
        city: config.company?.city ?? "",
    });
    const [touched, setTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<{ code: string | null; field: FieldKey | null } | null>(null);
    const [quote, setQuote] = useState<BankTransferQuote | null>(null);
    const [pdfError, setPdfError] = useState(false);

    const fmtDate = (iso: string | null) =>
        iso
            ? new Intl.DateTimeFormat(locale === "hr" ? "hr-HR" : "en-GB", { dateStyle: "long" }).format(
                  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso),
              )
            : "—";
    const fmtEur = (n: number) =>
        new Intl.NumberFormat(locale === "hr" ? "hr-HR" : "en-GB", {
            style: "currency",
            currency: "EUR",
        }).format(n);

    const invalid = touched ? firstInvalid(company) : null;
    const provisionalDays = config.provisionalDays ?? 0;

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setTouched(true);
        setError(null);
        if (firstInvalid(company)) return;
        setSubmitting(true);
        try {
            const res = await requestBankTransferQuote({ plan, seats, company });
            setQuote(res.quote);
            if (res.quote.provisionalUntil) {
                await refreshRateLimitStatus().catch(() => undefined);
            }
        } catch (err) {
            const code = err instanceof BillingApiError ? err.code : null;
            setError({ code, field: code ? CODE_FIELD[code] ?? null : null });
        } finally {
            setSubmitting(false);
        }
    }

    async function downloadPdf() {
        if (!quote) return;
        setPdfError(false);
        try {
            await saveBillingPdf("quotes", quote.id, pdfFilename("ponuda", quote.number, quote.id));
        } catch {
            setPdfError(true);
        }
    }

    if (quote) {
        return (
            <div className="mt-4 space-y-3 rounded-lg border border-border bg-accent p-4 text-sm text-foreground">
                <p className="font-medium">
                    {quote.emailStatus === "sent"
                        ? t("sent", { number: quote.number ?? "", email: quote.recipientEmail })
                        : t("issuedNotSent", { number: quote.number ?? "" })}
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t("amountDue")}</dt>
                    <dd className="font-medium">{fmtEur(quote.grossAmount)}</dd>
                    <dt className="text-muted-foreground">{t("validUntil")}</dt>
                    <dd>{fmtDate(quote.validUntil)}</dd>
                    {quote.paymentReference && (
                        <>
                            <dt className="text-muted-foreground">{t("reference")}</dt>
                            <dd className="font-mono">{quote.paymentReference}</dd>
                        </>
                    )}
                </dl>
                <p className="text-muted-foreground">
                    {quote.provisionalUntil
                        ? t("provisionalActive", {
                              plan: planName,
                              date: fmtDate(quote.provisionalUntil),
                          })
                        : t("activatesOnPayment", { plan: planName })}
                </p>
                <p className="text-muted-foreground">{t("payHint")}</p>
                {pdfError && <p className="text-destructive">{t("pdfFailed")}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                    {quote.canDownload && (
                        <Button type="button" variant="outline" onClick={downloadPdf}>
                            {t("downloadPdf")}
                        </Button>
                    )}
                    <Button type="button" onClick={() => onDone(quote)}>
                        {t("close")}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <form className="mt-4 space-y-3 rounded-lg border border-border p-3" onSubmit={submit} noValidate>
            <p className="text-sm font-medium text-foreground">{t("companyTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("companyHint")}</p>
            {FIELDS.map((f) => {
                const id = `bank-transfer-${f.key}`;
                const bad = invalid === f.key || error?.field === f.key;
                return (
                    <div key={f.key}>
                        <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
                            {t(`fields.${f.key}`)} *
                        </label>
                        <Input
                            id={id}
                            value={company[f.key]}
                            autoComplete={f.autoComplete}
                            inputMode={f.inputMode}
                            aria-invalid={bad || undefined}
                            className={cn(bad && "border-destructive")}
                            onChange={(e) => setCompany((c) => ({ ...c, [f.key]: e.target.value }))}
                        />
                        {bad && (
                            <p className="mt-1 text-xs text-destructive">{t(`fieldErrors.${f.key}`)}</p>
                        )}
                    </div>
                );
            })}
            <div className="space-y-1 rounded-md bg-accent p-3 text-xs text-muted-foreground">
                <p>
                    {t("howItWorks", {
                        email: config.email ?? "",
                        days: config.validDays ?? 0,
                    })}
                </p>
                <p>
                    {provisionalDays > 0
                        ? t("provisionalPromise", { plan: planName, days: provisionalDays })
                        : t("activatesOnPayment", { plan: planName })}
                </p>
            </div>
            {error && !error.field && (
                <p className="text-sm text-destructive">
                    {error.code && KNOWN_ERRORS.has(error.code) ? t(`errors.${error.code}`) : t("errors.generic")}
                </p>
            )}
            <div className="flex flex-wrap justify-between gap-2">
                <Button type="button" variant="ghost" onClick={onBack} disabled={submitting}>
                    {t("back")}
                </Button>
                <Button type="submit" disabled={submitting}>
                    {submitting ? t("submitting") : t("submit")}
                </Button>
            </div>
        </form>
    );
}
