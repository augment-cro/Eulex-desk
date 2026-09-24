"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Delimiters between addresses: comma, semicolon, any whitespace/newlines.
const SPLIT_RE = /[,;\s]+/;

interface Props {
    emails: string[];
    onChange: (emails: string[]) => void;
    validate?: (email: string) => Promise<string | null>;
    onValidatingChange?: (validating: boolean) => void;
    placeholder?: string;
    autoFocus?: boolean;
}

export function EmailPillInput({
    emails,
    onChange,
    validate,
    onValidatingChange,
    placeholder,
    autoFocus = false,
}: Props) {
    const t = useTranslations("emailPillInput");
    const [input, setInput] = useState("");
    const [validating, setValidating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function setValidatingState(v: boolean) {
        setValidating(v);
        onValidatingChange?.(v);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            void addEmails(input);
        } else if (e.key === "Backspace" && !input && emails.length > 0) {
            onChange(emails.slice(0, -1));
        }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
        const text = e.clipboardData.getData("text");
        // Only take over when the paste contains delimiters (multiple
        // addresses); a plain fragment keeps native paste behaviour.
        if (SPLIT_RE.test(text)) {
            e.preventDefault();
            void addEmails(`${input} ${text}`);
        }
    }

    /**
     * Split `raw` on commas/semicolons/whitespace, dedupe (case-insensitive,
     * incl. against existing pills), validate each token, and add all valid
     * ones. Invalid tokens stay in the input with the error shown.
     */
    async function addEmails(raw: string) {
        const seen = new Set(emails.map((e) => e.toLowerCase()));
        const candidates: string[] = [];
        const rejected: string[] = [];
        let firstError: string | null = null;

        for (const token of raw.split(SPLIT_RE)) {
            const email = token.trim().toLowerCase();
            if (!email) continue;
            if (seen.has(email)) continue; // duplicate — silently skipped
            if (!EMAIL_RE.test(email)) {
                rejected.push(token.trim());
                continue;
            }
            seen.add(email);
            candidates.push(email);
        }

        const accepted: string[] = [];
        if (validate && candidates.length > 0) {
            setValidatingState(true);
            setError(null);
            try {
                for (const email of candidates) {
                    try {
                        const err = await validate(email);
                        if (err) {
                            rejected.push(email);
                            firstError ??= err;
                        } else {
                            accepted.push(email);
                        }
                    } catch {
                        rejected.push(email);
                        firstError ??= t("verifyFailed");
                    }
                }
            } finally {
                setValidatingState(false);
            }
        } else {
            accepted.push(...candidates);
        }

        if (accepted.length > 0) onChange([...emails, ...accepted]);
        if (rejected.length > 0) {
            setInput(rejected.join(", "));
            setError(firstError ?? t("invalidEmail"));
        } else {
            setInput("");
            setError(null);
        }
    }

    return (
        <div>
            <div
                className={`flex flex-wrap gap-1.5 rounded-lg border bg-surface-elevated px-3 py-2 min-h-[40px] transition-colors ${
                    error
                        ? "border-destructive focus-within:border-destructive"
                        : "border-input focus-within:border-ring"
                }`}
            >
                {emails.map((email) => (
                    <span
                        key={email}
                        className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-foreground"
                    >
                        {email}
                        <button
                            type="button"
                            onClick={() => onChange(emails.filter((e) => e !== email))}
                            className="text-muted-foreground/70 hover:text-foreground transition-colors"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </span>
                ))}
                <input
                    type="email"
                    value={input}
                    onChange={(e) => {
                        setInput(e.target.value);
                        setError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onBlur={() => void addEmails(input)}
                    placeholder={emails.length === 0 ? (placeholder ?? t("placeholder")) : ""}
                    className="flex-1 min-w-[160px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                    autoFocus={autoFocus}
                />
            </div>
            {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
            {validating && <p className="mt-1.5 text-xs text-muted-foreground/70">{t("checking")}</p>}
        </div>
    );
}
