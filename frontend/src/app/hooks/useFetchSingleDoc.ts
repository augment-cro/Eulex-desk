"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { supabase } from "@/lib/supabase";

import { API_BASE } from "@/app/lib/apiBase";
/**
 * /display returns PDF bytes (when the active version has a PDF
 * rendition), the raw text of a plain-text (.txt) document, or raw DOCX
 * bytes otherwise. Reporting the type lets the caller pick PDF.js,
 * TextDocView or DocxView (docx-preview) accordingly.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "text"; text: string }
    | { type: "docx" }
    | null;

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const t = useTranslations("docPanel");
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                const token = session?.access_token;
                if (cancelled) return;

                const apiBase = API_BASE;
                const qs = versionId
                    ? `?version_id=${encodeURIComponent(versionId)}`
                    : "";
                const response = await fetch(
                    `${apiBase}/single-documents/${documentId}/display${qs}`,
                    {
                        headers: token
                            ? { Authorization: `Bearer ${token}` }
                            : {},
                    },
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (cancelled) return;

                const contentType =
                    response.headers.get("content-type") ?? "";
                if (contentType.includes("application/pdf")) {
                    const buffer = await response.arrayBuffer();
                    if (!cancelled) setResult({ type: "pdf", buffer });
                } else if (contentType.includes("text/plain")) {
                    const text = await response.text();
                    if (!cancelled) setResult({ type: "text", text });
                } else {
                    // Drain the body so the connection is reusable, but the
                    // bytes are useless to the PDF viewer — the caller will
                    // fall back to DocxView, which fetches `/docx` itself.
                    await response.arrayBuffer().catch(() => {});
                    if (!cancelled) setResult({ type: "docx" });
                }
            } catch {
                if (!cancelled) setError(t("loadError"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
        // prevKeyRef short-circuits repeat runs, so including `t` cannot
        // re-trigger the fetch.
    }, [documentId, versionId, t]);

    return { result, loading, error };
}
