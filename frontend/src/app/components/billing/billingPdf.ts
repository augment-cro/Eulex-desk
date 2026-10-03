import { downloadBillingDocumentPdf } from "@/app/lib/mikeApi";

/** Fetch one of my quote/invoice PDFs and hand it to the browser as a file. */
export async function saveBillingPdf(
    kind: "quotes" | "invoices",
    id: string,
    filename: string,
): Promise<void> {
    const blob = await downloadBillingDocumentPdf(kind, id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pdfFilename(prefix: string, number: string | null, fallback: string): string {
    return `${prefix}-${(number ?? fallback).replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`;
}
