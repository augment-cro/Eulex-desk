/**
 * Documents that belong to a Custom Context (e.g. AZOP's AI guidance PDFs in
 * the EULEX "EU AI Governance" system context).
 *
 * They live in the ordinary documents pipeline (storage, text, pages,
 * citations, PII-at-read) under the reserved owner SYSTEM_CONTEXT_OWNER (a
 * fixed UUID no user has). The context provider returns them as sources of kind
 * "document" whose id is the core document id; while such a context is
 * active, the chat turn adds them to its available documents, so the model
 * reads and cites them like any attached file. Access is granted by the
 * provider's resolve (it only returns contexts the caller may use), and only
 * documents under the reserved owner are ever added this way.
 */
import type { DocIndex, DocStore } from "../chatTools";
import { attachActiveVersionPaths } from "../documentVersions";
import { orderForPrompt, type ResolvedContext, type UnavailableContextItem } from "./contextsRuntime";
import { SYSTEM_CONTEXT_OWNER } from "./contextOwner";

export { SYSTEM_CONTEXT_OWNER } from "./contextOwner";

/**
 * documents.user_id references users(id), so the reserved owner needs a
 * users row. It is created on first ingest with an EMPTY e-mail — the Brevo
 * backfill and every e-mail flow skip it, and it has no tier state, so no
 * billing or membership job touches it. Idempotent.
 */
export async function ensureSystemContextOwner(db: unknown): Promise<void> {
    const sb = db as {
        from(t: string): {
            upsert(row: Record<string, unknown>, o: { onConflict: string }): PromiseLike<{ error: unknown }>;
        };
    };
    const { error } = await sb
        .from("users")
        .upsert(
            { id: SYSTEM_CONTEXT_OWNER, email: "", display_name: "EULEX · sistemski konteksti" },
            { onConflict: "id" },
        );
    if (error) throw error instanceof Error ? error : new Error(String(error));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Document sources the active contexts expose (kind "document") with the
 * provider's label, in pack order: contexts in prompt order, each context's
 * sources in the order the provider lists them, first occurrence wins.
 * Deterministic, and the doc-N labels and AVAILABLE DOCUMENTS follow the
 * pack (a chapter map listed first is the first context document, not
 * wherever its UUID sorts).
 */
export function contextDocumentSources(
    active: ResolvedContext[] | undefined,
): { id: string; label: string }[] {
    const labels = new Map<string, string>();
    for (const r of orderForPrompt(active ?? [])) {
        // Only EULEX system contexts carry documents, and ids must be UUIDs —
        // one malformed id would fail the whole lookup.
        if (r.level !== "system") continue;
        for (const s of r.sources ?? []) {
            if (s.kind === "document" && s.id && UUID_RE.test(s.id) && !labels.has(s.id)) {
                labels.set(s.id, s.label?.trim() ?? "");
            }
        }
    }
    return [...labels].map(([id, label]) => ({ id, label }));
}

/** Document ids the active contexts expose, in pack order (see above). */
export function contextDocumentIds(active: ResolvedContext[] | undefined): string[] {
    return contextDocumentSources(active).map((s) => s.id);
}

// Minimal structural type of the Supabase-compatible client used here.
type Db = {
    from(table: string): {
        select(cols: string): {
            in(col: string, vals: string[]): {
                eq(col: string, val: string): {
                    eq(col: string, val: string): PromiseLike<{ data: unknown[] | null }>;
                };
            };
        };
    };
};

/**
 * Add the active contexts' documents to the turn's document index/store,
 * labelled after the documents already there (doc-N continues). Fails soft:
 * a lookup error leaves the turn with its own documents only. Every listed
 * document that does not join (not found, not ready, no stored file, lookup
 * error) is reported to `unavailable` under its source label.
 */
export async function addContextDocuments(params: {
    docIndex: DocIndex;
    docStore: DocStore;
    active: ResolvedContext[] | undefined;
    db: unknown;
    /** Collects the context documents this turn runs without (pack order). */
    unavailable?: UnavailableContextItem[];
}): Promise<void> {
    const sources = contextDocumentSources(params.active).filter(
        (s) => !Object.values(params.docIndex).some((d) => d.document_id === s.id),
    );
    const ids = sources.map((s) => s.id);
    if (ids.length === 0) return;
    const joined = new Set<string>();
    const filenames = new Map<string, string>();
    try {
        const db = params.db as Db;
        const { data } = await db
            .from("documents")
            .select("id, filename, file_type, current_version_id, status")
            .in("id", ids)
            .eq("user_id", SYSTEM_CONTEXT_OWNER)
            .eq("status", "ready");
        const docs = (data ?? []) as {
            id: string;
            filename: string;
            file_type: string;
            current_version_id?: string | null;
            active_version_number?: number | null;
            storage_path?: string | null;
        }[];
        docs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        for (const doc of docs) filenames.set(doc.id, doc.filename);
        await attachActiveVersionPaths(params.db as never, docs);
        let n = Object.keys(params.docIndex).length;
        for (const doc of docs) {
            if (!doc.storage_path) continue;
            let label = `doc-${n++}`;
            while (params.docIndex[label]) label = `doc-${n++}`;
            params.docIndex[label] = {
                document_id: doc.id,
                filename: doc.filename,
                version_id: doc.current_version_id ?? null,
                version_number: doc.active_version_number ?? null,
                // Shared by every user of the context: never editable from chat.
                read_only: true,
            };
            params.docStore.set(label, {
                storage_path: doc.storage_path,
                file_type: doc.file_type,
                filename: doc.filename,
            });
            joined.add(doc.id);
        }
    } catch (err) {
        console.warn(
            "[contexts] context documents lookup failed (non-fatal):",
            err instanceof Error ? err.message : err,
        );
    }
    const missing = sources.filter((s) => !joined.has(s.id));
    if (missing.length === 0) return;
    console.warn(
        `[contexts] context documents not available this turn: ${missing.map((s) => s.id).join(", ")}`,
    );
    for (const s of missing) {
        params.unavailable?.push({
            kind: "document",
            name: s.label || filenames.get(s.id) || s.id,
        });
    }
}
