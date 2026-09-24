"use client";

/**
 * Modal that loads /adminmax/chats/:chatId/full and renders every
 * message in chronological order (user → assistant → …) with the
 * per-answer cost rollup. Shared by the user-detail Poruke tab and the
 * global Razgovori page. Long messages can be expanded individually,
 * but the default view truncates to ~3000 chars per bubble so the
 * thread stays scrollable.
 */
import { useEffect, useState } from "react";
import {
    getChatThread,
    type AdminChatThreadMessage,
    type AdminChatThreadResponse,
} from "../lib/adminApi";

function fmtUsd(n: number | null): string {
    if (n == null) return "—";
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
            second: "2-digit",
        });
    } catch {
        return s;
    }
}

/**
 * Best-effort plain-text rendering of an assistant message stored as
 * an AssistantEvent[] array in chat_messages.content. We only extract
 * `text` / `content` fields from `content` and `reasoning` events so
 * the admin sees something readable without rendering markdown.
 */
export function summarizeContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    const parts: string[] = [];
    for (const ev of content as Record<string, unknown>[]) {
        if (typeof ev?.text === "string") parts.push(String(ev.text));
        else if (typeof ev?.content === "string")
            parts.push(String(ev.content));
        else if (ev?.type === "tool_call_start" && typeof ev.name === "string")
            parts.push(`⧗ ${ev.name}`);
        else if (ev?.type === "doc_created" && typeof ev.filename === "string")
            parts.push(`📄 ${ev.filename}`);
    }
    return parts.join("\n");
}

export function ChatThreadModal({
    chatId,
    userId,
    onClose,
}: {
    chatId: string;
    /** Optional ownership cross-check — pass when opened from a
     *  user-scoped context so a stale id can't show someone else's chat. */
    userId?: string;
    onClose: () => void;
}) {
    const [data, setData] = useState<AdminChatThreadResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await getChatThread(chatId, userId);
                if (!cancelled) setData(res);
            } catch (err) {
                if (!cancelled)
                    setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [chatId, userId]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/70 px-4 py-6"
            role="dialog"
            aria-modal="true"
            onClick={onClose}
        >
            <div
                className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 border-b border-border bg-muted px-5 py-3">
                    <div className="min-w-0">
                        <div className="font-serif text-base font-semibold text-foreground">
                            {data?.chat.title ?? "Razgovor"}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                            {chatId}
                            {data?.chat.project_id && (
                                <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] text-accent-foreground">
                                    project
                                </span>
                            )}
                        </div>
                        {data?.user && (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                                {data.user.email}
                                {data.user.display_name && (
                                    <span className="ml-2 text-muted-foreground">
                                        ({data.user.display_name})
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        aria-label="Close"
                    >
                        ✕
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {error && (
                        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {error}
                        </div>
                    )}
                    {loading && (
                        <div className="text-sm text-muted-foreground">
                            Učitavam razgovor…
                        </div>
                    )}
                    {data && data.messages.length === 0 && (
                        <div className="text-sm text-muted-foreground">
                            Razgovor nema poruka.
                        </div>
                    )}
                    <ul className="space-y-3">
                        {data?.messages.map((m) => (
                            <ThreadMessage key={m.id} message={m} />
                        ))}
                    </ul>
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-5 py-2">
                    <span className="text-[11px] text-muted-foreground">
                        {data ? `${data.messages.length} poruka` : ""}
                    </span>
                    {data && (
                        <span className="font-mono text-xs text-foreground">
                            <span className="text-muted-foreground">Ukupno: </span>
                            <span className="text-success">
                                {fmtUsd(data.totals.cost_usd_total)}
                            </span>
                            <span className="ml-2 text-muted-foreground">
                                {fmtInt(data.totals.input_tokens_total)} in /{" "}
                                {fmtInt(data.totals.output_tokens_total)} out
                            </span>
                            {data.totals.error_count > 0 && (
                                <span className="ml-2 text-destructive">
                                    · {data.totals.error_count} grešaka
                                </span>
                            )}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

function ThreadMessage({ message }: { message: AdminChatThreadMessage }) {
    const [expanded, setExpanded] = useState(false);
    const text = summarizeContent(message.content);
    const isLong = text.length > 3000;
    const display = expanded || !isLong ? text : text.slice(0, 3000) + "…";
    const isAssistant = message.role === "assistant";
    return (
        <li
            className={`rounded-md border px-4 py-3 ${
                isAssistant
                    ? "border-success/20 bg-success/10"
                    : "border-border bg-muted"
            }`}
        >
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                    <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                            isAssistant
                                ? "bg-success/20 text-success"
                                : "bg-surface-elevated text-foreground"
                        }`}
                    >
                        {isAssistant ? "Asistent (A)" : "Korisnik (Q)"}
                    </span>
                    <span>{fmtDate(message.created_at)}</span>
                    {message.is_flagged && (
                        <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive">
                            flagged
                        </span>
                    )}
                </div>
                {message.usage && (
                    <div className="flex items-center gap-2 font-mono text-[11px] whitespace-nowrap">
                        <span
                            className={
                                message.usage.had_error
                                    ? "text-destructive"
                                    : "text-success"
                            }
                            title="Trošak ovog odgovora"
                        >
                            {fmtUsd(message.usage.cost_usd)}
                        </span>
                        <span
                            className="text-muted-foreground"
                            title="Input / Output tokeni"
                        >
                            {fmtInt(message.usage.input_tokens)} in /{" "}
                            {fmtInt(message.usage.output_tokens)} out
                        </span>
                        {message.usage.model && (
                            <span className="hidden text-muted-foreground/70 sm:inline">
                                {message.usage.model}
                            </span>
                        )}
                    </div>
                )}
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {display || (
                    <span className="text-muted-foreground">(prazna poruka)</span>
                )}
            </pre>
            {isLong && (
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-2 text-xs font-medium text-success hover:text-success/80"
                >
                    {expanded
                        ? "Skupi"
                        : `Prikaži cijelu poruku (${text.length.toLocaleString("hr-HR")} znakova)`}
                </button>
            )}
        </li>
    );
}
