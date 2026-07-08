"use client";

import { useState } from "react";
import { X } from "lucide-react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    placeholder = "Add by email…",
    autoFocus = false,
}: Props) {
    const [input, setInput] = useState("");
    const [validating, setValidating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function setValidatingState(v: boolean) {
        setValidating(v);
        onValidatingChange?.(v);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addEmail();
        } else if (e.key === "Backspace" && !input && emails.length > 0) {
            onChange(emails.slice(0, -1));
        }
    }

    async function addEmail() {
        const email = input.trim().toLowerCase();
        if (!email) return;
        if (emails.includes(email)) {
            setInput("");
            return;
        }
        if (!EMAIL_RE.test(email)) {
            setError("Enter a valid email address.");
            return;
        }
        if (validate) {
            setValidatingState(true);
            setError(null);
            try {
                const err = await validate(email);
                if (err) {
                    setError(err);
                    return;
                }
            } catch {
                setError("Could not verify email. Try again.");
                return;
            } finally {
                setValidatingState(false);
            }
        }
        onChange([...emails, email]);
        setInput("");
        setError(null);
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
                    onBlur={addEmail}
                    placeholder={emails.length === 0 ? placeholder : ""}
                    className="flex-1 min-w-[160px] bg-transparent text-sm text-foreground placeholder:text-muted-foreground/70 outline-none"
                    autoFocus={autoFocus}
                />
            </div>
            {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
            {validating && <p className="mt-1.5 text-xs text-muted-foreground/70">Checking…</p>}
        </div>
    );
}
