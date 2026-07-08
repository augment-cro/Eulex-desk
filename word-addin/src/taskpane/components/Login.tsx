import React, { useCallback, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import MikeLogo from "./MikeLogo";
import { useTranslation } from "../i18n/I18nProvider";
import {
    getTaskpaneOrigin,
    openInDefaultBrowser,
} from "../lib/officeUi";

const FRONTEND_PAIR_HINT_PATH = "/account/word";

function getPairHintUrl(): string {
    return `${getTaskpaneOrigin()}${FRONTEND_PAIR_HINT_PATH}`;
}

/**
 * Pairing-code login screen for the Word add-in.
 *
 * The user generates a 6-digit code on the Eulex Desk web frontend and types it
 * here. We deliberately do NOT offer a username/password fallback — the
 * Eulex Desk OAuth provider (eulex.ai WordPress) is the single source of truth
 * for account state, and the pairing flow funnels every add-in session
 * through a token that's already been issued to a valid web session.
 */
export default function Login() {
    const { pairWithCode } = useAuth();
    const [digits, setDigits] = useState<string[]>(() => Array(6).fill(""));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputs = useRef<(HTMLInputElement | null)[]>([]);
    const t = useTranslation();

    const setDigitAt = useCallback(
        (idx: number, value: string) => {
            const onlyDigit = value.replace(/\D/g, "").slice(0, 1);
            setDigits((prev) => {
                const next = [...prev];
                next[idx] = onlyDigit;
                return next;
            });
            if (onlyDigit && idx < 5) {
                inputs.current[idx + 1]?.focus();
            }
        },
        [],
    );

    const handlePaste = useCallback(
        (e: React.ClipboardEvent<HTMLInputElement>) => {
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
            if (pasted.length === 0) return;
            e.preventDefault();
            const next = Array(6).fill("");
            for (let i = 0; i < Math.min(6, pasted.length); i++) {
                next[i] = pasted[i];
            }
            setDigits(next);
            const focusIdx = Math.min(5, pasted.length);
            inputs.current[focusIdx]?.focus();
        },
        [],
    );

    const handleKeyDown = useCallback(
        (idx: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Backspace" && !digits[idx] && idx > 0) {
                inputs.current[idx - 1]?.focus();
            }
        },
        [digits],
    );

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();
            const code = digits.join("");
            if (code.length !== 6) {
                setError(t("login.invalidCode"));
                return;
            }
            setSubmitting(true);
            setError(null);
            try {
                await pairWithCode(code);
            } catch (err) {
                setError(
                    err instanceof Error
                        ? err.message
                        : t("login.genericError"),
                );
                setDigits(Array(6).fill(""));
                inputs.current[0]?.focus();
            } finally {
                setSubmitting(false);
            }
        },
        [digits, pairWithCode, t],
    );

    return (
        <div className="flex flex-col items-center justify-center min-h-screen px-6 py-10 bg-white">
            <div className="w-full max-w-sm space-y-6">
                <div className="flex flex-col items-center text-center space-y-3">
                    <MikeLogo size={48} />
                    <h1 className="text-2xl font-medium font-serif">
                        {t("login.connectTitle")}
                    </h1>
                    <p className="text-sm text-gray-500">
                        {t("login.connectIntro")}
                    </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="flex justify-between gap-2">
                        {digits.map((d, idx) => (
                            <input
                                key={idx}
                                ref={(el) => {
                                    inputs.current[idx] = el;
                                }}
                                type="text"
                                inputMode="numeric"
                                pattern="\d*"
                                maxLength={1}
                                value={d}
                                onChange={(e) =>
                                    setDigitAt(idx, e.target.value)
                                }
                                onPaste={handlePaste}
                                onKeyDown={handleKeyDown(idx)}
                                className="w-10 h-12 text-center text-xl font-mono font-medium border border-gray-300 rounded-md focus:border-mike-500 focus:outline-none focus:ring-2 focus:ring-mike-200"
                                disabled={submitting}
                                autoFocus={idx === 0}
                            />
                        ))}
                    </div>

                    {error ? (
                        <p className="text-sm text-red-600 text-center">
                            {error}
                        </p>
                    ) : null}

                    <button
                        type="submit"
                        disabled={submitting || digits.join("").length !== 6}
                        className="w-full py-2.5 bg-black text-white rounded-md text-sm font-medium hover:bg-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {submitting ? t("login.connecting") : t("login.connect")}
                    </button>
                </form>

                <p className="text-xs text-gray-400 text-center">
                    {t("login.openMike")} →{" "}
                    <a
                        href={getPairHintUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => {
                            e.preventDefault();
                            openInDefaultBrowser(getPairHintUrl());
                        }}
                        className="bg-gray-100 px-1.5 py-0.5 rounded hover:bg-gray-200 hover:text-gray-700 transition-colors cursor-pointer underline-offset-2 hover:underline"
                    >
                        {FRONTEND_PAIR_HINT_PATH}
                    </a>
                </p>
            </div>
        </div>
    );
}
