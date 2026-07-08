"use client";

import dynamic from "next/dynamic";
import {
    Eye,
    FilePenLine,
    GripVertical,
    MessageSquareText,
    Pencil,
    Save,
    X,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { MikeIcon } from "@/components/chat/mike-icon";
import { invalidateDocxBytes, useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import {
    listDocumentEdits,
    resolveDocumentEdit,
    uploadDocumentVersion,
    type MikeDocumentEditRow,
} from "@/app/lib/mikeApi";
import { track } from "@/app/lib/analytics";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { SuperDocInstance, SuperDocReadyEvent } from "@superdoc-dev/react";
import type { CitationQuote } from "./types";
import "@superdoc-dev/react/style.css";
import { DraftSelectionPopup } from "./DraftSelectionPopup";
import { useDraftMode } from "@/app/hooks/useDraftMode";
import type { DraftSelectionEditResult } from "@/app/lib/mikeApi";

type DocumentMode = "viewing" | "editing";

type TrackChangeItem = {
    id: string;
    type: string;
    author?: string;
    excerpt?: string;
    /** Word w:id-ovi koje SuperDoc emitira za insert/delete dio promjene. */
    insertWId?: string | null;
    deleteWId?: string | null;
    /** Story lokacija iz Document API-ja — potrebna za `decide()` target
     *  kod promjena izvan body story-ja (header/footer/tablice). */
    story?: { kind: string; storyType: string } | null;
    /** Postavljeno ako je promjena mapirana na pending document_edits red
     *  (LLM-generirana). Bubble accept/reject tada ide kroz backend rutu
     *  umjesto lokalnog editor.doc.trackChanges.decide(). */
    dbEditId?: string | null;
};

const MODE_LABELS: Record<DocumentMode, string> = {
    viewing: "Pregled",
    editing: "Uređivanje",
};

const MODE_ICONS: Record<DocumentMode, typeof Eye> = {
    viewing: Eye,
    editing: Pencil,
};

const SuperDocEditor = dynamic(
    () => import("@superdoc-dev/react").then((m) => m.SuperDocEditor),
    { ssr: false },
);

export function isSuperDocEnabled(): boolean {
    const v = process.env.NEXT_PUBLIC_USE_SUPERDOC?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}

interface Props {
    documentId: string;
    versionId?: string | null;
    onReady?: () => void;
    highlightEdit?: {
        key: string;
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    } | null;
    refetchKey?: number;
    quotes?: CitationQuote[];
    warning?: string | null;
    onWarningDismiss?: () => void;
    initialScrollTop?: number | null;
    onScrollChange?: (scrollTop: number) => void;
    /**
     * Pozvano nakon uspješnog "Spremi" / auto-save-a, s ID-jem upravo
     * kreirane verzije. Parent (tab vlasnik) treba prebaciti svoj
     * `versionId` na ovu novu verziju — inače reload učita BAŠ staru,
     * prikvačenu verziju i izgleda kao da promjene nisu spremljene
     * (vidi SUPERDOC_SAVE_BUG, Bug 1). Kad prop nije proslijeđen,
     * fallback je lokalni refetchKey bump (svjež GET trenutne verzije).
     */
    onSaved?: (args: {
        versionId: string;
        versionNumber: number | null;
    }) => void;
    rounded?: boolean;
    bordered?: boolean;
    /**
     * Aktivira Draft Mode selekcijsko sučelje unutar SuperDoc preglednika.
     * Kad je true, selektiranje teksta u dokumentu prikazuje DraftSelectionPopup.
     */
    draftModeEnabled?: boolean;
    /**
     * Poziva se nakon što Draft Mode edit uspješno preslikava novu verziju
     * dokumenta na backend — parent treba bumparse refetchKey ili versionId.
     */
    onDraftEditApplied?: (result: DraftSelectionEditResult) => void;
}

type HighlightEdit = NonNullable<Props["highlightEdit"]>;

function findTrackChangeEntityId(
    superdoc: SuperDocInstance,
    edit: HighlightEdit,
): string | null {
    const editor = superdoc.activeEditor;
    if (!editor?.doc?.trackChanges) return null;

    const { items } = editor.doc.trackChanges.list();
    for (const item of items) {
        const wIds = item.wordRevisionIds;
        if (!wIds) continue;
        if (edit.ins_w_id && wIds.insert === edit.ins_w_id) return item.id;
        if (edit.del_w_id && wIds.delete === edit.del_w_id) return item.id;
    }
    return null;
}

async function scrollToHighlightEdit(
    superdoc: SuperDocInstance,
    edit: HighlightEdit,
): Promise<void> {
    const entityId = findTrackChangeEntityId(superdoc, edit);
    if (!entityId) return;
    await superdoc.scrollToElement(entityId);
}

// ── Citation highlighting (SuperDoc native search) ─────────────────────────
//
// SuperDoc renders its own ProseMirror editor, so the DOM-walking quote
// highlighter used by docx-preview/PDF.js doesn't apply. Instead we drive the
// editor's built-in search: `commands.search(pattern, { highlight: true })`
// decorates every match, and `goToSearchResult` scrolls to the first one.

type SuperDocSearchMatch = { id: string; from: number; to: number; text: string };
interface SuperDocSearchCommands {
    search?: (
        pattern: string | RegExp,
        options?: { highlight?: boolean; caseSensitive?: boolean; maxMatches?: number },
    ) => SuperDocSearchMatch[];
    goToSearchResult?: (m: SuperDocSearchMatch) => boolean;
    clearSearch?: () => boolean;
}

/**
 * Build a whitespace-tolerant alternation regex from citation quotes so ONE
 * `search` call highlights every cited passage. Each quote is split on the
 * `[[PAGE_BREAK]]` sentinel + ellipsis; the longest (most distinctive) segment
 * is escaped, with whitespace runs relaxed to `\s+` because the document's text
 * wraps/spaces differ from the model's quote. Returns null when nothing usable.
 */
function buildCitationSearchRegex(
    quotes: CitationQuote[] | undefined,
): RegExp | null {
    if (!quotes || quotes.length === 0) return null;
    const parts: string[] = [];
    for (const q of quotes) {
        const longest = q.quote
            .split(/\[\[PAGE_BREAK\]\]/i)
            .flatMap((s) => s.split(/…|\.\.\./))
            .map((s) => s.trim())
            .filter((s) => s.length >= 12)
            .sort((a, b) => b.length - a.length)[0];
        if (!longest) continue;
        parts.push(
            longest
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\s+/g, "\\s+"),
        );
    }
    return parts.length > 0 ? new RegExp(parts.join("|"), "gi") : null;
}

function highlightCitationsInSuperDoc(
    superdoc: SuperDocInstance | null,
    quotes: CitationQuote[] | undefined,
): void {
    const commands = (
        superdoc?.activeEditor as unknown as {
            commands?: SuperDocSearchCommands;
        } | null
    )?.commands;
    if (!commands?.search) return;
    try {
        commands.clearSearch?.();
        const regex = buildCitationSearchRegex(quotes);
        if (!regex) return;
        const matches = commands.search(regex, {
            highlight: true,
            caseSensitive: false,
        });
        if (matches && matches.length > 0) commands.goToSearchResult?.(matches[0]);
    } catch (err) {
        console.warn("[SuperDocView] citation highlight failed", err);
    }
}

function findScrollElement(root: HTMLElement | null): HTMLElement | null {
    if (!root) return null;
    if (root.scrollHeight > root.clientHeight) return root;
    for (const el of Array.from(root.querySelectorAll("*"))) {
        const node = el as HTMLElement;
        if (node.scrollHeight > node.clientHeight) return node;
    }
    return root;
}

/**
 * SuperDoc-based DOCX viewer (Faza 1). Drop-in replacement for DocxView
 * with native pagination and tracked-changes rendering.
 */
export function SuperDocView({
    documentId,
    versionId,
    onReady,
    highlightEdit,
    quotes,
    refetchKey,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
    onSaved,
    rounded = true,
    bordered = true,
    draftModeEnabled = false,
    onDraftEditApplied,
}: Props) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const superdocRef = useRef<SuperDocInstance | null>(null);
    const scrollCleanupRef = useRef<(() => void) | null>(null);
    const onReadyRef = useRef(onReady);
    const highlightEditRef = useRef(highlightEdit);
    const quotesRef = useRef(quotes);
    useEffect(() => {
        quotesRef.current = quotes;
    }, [quotes]);
    const initialScrollTopRef = useRef<number | null>(
        initialScrollTop ?? null,
    );
    const onScrollChangeRef = useRef(onScrollChange);
    // SuperDoc-ov mount + parsing + font load traje 1-3s nakon što docx
    // bytes stignu. Bez ovoga overlay spinnera korisnik vidi prazan sivi
    // panel dok se SuperDoc inicijalizira (vidljivo iz multipleih
    // [useFetchDocxBytes]/[SuperDocView] logova prije "Editor ready").
    const [editorReady, setEditorReady] = useState(false);
    // Ref kopija `editorReady` flag-a — koristi se u callback-ovima koje
    // SuperDoc internally zove TIJEKOM `broadcastEditorCreate` chain-a,
    // prije nego što naš `handleReady` setira state. Ref vidi najsvježiju
    // vrijednost trenutno (state je još `false` jer setEditorReady čeka
    // sljedeći React commit), pa rano izlazimo iz refresh-a / update-a
    // umjesto da takno SuperDoc-ov throwing `editor.doc` getter.
    const editorReadyRef = useRef(false);
    useEffect(() => {
        editorReadyRef.current = editorReady;
    }, [editorReady]);

    // Faza 2.0: mode switch + save flow. `viewing` ostaje default — sav
    // dosadašnji flow (LLM accept/reject preko chata) ne mijenja se.
    // `suggesting` = korisnikov unos postaje tracked change s autorom =
    // trenutni user; `editing` = direktan unos bez tragova. Save export-a
    // DOCX blob iz SuperDoc-a i kreira novu verziju preko postojeće
    // `uploadDocumentVersion` rute (source: 'user_upload' — sufficient
    // dok ne dodamo poseban `user_edit` enum value).
    const [documentMode, setDocumentMode] = useState<DocumentMode>("viewing");
    const [isDirty, setIsDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    // Greška PARSIRANJA dokumenta (SuperDoc `onContentError`) — odvojeno
    // od fetch greške (`error` iz useFetchDocxBytes) i runtime exceptiona
    // (`onException`). Bez ovoga korumpirani DOCX znači da `onReady`
    // nikad ne okine pa korisnik gleda vječni spinner.
    const [contentError, setContentError] = useState<string | null>(null);
    // Auto-save: vrijeme posljednjeg uspješnog upload-a (epoch ms).
    // Koristi se za "Spremljeno · prije Ns" badge u toolbar-u. Reset-a
    // se na null pri promjeni dokumenta da statusna poruka iz prethodne
    // sesije ne curi u novi tab.
    const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
    // Lokalni refetchKey: fallback reload kad NEMA `onSaved` propa (npr.
    // standalone upotreba bez tab-vlasnika). Kad `onSaved` postoji, parent
    // mijenja `versionId` na novu verziju pa reload ide preko nje (Bug 1).
    const [localRefetchKey, setLocalRefetchKey] = useState(0);
    // ID verzije koju smo upravo spremili (postavlja se u handleSave prije
    // nego što `onSaved` propagira novi versionId odozgo). Koristi ga
    // `lastSavedAt` reset-effect da NE obriše "Spremljeno · prije Ns" badge
    // kad se versionId promijeni baš zbog našeg spremanja — bez ovoga bi
    // badge nestao istog trena (versionId je u dep array-u tog effecta).
    const justSavedVersionIdRef = useRef<string | null>(null);

    // Pomični panel s tracked changes (zamjena za native sidebar).
    const [trackChanges, setTrackChanges] = useState<TrackChangeItem[]>([]);
    const [panelOpen, setPanelOpen] = useState(false);

    // SuperDoc user — bez ovog se svaka korisnička izmjena pripisuje
    // "Default SuperDoc user" što je vidljivo u bubble panelu i u DOCX
    // metapodacima (w:author). Dohvaćamo iz aktivne Supabase sesije
    // (cached u localStorage, tipično <50ms), pa SuperDocEditor čeka
    // render dok korisnik nije resolved — sprječavamo da prve tipke
    // odu pod "Default" autorom.
    const [superdocUser, setSuperdocUser] = useState<{
        name: string;
        email: string;
    } | null>(null);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession();
                if (cancelled) return;
                const u = session?.user;
                const meta = (u?.user_metadata ?? {}) as {
                    name?: string;
                    full_name?: string;
                };
                const email = u?.email ?? "";
                const name =
                    meta.full_name ||
                    meta.name ||
                    (email ? email.split("@")[0] : "") ||
                    "Korisnik";
                setSuperdocUser({ name, email });
            } catch (err) {
                console.warn("[SuperDocView] auth.getSession failed", err);
                if (!cancelled) {
                    setSuperdocUser({ name: "Korisnik", email: "" });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    // Lista pending document_edits dohvaćena s backenda — koristi se
    // ISKLJUČIVO za mapping SuperDoc entityId → DB edit (preko w:id),
    // pa bubble accept/reject za LLM-prijedloge zna kojem retku u DB-u
    // updejtati `status` (i u kojem retku Mike chat lista taj prijedlog
    // kao razriješen). Bez ovog lookup-a frontend bi samo lokalno
    // izmijenio DOCX, a DB ostao s "pending" status-om — Mike chat bi
    // i dalje pokazivao stare prijedloge.
    const [dbEdits, setDbEdits] = useState<MikeDocumentEditRow[]>([]);
    // ref kopija za pristup iz callbacks koji se ne smiju re-kreirati na
    // svaku promjenu liste (npr. handleDecide).
    const dbEditsRef = useRef<MikeDocumentEditRow[]>([]);
    useEffect(() => {
        dbEditsRef.current = dbEdits;
    }, [dbEdits]);

    useLayoutEffect(() => {
        onReadyRef.current = onReady;
        highlightEditRef.current = highlightEdit;
        initialScrollTopRef.current = initialScrollTop ?? null;
        onScrollChangeRef.current = onScrollChange;
    });

    // Kombiniramo external refetchKey (parent, npr. nakon LLM edit-a) i
    // lokalni (nakon "Spremi") da hook povuče bytes i u oba slučaja.
    const combinedRefetchKey = (refetchKey ?? 0) + localRefetchKey;
    const { bytes, loading, error } = useFetchDocxBytes(
        documentId,
        versionId,
        combinedRefetchKey,
    );

    const docFile = useMemo(() => {
        if (!bytes) return null;
        return new File([bytes], `${documentId}.docx`, {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
    }, [bytes, documentId]);

    const documentConfig = useMemo(() => {
        if (!docFile) return null;
        return {
            // `combinedRefetchKey` (ne samo parent `refetchKey`) je u id-u
            // pa i lokalni "Spremi" / accept-reject reload deterministički
            // re-mounta SuperDocEditor — isti, dokazani put kao kod LLM
            // edita. Posljedica: `editorReady` se resetira (vidi effect
            // niže) → spinner overlay pokrije reparse umjesto da korisnik
            // gleda prazan bijeli panel dok se 30 stranica iznova parsira.
            id: `${documentId}:${versionId ?? ""}:${combinedRefetchKey}`,
            type: "docx" as const,
            data: docFile,
        };
    }, [docFile, documentId, versionId, combinedRefetchKey]);

    const modules = useMemo(
        () => ({
            trackChanges: {
                visible: true,
                replacements: "paired" as const,
            },
            // Sakrijemo native SuperDoc review sidebar (Context7 potvrdio:
            // `modules.comments: false` gasi i comment bubble i tracked-
            // change review panel UI, ali ostavlja podatkovni sloj —
            // export/import i `editor.doc.trackChanges.list()` rade
            // identično). Naš vlastiti pomični panel preuzima review UX.
            // `as const` je nužan — bez njega TS širi tip na `boolean`,
            // a SuperDoc `Modules.comments` prihvaća samo literal `false`
            // ili konfiguracijski objekt (nikako proizvoljan boolean).
            comments: false as const,
            toolbar: {
                // `excludeItems` skraćuje native toolbar tako da stane u
                // jedan red i bude relevantna za pravne dokumente:
                //  • `documentMode` — već imamo vlastiti Pregled/Sugestije
                //    /Uređivanje switcher u našem toolbar redu iznad.
                //  • `image` — slike u pravnim dokumentima rade preko
                //    Word desktopa, ne treba u side-panelu.
                //  • `link` — rijetko se koristi u pravnoj formi.
                //  • sve `table-*` — Mike sam generira tablice; ručni
                //    insert + edit rows/columns je pretrpan.
                //  • `equation`/`formula` — fallback nazivi ako native
                //    toolbar ima math gumb (SuperDoc ignorira nepoznate
                //    ID-jeve, pa siguran be-a-no-op fallback).
                //  • `ruler` — mjerna traka troši vertikalni prostor
                //    a nije relevantna za side-panel scroll-area.
                // Autoritativan popis ID-jeva:
                // https://github.com/superdoc-dev/superdoc/blob/main/apps/docs/editor/custom-ui/toolbar-and-commands.mdx
                excludeItems: [
                    "documentMode",
                    "image",
                    "link",
                    "table-insert",
                    "table-add-row-before",
                    "table-add-row-after",
                    "table-delete-row",
                    "table-add-column-before",
                    "table-add-column-after",
                    "table-delete-column",
                    "table-merge-cells",
                    "table-split-cell",
                    "table-delete",
                    "equation",
                    "formula",
                    "ruler",
                ],
            },
        }),
        [],
    );

    const bindScrollListener = useCallback(() => {
        scrollCleanupRef.current?.();
        scrollCleanupRef.current = null;

        const scrollEl = findScrollElement(wrapperRef.current);
        if (!scrollEl) return;

        let scheduled = false;
        const onScroll = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                onScrollChangeRef.current?.(scrollEl.scrollTop);
            });
        };
        scrollEl.addEventListener("scroll", onScroll, { passive: true });
        scrollCleanupRef.current = () =>
            scrollEl.removeEventListener("scroll", onScroll);
    }, []);

    const refreshTrackChanges = useCallback(() => {
        // Kritičan rani exit: ako SuperDoc još nije signalizirao
        // `ready` event našem handleReady-ju, `editor.doc` getter baca
        // `InvalidStateError`. Optional chaining (`editor?.doc?.x`)
        // NE pomaže — getter throw-a synchrono, prije nego što JS
        // engine stigne dohvatiti `.x`. Ref pristup čita aktualni
        // ready-state čak i u callback-ovima koje SuperDoc internally
        // emit-ira tijekom `broadcastEditorCreate` chain-a.
        if (!editorReadyRef.current) return;
        const superdoc = superdocRef.current;
        const editor = superdoc?.activeEditor;
        if (!editor) {
            setTrackChanges([]);
            return;
        }
        // Cjelokupan pristup `editor.doc` ide kroz jedan try/catch da
        // hvati i throwing getter (ne samo `list()` exception). Ako
        // bilo što baci, samo skipnemo refresh — sljedeći editor:update
        // će opet probati kad editor sigurno bude u ready/saving stanju.
        try {
            const tc = editor.doc?.trackChanges;
            if (!tc) {
                setTrackChanges([]);
                return;
            }
            const { items } = tc.list();
            const db = dbEditsRef.current;
            setTrackChanges(
                items.map((it) => {
                    const insertWId = it.wordRevisionIds?.insert ?? null;
                    const deleteWId = it.wordRevisionIds?.delete ?? null;
                    const matched = db.find(
                        (e) =>
                            (insertWId && e.ins_w_id === insertWId) ||
                            (deleteWId && e.del_w_id === deleteWId),
                    );
                    return {
                        id: it.id,
                        type: it.type,
                        author: it.author,
                        excerpt: it.excerpt,
                        insertWId,
                        deleteWId,
                        story:
                            (it as { address?: { story?: TrackChangeItem["story"] } })
                                .address?.story ?? null,
                        dbEditId: matched?.id ?? null,
                    };
                }),
            );
        } catch (err) {
            const msg =
                err instanceof Error ? err.message : String(err);
            // `destroyed` je očekivan tijekom accept/reject transakcije
            // kad SuperDoc interno remount-a editor — ne spamamo konzolu.
            if (!/editor is in 'destroyed'/.test(msg)) {
                console.warn(
                    "[SuperDocView] refreshTrackChanges skipped (editor not ready)",
                    err,
                );
            }
        }
    }, []);

    const refreshDbEdits = useCallback(async () => {
        try {
            const edits = await listDocumentEdits(documentId, "pending");
            setDbEdits(edits);
            dbEditsRef.current = edits;
            // Nakon što stignu svježi DB editi, prereduciraj track
            // changes da pickaju nove dbEditId vrijednosti.
            refreshTrackChanges();
        } catch (err) {
            console.warn("[SuperDocView] listDocumentEdits failed", err);
        }
    }, [documentId, refreshTrackChanges]);

    const handleReady = useCallback(
        async ({ superdoc }: SuperDocReadyEvent) => {
            superdocRef.current = superdoc;

            // SuperDoc 1.34/1.35: `onReady` se emit-a u sklopu
            // `broadcastEditorCreate` chain-a, prije nego što editor
            // unutra-nje prijeđe iz `initialized` u `ready` state.
            // Svaki sinkroni `editor.doc.trackChanges.list()` ovdje
            // baca `InvalidStateError`. Defer-amo sav rad za sljedeći
            // animation frame da editor stigne završiti state
            // transition.
            const pendingHighlight = highlightEditRef.current;
            if (pendingHighlight) {
                await scrollToHighlightEdit(superdoc, pendingHighlight);
            } else {
                const scrollEl = findScrollElement(wrapperRef.current);
                const pendingInitialScroll = initialScrollTopRef.current;
                if (
                    scrollEl &&
                    typeof pendingInitialScroll === "number"
                ) {
                    scrollEl.scrollTop = pendingInitialScroll;
                }
            }

            bindScrollListener();
            setEditorReady(true);

            // Defer initial track changes refresh — `editorReadyRef` se
            // ažurira useEffect-om u sljedećem React commit-u, a `refresh
            // TrackChanges` rano izlazi ako je ref još `false`. rAF nije
            // dovoljan jer se izvrši PRIJE React commit-a; setTimeout(0)
            // čeka task tick što garantira da je commit gotov i ref true.
            // Plus, refreshTrackChanges interno koristi `superdocRef.current`
            // (NE closure ref na `superdoc`), tako da povlači aktualnu
            // instancu — bitno kad se SuperDoc remount-ao između onReady
            // i ovog tick-a (refetchKey bump nakon save / Mike edit-a).
            window.setTimeout(() => {
                refreshTrackChanges();
                void refreshDbEdits();
                // Citation highlight is deferred for the same reason as track
                // changes — the editor must finish its initialized→ready
                // transition before search commands are safe to call.
                if (!pendingHighlight) {
                    highlightCitationsInSuperDoc(
                        superdocRef.current,
                        quotesRef.current,
                    );
                }
            }, 0);

            onReadyRef.current?.();
        },
        [bindScrollListener, refreshDbEdits, refreshTrackChanges],
    );

    useEffect(() => {
        const superdoc = superdocRef.current;
        const pendingHighlight = highlightEdit;
        if (!superdoc || !pendingHighlight) return;
        void scrollToHighlightEdit(superdoc, pendingHighlight);
    }, [highlightEdit?.key]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-run citation highlight when the quote set changes on an already-open
    // document (e.g. clicking a different citation pill without remounting the
    // tab). Skipped while an edit highlight is pending — that owns the scroll.
    useEffect(() => {
        if (!editorReady || highlightEdit) return;
        highlightCitationsInSuperDoc(superdocRef.current, quotes);
    }, [editorReady, quotes, highlightEdit]);

    // "Spremljeno · prije Ns" label čistimo SAMO kad korisnik prijeđe na
    // stvarno drugi dokument/verziju — NE na save-triggered reload iste
    // datoteke. Otkad Bug 1 fix mijenja `versionId` na svako spremanje
    // (onSaved → parent bumpa tab.versionId → nova verzija stigne nazad),
    // moramo razlikovati "korisnik otvorio drugu verziju" od "upravo smo
    // spremili novu verziju". Ako je versionId == verzija koju smo upravo
    // spremili, preskačemo reset da badge ostane vidljiv.
    useEffect(() => {
        if (versionId && justSavedVersionIdRef.current === versionId) {
            justSavedVersionIdRef.current = null;
            return;
        }
        setLastSavedAt(null);
    }, [documentId, versionId]);

    useEffect(() => {
        // Svaki reload (nova verzija, LLM edit, ili lokalni Spremi —
        // sve bumpa combinedRefetchKey u documentConfig.id) re-mounta
        // SuperDoc. Spustimo editorReady na false da spinner overlay
        // pokrije reparse; handleReady ga vrati na true. Dirty/saveError
        // resetiramo jer je svježe učitan dokument definicijom "čist".
        setEditorReady(false);
        setIsDirty(false);
        setSaveError(null);
        setContentError(null);
        return () => {
            scrollCleanupRef.current?.();
            scrollCleanupRef.current = null;
            superdocRef.current = null;
        };
    }, [documentConfig?.id]);

    const handleEditorUpdate = useCallback(() => {
        // SuperDoc okida ovaj event ne samo na korisničke izmjene, već
        // i interno tijekom `broadcastEditorCreate` chain-a (npr. kad
        // `setDocumentMode` dispatch-a `disableTrackChangesShowOriginal`
        // transakciju prije nego što editor uđe u `ready` stanje).
        // Ako uđemo ovdje prije `handleReady` setiranja editorReady=true,
        // svaki pokušaj čitanja `editor.doc` baca InvalidStateError —
        // pa preskačemo. Sljedeći legitimni update će refreshati panel.
        if (!editorReadyRef.current) return;
        // Bug 2: NE postavljamo `isDirty` slijepo na svaki update. SuperDoc
        // okida `onEditorUpdate` i za interni mode-switch (viewing→editing
        // nakon remounta), što bi lažno upalilo "Nespremljene promjene" i
        // pokrenulo auto-save petlju (nova verzija svakih ~30s). SuperDoc-ov
        // `isDocumentModified()` vraća `true` samo ako je sadržaj stvarno
        // mijenjan od zadnjeg load/save — mode-switch ne mijenja sadržaj.
        const editor = superdocRef.current?.activeEditor;
        let modified = true;
        try {
            modified = editor?.isDocumentModified?.() ?? true;
        } catch {
            // Ako metoda baci (npr. editor u tranzicijskom stanju),
            // konzervativno tretiramo kao izmjenu da ne izgubimo rad.
            modified = true;
        }
        if (modified) setIsDirty(true);
        refreshTrackChanges();
    }, [refreshTrackChanges]);

    const handleScrollToChange = useCallback(async (id: string) => {
        const superdoc = superdocRef.current;
        if (!superdoc) return;
        try {
            await superdoc.scrollToElement(id);
        } catch (err) {
            console.warn("[SuperDocView] scrollToElement failed", err);
        }
    }, []);

    // Per-item resolving state — pokazuje spinner na "Prihvati"/"Odbij"
    // gumbima dok backend `resolveDocumentEdit` + DOCX refetch traje
    // (~2-4s). Bez ovog korisnik klikne pa misli da se ništa ne događa
    // i ponovo klikće, što uzrokuje race condition kod backend rute.
    // Skladišti SuperDoc-ove `it.id` (NE dbEditId) jer je to ono što
    // bubble panel zna pri renderu.
    const [resolvingIds, setResolvingIds] = useState<Set<string>>(
        () => new Set(),
    );

    // Ref na `handleSave` da `handleDecide` može pozvati spremanje bez
    // hoist-anja (handleSave je deklariran kasnije i ima šire deps —
    // reorganizacija bi povukla puno stvari). Ref se update-a u
    // sljedećem useEffect-u kad se handleSave promijeni.
    const handleSaveRef = useRef<(() => Promise<void>) | null>(null);
    const refreshTrackChangesTimerRef = useRef<number | null>(null);

    const scheduleRefreshTrackChanges = useCallback(() => {
        if (refreshTrackChangesTimerRef.current !== null) {
            window.clearTimeout(refreshTrackChangesTimerRef.current);
        }
        // Defer refresh — odmah nakon accept/reject SuperDoc 1.35
        // kratko prelazi u `destroyed` state pa sync refresh fail-a i
        // panel ostane nepromijenjen iako je decide prošao.
        refreshTrackChangesTimerRef.current = window.setTimeout(() => {
            refreshTrackChangesTimerRef.current = null;
            refreshTrackChanges();
        }, 250);
    }, [refreshTrackChanges]);

    useEffect(
        () => () => {
            if (refreshTrackChangesTimerRef.current !== null) {
                window.clearTimeout(refreshTrackChangesTimerRef.current);
            }
        },
        [],
    );

    const handleDecide = useCallback(
        async (id: string, decision: "accept" | "reject") => {
            if (!editorReadyRef.current) return;
            const superdoc = superdocRef.current;
            if (!superdoc?.activeEditor) return;
            if (resolvingIds.has(id)) return;

            setResolvingIds((s) => {
                const next = new Set(s);
                next.add(id);
                return next;
            });

            const item = trackChanges.find((it) => it.id === id);
            const dbEditId = item?.dbEditId ?? null;

            const clearResolving = () => {
                setResolvingIds((s) => {
                    const next = new Set(s);
                    next.delete(id);
                    return next;
                });
            };

            // Optimistički makni stavku iz bubble panela odmah — korisnik
            // vidi instant feedback bez čekanja na editor lifecycle.
            const optimisticRemove = () => {
                setTrackChanges((prev) => prev.filter((it) => it.id !== id));
            };

            if (dbEditId) {
                optimisticRemove();
                try {
                    await resolveDocumentEdit(
                        documentId,
                        dbEditId,
                        decision,
                    );
                    // Backend je prepisao DOCX bytes — očisti cache da
                    // reopen ne servira staru verziju (isti razlog kao u
                    // handleSave).
                    invalidateDocxBytes(documentId);
                    setLocalRefetchKey((k) => k + 1);
                    await refreshDbEdits();
                    track("draft_edit_applied");
                } catch (err) {
                    console.error(
                        "[SuperDocView] resolveDocumentEdit failed",
                        err,
                    );
                    scheduleRefreshTrackChanges();
                } finally {
                    clearResolving();
                }
                return;
            }

            // NE prebacujemo documentMode. `decide()` je headless
            // Document API put koji interno prevede entityId → rawId i
            // primijeni accept/reject preko `acceptTrackedChangeById`
            // BEZ obzira na mode/role (provjera dozvole `isTrackedChange
            // ActionAllowed` vraća true jer ne konfiguriramo `permission
            // Resolver`). Raniji "switch na editing" je SAMO štetio:
            // promjena moda rekreira editor/indeks pa entityId iz panela
            // zastari → `decide` baca TARGET_NOT_FOUND ("Tracked change
            // X was not found"). Ostajemo u trenutnom modu gdje je
            // entityId još važeći.
            optimisticRemove();

            try {
                const liveEditor = superdocRef.current?.activeEditor;
                if (!liveEditor) {
                    throw new Error("editor unavailable");
                }

                const tc = liveEditor.doc?.trackChanges;
                if (!tc) {
                    throw new Error("trackChanges API nedostupan");
                }

                // Svježe pre-razrješenje cilja protiv TRENUTNOG editora.
                // entityId koji je bubble panel zapamtio može zaostati
                // (lista se osvježava na editor:update s 250ms debounce-om),
                // a `decide` baca TARGET_NOT_FOUND ako entityId ne postoji
                // u aktualnom indeksu. Tražimo svjež entityId: prvo po
                // istom id-u, zatim po STABILNIM Word w:id-ovima (oni
                // preživljavaju re-import/remount, za razliku od kanonskog
                // entityId-a). `address.story` uzimamo s pronađene svježe
                // stavke jer decide treba točan story za promjene izvan
                // body-ja (header/footer/tablice).
                type ListItem = {
                    id: string;
                    wordRevisionIds?: {
                        insert?: string | null;
                        delete?: string | null;
                    } | null;
                    address?: { story?: TrackChangeItem["story"] } | null;
                };
                let targetId = id;
                let targetStory = item?.story ?? null;
                try {
                    const { items } = tc.list() as { items: ListItem[] };
                    const fresh =
                        items.find((it) => it.id === id) ??
                        items.find((it) => {
                            const ins = it.wordRevisionIds?.insert ?? null;
                            const del = it.wordRevisionIds?.delete ?? null;
                            return Boolean(
                                (item?.insertWId && ins === item.insertWId) ||
                                    (item?.deleteWId &&
                                        del === item.deleteWId),
                            );
                        });
                    if (!fresh) {
                        // Promjena više ne postoji u dokumentu (već
                        // razriješena ili remount-ana izvan našeg uvida).
                        // Tretiramo kao razriješenu: NE zovemo decide
                        // (izbjegavamo TARGET_NOT_FOUND), samo osvježimo
                        // panel — bez error toasta jer korisnik ništa
                        // krivo nije napravio.
                        console.info(
                            "[SuperDocView] decide preskočen — promjena više ne postoji",
                            { id, decision },
                        );
                        scheduleRefreshTrackChanges();
                        return;
                    }
                    targetId = fresh.id;
                    targetStory = fresh.address?.story ?? targetStory;
                } catch (listErr) {
                    console.warn(
                        "[SuperDocView] tc.list re-resolve nije uspio; koristim id iz panela",
                        listErr,
                    );
                }

                // Target uključuje `story` kad je dostupan — inače decide
                // tiho ne pronađe promjene izvan body story-ja.
                const target: {
                    id: string;
                    story?: { kind: string; storyType: string };
                } = { id: targetId };
                if (targetStory) {
                    target.story = targetStory;
                }

                // Receipt = { success:true, ... } | { success:false,
                // failure:{ code, message } }. Raniji kod je radio
                // `success !== false` pa je NO-OP (success:false) tretirao
                // kao uspjeh. Sad strogo tražimo success===true.
                type DecideReceipt =
                    | { success: true }
                    | {
                          success: false;
                          failure?: { code?: string; message?: string };
                      };
                let receipt = (
                    decision === "accept"
                        ? tc.decide({
                              decision: "accept",
                              target: target as { id: string },
                          })
                        : tc.decide({
                              decision: "reject",
                              target: target as { id: string },
                          })
                ) as DecideReceipt;

                // SuperDoc 1.37 fallback. `decide` (Document API) interno ruta
                // na editor command `acceptTrackedChangeById(rawId)`, koji
                // promjenu razrješava SAMO ako `findTrackedMarkBetween` nađe
                // INLINE tracked-mark raspon. Za block-level insert (npr. cijeli
                // novi naslovni odlomak) raspon se ne razriješi → komanda je
                // no-op → `executeDomainCommand` vidi da transakcija nema
                // `effect:"changed"` korak → receipt `{ success:false,
                // failure:{ code:"NO_OP" } }`. (Potvrđeno u izvoru v1.37.0:
                // document-api-adapters/plan-engine/track-changes-wrappers.ts →
                // decideSingle.) Provjeriti je li popravljeno u superdoc@1.38.0.
                //
                // Bulk `accept/rejectAllTrackedChanges` enumerira promjene preko
                // tracked-change INDEKSA (isti izvor kao `tc.list()`), pa hvata i
                // block-level promjene koje per-id put promaši. GATE-amo ga na
                // "točno jedna preostala promjena" da ne razriješimo i TUĐE
                // pending promjene u istom dokumentu. Uspjeh potvrđujemo TEK ako
                // broj promjena stvarno padne — ne vjerujemo povratnoj vrijednosti
                // komande (acceptTrackedChangeById vrati `[].every()===true` i kad
                // ništa ne učini).
                const isNoOp =
                    receipt?.success !== true &&
                    !!receipt &&
                    "failure" in receipt &&
                    receipt.failure?.code === "NO_OP";

                if (isNoOp) {
                    const ed = liveEditor as unknown as {
                        doc?: {
                            trackChanges?: {
                                list: () => { items: unknown[] };
                            };
                        };
                        commands?: Record<string, (() => boolean) | undefined>;
                    };
                    const pendingCount = (): number => {
                        try {
                            return (
                                ed.doc?.trackChanges?.list().items.length ?? -1
                            );
                        } catch {
                            return -1;
                        }
                    };
                    const before = pendingCount();
                    if (before === 1) {
                        const bulkName =
                            decision === "accept"
                                ? "acceptAllTrackedChanges"
                                : "rejectAllTrackedChanges";
                        const bulk = ed.commands?.[bulkName];
                        if (typeof bulk === "function") {
                            try {
                                bulk();
                            } catch (fbErr) {
                                console.warn(
                                    "[SuperDocView] decide fallback (bulk) iznimka",
                                    fbErr,
                                );
                            }
                        }
                        if (pendingCount() < before) {
                            receipt = { success: true };
                            console.info(
                                "[SuperDocView] decide NO_OP razriješen bulk fallbackom",
                                { id: targetId, decision },
                            );
                        }
                    } else {
                        console.warn(
                            "[SuperDocView] decide NO_OP uz >1 pending — bulk fallback preskočen",
                            { id: targetId, decision, pending: before },
                        );
                    }
                }

                if (receipt?.success !== true) {
                    const failure =
                        receipt && "failure" in receipt
                            ? receipt.failure
                            : undefined;
                    console.warn(
                        "[SuperDocView] decide nije primijenio promjenu",
                        {
                            id: targetId,
                            decision,
                            code: failure?.code,
                            message: failure?.message,
                        },
                    );
                    throw new Error(
                        `decide failed: ${failure?.code ?? "unknown"}`,
                    );
                }

                setIsDirty(true);
                scheduleRefreshTrackChanges();
                // draft_edit_applied is NOT fired here — this is the native
                // SuperDoc decide() path which runs after every tracked-change
                // accept/reject (including auto-save cycles). The event is
                // already fired in the dbEditId branch above (resolveDocumentEdit),
                // which covers LLM-generated edits accepted via the backend.
                // Firing here too inflated counts; one event per explicit
                // LLM-edit acceptance is the correct granularity.

                // U Pregled modu odmah spremimo (korisnik nema vlastiti
                // Spremi gumb); u editing/suggesting modu setIsDirty
                // prepušta ručnom/auto-save-u.
                if (documentMode === "viewing") {
                    await handleSaveRef.current?.();
                }
            } catch (err) {
                console.error("[SuperDocView] decide failed", err);
                // Primjena nije uspjela — vrati stavku u panel (re-list
                // stvarnog stanja) i javi korisniku umjesto da tiho
                // spremimo nepromijenjeni dokument.
                setSaveError(
                    "Promjenu nije bilo moguće primijeniti — pokušajte ponovno.",
                );
                scheduleRefreshTrackChanges();
            } finally {
                clearResolving();
            }
        },
        [
            documentId,
            documentMode,
            refreshDbEdits,
            refreshTrackChanges,
            resolvingIds,
            scheduleRefreshTrackChanges,
            trackChanges,
        ],
    );

    const handleSave = useCallback(async () => {
        const superdoc = superdocRef.current;
        if (!superdoc || saving) return;
        setSaving(true);
        setSaveError(null);
        try {
            // export() vraća Blob (browser) — i u suggesting i u editing
            // modu zadržava tracked changes (isFinalDoc:false). To znači
            // da spremljena verzija sadrži korisničke prijedloge koje
            // Mike kasnije može prepoznati istom logikom kao i vlastite.
            const blob = await superdoc.export({
                triggerDownload: false,
                isFinalDoc: false,
            });
            if (!blob) throw new Error("SuperDoc export vratio prazan blob");
            const file = new File([blob], `${documentId}.docx`, {
                type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            const saved = await uploadDocumentVersion(documentId, file);
            // Evict in-memory bytesCache za ovaj dokument. Bez ovog, reopen
            // modala (svjež mount → localRefetchKey natrag na 0 → ključ
            // `docId::`) servira STARE, prije-edit bytes iz module-level
            // cachea i izgleda kao da spremanje nije uspjelo sve dok korisnik
            // ne refresha stranicu (Map se čisti tek na full reload). LLM put
            // ovo već radi preko ChatView-a; ručni Spremi je jedini koji je
            // falio (vidi SUPERDOC_SAVE_BUG, Bug 1).
            invalidateDocxBytes(documentId);
            setIsDirty(false);
            setLastSavedAt(Date.now());
            // Bug 1: reload mora ciljati BAŠ ovu, novospremljenu verziju —
            // ne staru prikvačenu `versionId`. Propagiramo novi versionId
            // gore (tab vlasnik) koji ga vrati kao prop → documentConfig.id
            // se promijeni → svjež GET nove verzije. `justSavedVersionIdRef`
            // čuva badge "Spremljeno" preko te promjene versionId-a.
            if (onSaved) {
                justSavedVersionIdRef.current = saved.id;
                onSaved({
                    versionId: saved.id,
                    versionNumber: saved.version_number ?? null,
                });
            } else {
                // Bez tab-vlasnika nemamo kamo propagirati versionId —
                // fallback na lokalni refetch (učita trenutnu verziju).
                setLocalRefetchKey((k) => k + 1);
            }
            // Nakon što naša user-edit verzija sletne u GCS, neki
            // LLM-generirani document_edits redovi mogli su se izgubiti
            // (npr. korisnik je odbio prijedlog u toku editiranja).
            // Resync osigurava da bubble panel pokazuje tek još otvorene
            // prijedloge, a Mike chat će dobiti svjež status.
            void refreshDbEdits();
        } catch (err) {
            console.error("[SuperDocView] save failed", err);
            setSaveError(
                err instanceof Error
                    ? err.message
                    : "Spremanje nije uspjelo.",
            );
        } finally {
            setSaving(false);
        }
    }, [documentId, onSaved, refreshDbEdits, saving]);

    // Sinkroniziraj ref na najsvježiju handleSave callback referencu —
    // koristi je handleDecide (deklariran prije handleSave) kad mora
    // okinuti auto-save nakon decide u Pregled modu.
    useEffect(() => {
        handleSaveRef.current = handleSave;
    }, [handleSave]);

    // ─── Auto-save ────────────────────────────────────────────────────
    //
    // Trigger debounceom: 30s nakon zadnje izmjene (isDirty=true), ako
    // korisnik ne klikne "Spremi" ručno, pozovemo handleSave u
    // pozadini. Razlog: korisnici često zatvore tab ili prijeđu na
    // drugi predmet zaboravivši kliknuti Spremi, a tracked changes
    // koji nisu uploadirani gube se kod re-mounta SuperDoc-a (jer
    // useFetchDocxBytes vraća svježi DOCX iz GCS-a). 30s je dovoljno
    // dugo da ne pohranjujemo svaku tipku, dovoljno kratko da
    // korisnik ne izgubi rad.
    //
    // Strogo lokalno — backend ne razlikuje "manual" od "auto" save-a;
    // oba završavaju kao nova version row u document_versions tablici.
    // Spojeni s pravom user-edit source enum vrijednošću (Faza 5),
    // poslije ćemo razdvojiti.
    //
    // Guard-amo da ne radimo auto-save dok:
    //  • dokument nije dirty (nema što spremati),
    //  • smo u Pregled modu (ne unosimo se),
    //  • editor nije ready (race condition s mount-om),
    //  • save je već u tijeku (ne pokrećemo paralel),
    //  • postoji save error koji čeka korisnikovu akciju (inače bismo
    //    petljali pokušaje koji svi padaju iz istog razloga).
    const AUTO_SAVE_DELAY_MS = 30_000;
    useEffect(() => {
        if (!isDirty) return;
        if (documentMode === "viewing") return;
        if (!editorReady) return;
        if (saving) return;
        if (saveError) return;
        const timer = window.setTimeout(() => {
            void handleSave();
        }, AUTO_SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [isDirty, documentMode, editorReady, saving, saveError, handleSave]);

    // ─── Window-level swallow za SuperDoc internal exception-e ───────
    //
    // SuperDoc 1.35 ima nekoliko emit-orova koji throw-aju asinkrono
    // (npr. `editor.doc` getter unutar `disableTrackChangesShowOriginal`
    // dispatcha) tijekom mount-time chain-a `broadcastEditorCreate`.
    // Naši callback-ovi (`onEditorUpdate`, `onReady`) sad guard-aju
    // svoj pristup, ali SuperDoc-ovi VLASTITI listeneri pucaju
    // OUTSIDE-OF naše kontrole — i kao `Uncaught (in promise)` ili
    // `Uncaught Error` u global error handler-u. To okida sentry
    // alerte, Cloud Run logove, browser konzolu — ali NIKAKO ne
    // mijenja funkcionalnost (editor se sam recover-a u sljedećem
    // tick-u).
    //
    // Filter je VRLO uzak: hvatamo SAMO `InvalidStateError` s
    // message-om "editor is in 'initialized'" ili "'destroyed'" — sve
    // ostalo prolazi dalje u ErrorBoundary i window.onerror normalno.
    useEffect(() => {
        const isSuperDocStateError = (err: unknown): boolean => {
            if (!err || typeof err !== "object") return false;
            const e = err as { name?: string; message?: string };
            if (e.name !== "InvalidStateError") return false;
            const msg = e.message ?? "";
            return /editor is in '(initialized|destroyed)'/.test(msg);
        };
        const onError = (e: ErrorEvent) => {
            if (isSuperDocStateError(e.error)) {
                e.preventDefault();
                console.warn(
                    "[SuperDocView] swallowed SuperDoc mount-race",
                    (e.error as Error).message,
                );
            }
        };
        const onRejection = (e: PromiseRejectionEvent) => {
            const reason = e.reason;
            // Wrapper-i tipa `[CommandService] Dispatch failed: ...`
            // sadrže InvalidStateError kao cause; provjeravamo i raw
            // reason i `.cause`.
            const inner =
                isSuperDocStateError(reason) ||
                isSuperDocStateError(
                    (reason as { cause?: unknown })?.cause,
                );
            if (inner) {
                e.preventDefault();
                console.warn(
                    "[SuperDocView] swallowed SuperDoc mount-race (promise)",
                    reason instanceof Error ? reason.message : reason,
                );
            }
        };
        window.addEventListener("error", onError);
        window.addEventListener("unhandledrejection", onRejection);
        return () => {
            window.removeEventListener("error", onError);
            window.removeEventListener("unhandledrejection", onRejection);
        };
    }, []);

    // Ctrl/Cmd+S — savršeno klasičan Office shortcut. preventDefault
    // zaustavlja browser-ov "Spremi stranicu kao HTML" dijalog. Hooked
    // samo dok je dokument dirty u edit modu — ako korisnik pokuša
    // u Pregled modu, browser-ov default ostaje (manja iznenadjenja
    // nego globalno hijack-ati Ctrl/Cmd+S za svaku stranicu projekta).
    useEffect(() => {
        if (documentMode === "viewing") return;
        const onKey = (e: KeyboardEvent) => {
            const isSave =
                (e.ctrlKey || e.metaKey) &&
                !e.shiftKey &&
                !e.altKey &&
                e.key.toLowerCase() === "s";
            if (!isSave) return;
            e.preventDefault();
            if (!isDirty || saving) return;
            void handleSave();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [documentMode, isDirty, saving, handleSave]);

    // ─── "Spremljeno · prije Ns" timer ────────────────────────────────
    //
    // Da prikaz vremena ostane živi (1s tick) bez da forsiramo full
    // re-render parent-a, držimo lokalni `nowTick` koji se inkrementira
    // svakih 5s dok je `lastSavedAt` set. Stop-amo timer kad korisnik
    // počne ponovno editirati (isDirty=true) jer status preuzima
    // "Nespremljene promjene" badge.
    const [nowTick, setNowTick] = useState(0);
    useEffect(() => {
        if (!lastSavedAt) return;
        if (isDirty) return;
        const id = window.setInterval(() => setNowTick((t) => t + 1), 5_000);
        return () => window.clearInterval(id);
    }, [lastSavedAt, isDirty]);

    const savedAgoLabel = useMemo(() => {
        if (!lastSavedAt) return null;
        // `nowTick` u dep array-u: prisiljava re-compute da label
        // refresha sam (nema useEffect koji bi ga setirao u state).
        void nowTick;
        const secs = Math.max(1, Math.floor((Date.now() - lastSavedAt) / 1000));
        if (secs < 60) return `Spremljeno · prije ${secs}s`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `Spremljeno · prije ${mins} min`;
        const hours = Math.floor(mins / 60);
        return `Spremljeno · prije ${hours} h`;
    }, [lastSavedAt, nowTick]);

    if (loading && !docFile) {
        return (
            <div
                className={`relative flex flex-col flex-1 overflow-hidden ${bordered ? "border border-border" : ""} ${rounded ? "rounded-xl" : ""}`}
            >
                <div className="flex h-full items-center justify-center bg-muted">
                    <MikeIcon spin mike size={28} />
                </div>
            </div>
        );
    }

    if (error || contentError) {
        return (
            <div
                className={`relative flex flex-col flex-1 overflow-hidden ${bordered ? "border border-border" : ""} ${rounded ? "rounded-xl" : ""}`}
            >
                <div className="flex h-full items-center justify-center bg-muted">
                    <p className="text-sm text-destructive">
                        {error ?? contentError}
                    </p>
                </div>
            </div>
        );
    }

    if (!documentConfig) return null;

    return (
        <div
            className={`relative flex flex-col flex-1 overflow-hidden ${bordered ? "border border-border" : ""} ${rounded ? "rounded-xl" : ""}`}
        >
            {warning && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border border-warning/20 bg-warning/10 px-2 py-1 text-xs text-warning">
                    <span>{warning}</span>
                    <button
                        type="button"
                        onClick={() => onWarningDismiss?.()}
                        className="text-warning hover:text-warning/80"
                        aria-label="Dismiss warning"
                    >
                        ×
                    </button>
                </div>
            )}
            {/* Mode switch + Save toolbar. Smišljeno tanak (h-9) da ne
                ugrozi prostor za sami dokument; vidljiv samo kad je
                SuperDoc spreman da ne distrahira tijekom inicijalizacije. */}
            {editorReady && (
                <div className="flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-1.5">
                    <div
                        className="inline-flex rounded-md border border-border bg-muted p-0.5"
                        role="radiogroup"
                        aria-label="Način rada s dokumentom"
                    >
                        {(Object.keys(MODE_LABELS) as DocumentMode[]).map(
                            (m) => {
                                const Icon = MODE_ICONS[m];
                                const active = documentMode === m;
                                return (
                                    <button
                                        key={m}
                                        type="button"
                                        role="radio"
                                        aria-checked={active}
                                        onClick={() => setDocumentMode(m)}
                                        className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                                            active
                                                ? "bg-surface-elevated text-foreground"
                                                : "text-muted-foreground hover:text-foreground"
                                        }`}
                                    >
                                        <Icon className="h-3.5 w-3.5" />
                                        {MODE_LABELS[m]}
                                    </button>
                                );
                            },
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {/* "Promjene N" toggle — dostupno u svim modovima
                            (LLM prijedlozi vidljivi su i u Pregledu). Badge
                            pokazuje broj nerazriješenih tracked changes; klik
                            otvara/zatvara naš pomični bubble panel. */}
                        <button
                            type="button"
                            onClick={() => setPanelOpen((v) => !v)}
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                                panelOpen
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border bg-background text-foreground hover:bg-accent"
                            }`}
                            aria-pressed={panelOpen}
                        >
                            <MessageSquareText className="h-3.5 w-3.5" />
                            Promjene
                            {trackChanges.length > 0 && (
                                <span
                                    className={`inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
                                        panelOpen
                                            ? "bg-primary-foreground text-primary"
                                            : "bg-primary text-primary-foreground"
                                    }`}
                                >
                                    {trackChanges.length}
                                </span>
                            )}
                        </button>
                        {documentMode !== "viewing" && (
                            <>
                                {saveError && (
                                    <span
                                        className="text-xs text-destructive"
                                        title="Auto-save je pauziran dok se ne otkloni greška ili ručno ponovo pokrene Spremi."
                                    >
                                        {saveError}
                                    </span>
                                )}
                                {!saveError &&
                                    !saving &&
                                    isDirty && (
                                        <span
                                            className="text-xs text-warning"
                                            title="Automatsko spremanje za 30s — možete kliknuti Spremi za odmah."
                                        >
                                            Nespremljene promjene
                                        </span>
                                    )}
                                {!saveError &&
                                    !saving &&
                                    !isDirty &&
                                    savedAgoLabel && (
                                        <span className="text-xs text-muted-foreground">
                                            {savedAgoLabel}
                                        </span>
                                    )}
                                <button
                                    type="button"
                                    onClick={handleSave}
                                    disabled={!isDirty || saving}
                                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                                        !isDirty || saving
                                            ? "cursor-not-allowed border-border bg-muted text-muted-foreground/70"
                                            : "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                                    }`}
                                    aria-busy={saving}
                                    title={
                                        isDirty
                                            ? "Spremi odmah (Ctrl/Cmd+S)"
                                            : "Nema promjena za spremiti"
                                    }
                                >
                                    {saving ? (
                                        <MikeIcon spin mike size={14} />
                                    ) : (
                                        <Save className="h-3.5 w-3.5" />
                                    )}
                                    {saving ? "Spremam…" : "Spremi"}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}
            {/* Vlastita mini-toolbar je uklonjena — SuperDoc native
                toolbar (renderira se ispod `hideToolbar={false}`) je
                bogatija (font, boja, tablice, slike, equation) i već
                pokriva sve što smo replicirali. Držeći samo jednu
                toolbaru izbjegavamo vizualni nered i confusion oko
                koje gumbe koristiti. Eventualna HR lokalizacija
                tooltip-ova ide kroz `modules.toolbar.texts` (vidi
                Faza 4 plan). */}
            <div
                ref={wrapperRef}
                className={cn(
                    "flex-1 min-h-0 bg-muted superdoc-view-scroll relative",
                    documentMode === "viewing" && "superdoc-toolbar-hidden",
                )}
                data-document-id={documentId}
                data-version-id={versionId ?? ""}
            >
                {superdocUser && (
                    <SuperDocEditor
                        document={documentConfig}
                        /* SuperDoc 1.34 baca `InvalidStateError: editor is
                           in 'initialized' state` ako `documentMode` prop
                           nije "viewing" u trenutku mount-a — interno
                           okida setDocumentMode prije nego što editor
                           emit-a `ready` event. Pri svakom remount-u
                           (refetchKey bump nakon Mike edit-a) prop se
                           resetira na "viewing"; korisnikov stvarni mode
                           propagiramo tek nakon što `handleReady` postavi
                           editorReady=true (vidi mode toolbar render guard
                           na liniji ~608). */
                        documentMode={editorReady ? documentMode : "viewing"}
                        /* `role` i `hideToolbar` su KONSTANTE namjerno:
                           React wrapper radi potpuni rebuild instance
                           (re-parse cijelog DOCX-a) kad se promijene
                           `role`, `hideToolbar`, `user` ili `modules` —
                           samo se `documentMode` mijenja bez rebuilda.
                           Read-only ponašanje u Pregledu daje
                           documentMode="viewing" sam; toolbar se u tom
                           modu skriva CSS-om (klasa
                           `superdoc-toolbar-hidden` na wrapperu, vidi
                           globals.css) umjesto `hideToolbar` propom. */
                        role="editor"
                        user={superdocUser}
                        contained
                        modules={modules}
                        onReady={handleReady}
                        onEditorUpdate={handleEditorUpdate}
                        /* Greška parsiranja DOCX-a — bez ovog handlera
                           `onReady` nikad ne okine i spinner overlay
                           ostaje zauvijek. Prikazujemo poruku umjesto
                           editora (early-return iznad). */
                        onContentError={({ error }) => {
                            console.error(
                                "[SuperDoc] content parse error",
                                error,
                            );
                            setContentError(
                                "Dokument nije moguće prikazati — datoteka je možda oštećena ili u nepodržanom formatu.",
                            );
                        }}
                        /* SuperDoc-ov interno catch-all za exception-e
                           koje on sam baca tijekom dispatch-a transakcija
                           (npr. InvalidStateError iz `disableTrackChanges
                           ShowOriginal` poziva). Bez ovog handler-a, oni
                           bubble-aju u window.onerror i okidaju naš
                           ErrorBoundary. S handler-om SuperDoc ih
                           preusmjerava u callback i nastavlja rad. */
                        onException={({ error }) =>
                            console.warn(
                                "[SuperDoc] internal exception",
                                error,
                            )
                        }
                        className="h-full"
                    />
                )}
                {(!editorReady || loading || saving) && (
                    <div
                        className="absolute inset-0 z-30 flex items-center justify-center bg-muted"
                        aria-busy="true"
                        aria-live="polite"
                        data-superdoc-loading="true"
                    >
                        <MikeIcon spin mike size={28} />
                    </div>
                )}
                {panelOpen && editorReady && (
                    <TrackChangesBubble
                        items={trackChanges}
                        onClose={() => setPanelOpen(false)}
                        onScrollTo={handleScrollToChange}
                        onDecide={handleDecide}
                        resolvingIds={resolvingIds}
                    />
                )}
                {/* Draft Mode Overlay — renderira se samo kad je draftModeEnabled */}
                {draftModeEnabled && editorReady && (
                    <DraftModeOverlay
                        documentId={documentId}
                        superdocRef={superdocRef}
                        onEditApplied={onDraftEditApplied}
                    />
                )}
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────
//  Draft Mode Overlay
// ──────────────────────────────────────────────────────────────────────
function DraftModeOverlay({
    documentId,
    superdocRef,
    onEditApplied,
}: {
    documentId: string;
    superdocRef: React.RefObject<SuperDocInstance | null>;
    onEditApplied?: (result: DraftSelectionEditResult) => void;
}) {
    const { pendingSelection, isSubmitting, lastError, setSelection, clearSelection, submitEdit } =
        useDraftMode();

    // Čitamo selekciju na mouseup unutar SuperDoc wrappera
    useEffect(() => {
        const onMouseUp = () => {
            // Mali delay da browser finalizira selekciju
            requestAnimationFrame(() => {
                const sdoc = superdocRef.current;
                const windowSel = window.getSelection();
                const selectedText = windowSel?.toString().trim() ?? "";

                if (!selectedText || selectedText.length < 3) {
                    if (!isSubmitting) setSelection(null);
                    return;
                }

                // Pozicioniranje: pokušaj SuperDoc API-ja, fallback na Range
                let anchorRect = { top: 0, left: 0, width: 0, height: 0 };
                try {
                    // SuperDoc 1.8 exposes ui on the instance
                    const sdocUi = (sdoc as unknown as { ui?: { selection?: { getAnchorRect?: (o: { placement: string }) => { top: number; left: number; width: number; height: number } | null } } })?.ui;
                    const rect = sdocUi?.selection?.getAnchorRect?.({ placement: "end" });
                    if (rect) {
                        anchorRect = rect;
                    } else if (windowSel && windowSel.rangeCount > 0) {
                        const domRect = windowSel.getRangeAt(0).getBoundingClientRect();
                        anchorRect = {
                            top: domRect.top,
                            left: domRect.left,
                            width: domRect.width,
                            height: domRect.height,
                        };
                    }
                } catch {
                    if (windowSel && windowSel.rangeCount > 0) {
                        const domRect = windowSel.getRangeAt(0).getBoundingClientRect();
                        anchorRect = {
                            top: domRect.top,
                            left: domRect.left,
                            width: domRect.width,
                            height: domRect.height,
                        };
                    }
                }

                setSelection({
                    selectedText,
                    contextBefore: "",
                    contextAfter: "",
                    anchorRect,
                    documentId,
                });
            });
        };

        document.addEventListener("mouseup", onMouseUp);
        return () => document.removeEventListener("mouseup", onMouseUp);
    }, [documentId, isSubmitting, setSelection, superdocRef]);

    if (!pendingSelection) return null;

    return (
        <DraftSelectionPopup
            selection={pendingSelection}
            isSubmitting={isSubmitting}
            lastError={lastError}
            onSubmit={(instruction) => {
                void submitEdit(instruction, (result) => {
                    onEditApplied?.(result);
                    clearSelection();
                });
            }}
            onDismiss={clearSelection}
        />
    );
}

// ──────────────────────────────────────────────────────────────────────
//  Pomični (draggable) panel s tracked changes.
//
//  Zamjena za SuperDoc-ov native sidebar koji nam je zauzimao prevelik
//  dio ekrana (Explorer + dokument + sidebar + Mike chat = 4 paralelna
//  panela, vidi screenshot 2026-05-25 08:43). Ovaj bubble:
//
//    • lebdi preko dokumenta (absolute, z-20),
//    • drag-a se hvatanjem za vrh (header funkcionira kao drag handle),
//    • clamp-a se na granice wrapper-a tako da ga korisnik ne može
//      izvući van vidnog polja,
//    • klik na item scroll-a SuperDoc na taj change (preko
//      superdoc.scrollToElement, isti API koji koristimo za chat
//      highlight),
//    • per-item Prihvati/Odbij gumbi pozivaju
//      editor.doc.trackChanges.decide() što za LLM-generirane changes
//      ne sync-a još s document_edits tablicom (to dolazi u Fazi 2.1
//      preko bridge endpointa) — za sada vrijedi: lokalna odluka,
//      `Spremi` upload-a novu verziju u GCS pa Mike chat učita stanje.
// ──────────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
    insert: "Dodano",
    delete: "Obrisano",
    format: "Formatiranje",
    replacement: "Zamjena",
};

/**
 * SuperDoc upiše "Default SuperDoc user" kao `w:author` kad god mu
 * `user` prop nedostaje u trenutku promjene — što vrijedi za:
 *  (a) sve LLM-generirane prijedloge (backend ih ubacuje izravno u
 *      DOCX XML pa nikad ne prolaze kroz SuperDoc user pipeline),
 *  (b) sve promjene napravljene PRIJE no što je `user` prop dodan
 *      ovom view-u (postojeći DOCX-i u GCS-u).
 *
 * U bubble panelu taj string nije informativan i samo zauzima prostor
 * (i konfuzno izgleda korisniku — "tko je Default SuperDoc user?"). LLM
 * prijedloge već vizualno odvajamo "Mike" badge-om, a za korisničke
 * promjene `user` prop sada ispravno postavlja autora. Tako da:
 *   • LLM (dbEditId !== null) → autor uvijek sakriven (Mike badge je
 *     dovoljna naznaka izvora),
 *   • placeholder string → sakriven,
 *   • ostalo → prikazan.
 */
const DEFAULT_AUTHOR_RE = /^default\s+superdoc\s+user$/i;
function shouldShowAuthor(
    author: string | undefined,
    isMike: boolean,
): boolean {
    if (isMike) return false;
    if (!author) return false;
    return !DEFAULT_AUTHOR_RE.test(author.trim());
}

function TrackChangesBubble({
    items,
    onClose,
    onScrollTo,
    onDecide,
    resolvingIds,
}: {
    items: TrackChangeItem[];
    onClose: () => void;
    onScrollTo: (id: string) => void;
    onDecide: (id: string, decision: "accept" | "reject") => void;
    resolvingIds: Set<string>;
}) {
    const bubbleRef = useRef<HTMLDivElement>(null);
    const dragStateRef = useRef<{
        startX: number;
        startY: number;
        originLeft: number;
        originTop: number;
    } | null>(null);
    // Inicijalna pozicija — top-right unutar wrapper-a. State je u
    // pikselima relativno na wrapper (parent koji je `relative`).
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

    useLayoutEffect(() => {
        const bubble = bubbleRef.current;
        const parent = bubble?.offsetParent as HTMLElement | null;
        if (!bubble || !parent) return;
        if (pos !== null) return;
        const parentRect = parent.getBoundingClientRect();
        const bubbleWidth = bubble.offsetWidth;
        setPos({
            top: 16,
            left: Math.max(16, parentRect.width - bubbleWidth - 16),
        });
    }, [pos]);

    const onDragStart = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            const bubble = bubbleRef.current;
            if (!bubble || pos === null) return;
            e.preventDefault();
            dragStateRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                originLeft: pos.left,
                originTop: pos.top,
            };

            const onMove = (ev: MouseEvent) => {
                const drag = dragStateRef.current;
                const parent = bubble.offsetParent as HTMLElement | null;
                if (!drag || !parent) return;
                const dx = ev.clientX - drag.startX;
                const dy = ev.clientY - drag.startY;
                const maxLeft = parent.clientWidth - bubble.offsetWidth;
                const maxTop = parent.clientHeight - bubble.offsetHeight;
                setPos({
                    left: Math.max(0, Math.min(maxLeft, drag.originLeft + dx)),
                    top: Math.max(0, Math.min(maxTop, drag.originTop + dy)),
                });
            };
            const onUp = () => {
                dragStateRef.current = null;
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        },
        [pos],
    );

    return (
        <div
            ref={bubbleRef}
            className="absolute z-20 flex max-h-[70%] w-[320px] flex-col rounded-lg border border-border bg-surface-elevated"
            style={{
                top: pos?.top ?? 16,
                left: pos?.left ?? 16,
                visibility: pos === null ? "hidden" : undefined,
            }}
            role="dialog"
            aria-label="Tracked changes"
        >
            <div
                onMouseDown={onDragStart}
                className="flex cursor-grab items-center justify-between gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
            >
                <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <GripVertical className="h-3.5 w-3.5 text-muted-foreground/70" />
                    Promjene
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {items.length}
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    aria-label="Zatvori panel"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {items.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">
                        Nema nerazriješenih promjena.
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {items.map((it) => (
                            <li
                                key={it.id}
                                className="group flex flex-col gap-1.5 px-3 py-2 hover:bg-accent"
                            >
                                <button
                                    type="button"
                                    onClick={() => onScrollTo(it.id)}
                                    className="flex flex-col items-start gap-0.5 text-left"
                                >
                                    <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {TYPE_LABEL[it.type] ?? it.type}
                                        {shouldShowAuthor(
                                            it.author,
                                            Boolean(it.dbEditId),
                                        ) && (
                                            <span className="text-muted-foreground/70">
                                                · {it.author}
                                            </span>
                                        )}
                                        {it.dbEditId && (
                                            <span className="rounded-sm bg-success/10 px-1 py-px text-[9px] font-bold tracking-normal text-success">
                                                Mike
                                            </span>
                                        )}
                                    </span>
                                    {it.excerpt && (
                                        <span className="line-clamp-2 text-xs text-foreground">
                                            {it.excerpt}
                                        </span>
                                    )}
                                </button>
                                <div className="flex justify-end gap-1.5">
                                    {(() => {
                                        const isResolving = resolvingIds.has(
                                            it.id,
                                        );
                                        return (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onDecide(
                                                            it.id,
                                                            "reject",
                                                        )
                                                    }
                                                    disabled={isResolving}
                                                    aria-busy={isResolving}
                                                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                                        isResolving
                                                            ? "cursor-not-allowed border-border text-muted-foreground/70"
                                                            : "border-border text-muted-foreground hover:border-destructive/20 hover:bg-destructive/10 hover:text-destructive"
                                                    }`}
                                                >
                                                    {isResolving && (
                                                        <MikeIcon
                                                            spin
                                                            mike
                                                            size={10}
                                                        />
                                                    )}
                                                    Odbij
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onDecide(
                                                            it.id,
                                                            "accept",
                                                        )
                                                    }
                                                    disabled={isResolving}
                                                    aria-busy={isResolving}
                                                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                                                        isResolving
                                                            ? "cursor-not-allowed border-primary/40 bg-primary/40 text-primary-foreground"
                                                            : "border-primary bg-primary text-primary-foreground hover:bg-primary/90"
                                                    }`}
                                                >
                                                    {isResolving && (
                                                        <MikeIcon
                                                            spin
                                                            mike
                                                            size={10}
                                                        />
                                                    )}
                                                    Prihvati
                                                </button>
                                            </>
                                        );
                                    })()}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
