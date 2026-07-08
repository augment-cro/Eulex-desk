import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
    acceptAllChanges,
    applyEditsWithTracking,
    getRevisionCount,
    getTrackChangesMode,
    rejectAllChanges,
    setTrackChangesMode,
    type EditProposal,
    type TrackChangesMode,
} from "../hooks/useWordDoc";
import { useTranslation } from "../i18n/I18nProvider";

export default function TrackChangesPanel() {
    const [mode, setMode] = useState<TrackChangesMode>("off");
    const [revCount, setRevCount] = useState<number | null>(null);
    const [status, setStatus] = useState("");
    const [busy, setBusy] = useState(false);

    const [findText, setFindText] = useState("");
    const [replaceText, setReplaceText] = useState("");
    const [reason, setReason] = useState("");

    const t = useTranslation();

    const toast = useCallback((msg: string) => {
        setStatus(msg);
        setTimeout(() => setStatus(""), 3000);
    }, []);

    // Refresh state from Word on demand. We deliberately do NOT run this
    // on a recurring interval — `Word.run + context.sync()` every couple
    // of seconds was triggering Word-for-Mac's ribbon Style Gallery to
    // flicker visibly while the taskpane was open. Instead we refresh:
    //   - once on mount,
    //   - after any mutation we cause (set mode, accept, reject, apply),
    //   - when the user clicks the small refresh icon next to the badge.
    const refresh = useCallback(() => {
        getTrackChangesMode().then(setMode).catch(() => {});
        getRevisionCount().then(setRevCount).catch(() => {});
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const handleSetMode = async (m: TrackChangesMode) => {
        try {
            await setTrackChangesMode(m);
            setMode(m);
            toast(
                m === "off"
                    ? t("track.modeOff")
                    : m === "all"
                      ? t("track.modeAll")
                      : t("track.modeMine"),
            );
        } catch (e) {
            toast(`${t("common.error")}: ${(e as Error).message}`);
        }
    };

    const handleAcceptAll = async () => {
        setBusy(true);
        const result = await acceptAllChanges();
        setBusy(false);
        if (result.fallback) {
            toast(t("errors.operationFailed"));
        } else if (result.ok) {
            toast(t("track.applied", { count: result.count }));
            refresh();
        }
    };

    const handleRejectAll = async () => {
        setBusy(true);
        const result = await rejectAllChanges();
        setBusy(false);
        if (result.fallback) {
            toast(t("errors.operationFailed"));
        } else if (result.ok) {
            toast(t("track.rejected", { count: result.count }));
            refresh();
        }
    };

    const handleApplyEdit = async () => {
        if (!findText) return;
        const edits: EditProposal[] = [
            {
                find: findText,
                replace: replaceText,
                reason: reason || undefined,
            },
        ];
        setBusy(true);
        try {
            const { applied, notFound } = await applyEditsWithTracking(edits);
            if (applied > 0) {
                toast(t("track.applied", { count: applied }));
                setFindText("");
                setReplaceText("");
                setReason("");
                refresh();
            } else {
                toast(`"${notFound[0]}" — ${t("errors.operationFailed")}`);
            }
        } catch (e) {
            toast(`${t("common.error")}: ${(e as Error).message}`);
        } finally {
            setBusy(false);
        }
    };

    const MODE_LABELS: Record<TrackChangesMode, string> = {
        off: t("track.modeOff"),
        all: t("track.modeAll"),
        mine: t("track.modeMine"),
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto p-2 space-y-4">
            <div>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    {t("track.mode")}
                </p>
                <div className="flex gap-1">
                    {(["off", "all", "mine"] as TrackChangesMode[]).map((m) => (
                        <button
                            key={m}
                            onClick={() => handleSetMode(m)}
                            className={`flex-1 py-1.5 text-xs rounded-lg transition-colors font-medium ${
                                mode === m
                                    ? "bg-mike-500 text-white"
                                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                            }`}
                        >
                            {MODE_LABELS[m]}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
                        {t("track.title")}
                    </p>
                    <div className="flex items-center gap-1.5">
                        {revCount !== null && (
                            <span
                                className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
                                    revCount > 0
                                        ? "bg-orange-100 text-orange-700"
                                        : "bg-gray-100 text-gray-500"
                                }`}
                            >
                                {revCount}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={refresh}
                            className="text-gray-400 hover:text-gray-700"
                            title={t("common.retry")}
                        >
                            <RefreshCw className="h-3 w-3" />
                        </button>
                    </div>
                </div>

                <div className="flex gap-1.5">
                    <button
                        onClick={handleAcceptAll}
                        disabled={busy}
                        className="flex-1 py-1.5 text-xs bg-green-100 text-green-700 hover:bg-green-200 rounded-lg font-medium transition-colors disabled:opacity-40"
                    >
                        ✓ {t("track.acceptAll")}
                    </button>
                    <button
                        onClick={handleRejectAll}
                        disabled={busy}
                        className="flex-1 py-1.5 text-xs bg-red-100 text-red-700 hover:bg-red-200 rounded-lg font-medium transition-colors disabled:opacity-40"
                    >
                        ✗ {t("track.rejectAll")}
                    </button>
                </div>
            </div>

            <div>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    {t("chat.trackChanges")}
                </p>
                <div className="space-y-1.5">
                    <input
                        type="text"
                        value={findText}
                        onChange={(e) => setFindText(e.target.value)}
                        placeholder={t("common.search")}
                        className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-mike-500"
                    />
                    <input
                        type="text"
                        value={replaceText}
                        onChange={(e) => setReplaceText(e.target.value)}
                        placeholder="…"
                        className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-mike-500"
                    />
                    <input
                        type="text"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder=""
                        className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-mike-500"
                    />
                    <button
                        onClick={handleApplyEdit}
                        disabled={!findText || busy}
                        className="w-full py-1.5 text-xs bg-mike-500 text-white rounded-lg hover:bg-mike-600 disabled:opacity-40 transition-colors font-medium"
                    >
                        {busy ? t("common.loading") : t("chat.trackChanges")}
                    </button>
                </div>
            </div>

            {status && (
                <p className="text-xs text-center text-gray-500 bg-gray-50 rounded py-1.5 border border-gray-100">
                    {status}
                </p>
            )}
        </div>
    );
}
