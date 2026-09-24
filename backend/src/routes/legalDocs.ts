import { Router } from "express";
import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import { requireAuth } from "../middleware/auth";

/**
 * Cross-service proxy to the EULEX legal backends (EU / HR / FR / SI / DE) so
 * the browser never calls them directly (CORS + keeps any service credential
 * server-side). Each jurisdiction is a separate Cloud Run service sharing the
 * `/api/v1` prefix but on different base URLs; we route by `scope`, forward
 * the MCP-provided `backend_fetch` path (SSRF-allowlisted), then normalize the
 * per-jurisdiction response shapes into one `{ title, articles[] }` the panel
 * renders.
 */
export const legalDocsRouter = Router();

type Scope = "@eu" | "@hr" | "@fr" | "@si" | "@de";

type NormalizedArticle = {
    id: string;
    label: string | null;
    /** Bare article number ("5", "L225-102-1") for language-independent
     *  scroll-to-article when the cited quote can't be text-matched. */
    number: string | null;
    text: string;
    /** HR full-document only: the source `segment_type` (article_heading,
     *  stavak, section_heading, …) so the panel can render the proper
     *  hierarchy and group body segments under their article. */
    segmentType?: string | null;
};
type NormalizedDocument = {
    title: string;
    articles: NormalizedArticle[];
    /** Law-level citation for the panel header (e.g. the consolidated NN
     *  gazette references). HR full-document only. */
    citation?: string | null;
    /** All gazette (NN) references for the regulation's versions, newest first,
     *  for "all versions" display under the title. HR full-document only. */
    gazetteRefs?: string[];
};

/** Upstream base URLs + optional bearer tokens, per scope, from env. */
function upstreamFor(scope: Scope): { base: string | null; token?: string } {
    switch (scope) {
        case "@eu":
            return {
                base: process.env.EULEX_EU_API_BASE?.trim() || null,
                token: process.env.EULEX_EU_API_TOKEN?.trim() || undefined,
            };
        case "@hr":
            return {
                base: process.env.EULEX_HR_API_BASE?.trim() || null,
                token: process.env.EULEX_HR_API_TOKEN?.trim() || undefined,
            };
        case "@fr":
            return {
                base: process.env.EULEX_FR_API_BASE?.trim() || null,
                token: process.env.EULEX_FR_API_TOKEN?.trim() || undefined,
            };
        case "@si":
            return {
                base: process.env.EULEX_SI_API_BASE?.trim() || null,
                token: process.env.EULEX_SI_API_TOKEN?.trim() || undefined,
            };
        case "@de":
            return {
                base: process.env.EULEX_DE_API_BASE?.trim() || null,
                token: process.env.EULEX_DE_API_TOKEN?.trim() || undefined,
            };
    }
}

// Only these `/api/v1/...` shapes may be proxied — no arbitrary host/path.
const ALLOWED_PATH_RE =
    /^\/api\/v1\/(documents\/|regulations\/|caselaw\/|articles(\?|$))/;

function isSafePath(path: string): boolean {
    if (!path.startsWith("/api/v1/")) return false;
    if (path.includes("..") || path.includes("//")) return false;
    return ALLOWED_PATH_RE.test(path);
}

// Temporal params forwarded to the HR upstream (point-in-time view). Strict
// shapes — anything else is dropped, never proxied.
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `&version_id=…` / `&as_of=…` suffix for upstream HR content fetches
 *  ("" when neither temporal param was given — the current in-force text). */
function temporalQuery(versionId: string | null, asOf: string | null): string {
    if (versionId) return `&version_id=${encodeURIComponent(versionId)}`;
    if (asOf) return `&as_of=${encodeURIComponent(asOf)}`;
    return "";
}

// HR/FR Cloud Run services are deployed `--no-allow-unauthenticated`, so they
// need a Google-signed ID token whose audience is the service URL (the same
// thing the MCP servers do server-to-server). EU is public. Resolution order:
//   1. EULEX_<SCOPE>_API_TOKEN env — manual override / escape hatch.
//   2. A minted Google ID token for `audience` via the runtime service account
//      (which must hold roles/run.invoker on the target service).
//   3. No auth — fine for public EU; HR/FR will 401/403 (logged once).
let googleAuth: GoogleAuth | null = null;
const idTokenClients = new Map<string, IdTokenClient>();
const authWarned = new Set<string>();

async function authHeaders(
    audience: string,
    staticToken?: string,
): Promise<Record<string, string>> {
    if (staticToken) return { Authorization: `Bearer ${staticToken}` };
    try {
        if (!googleAuth) googleAuth = new GoogleAuth();
        let client = idTokenClients.get(audience);
        if (!client) {
            client = await googleAuth.getIdTokenClient(audience);
            idTokenClients.set(audience, client);
        }
        const reqHeaders = await client.getRequestHeaders();
        // google-auth-library returns a Fetch `Headers` instance.
        const auth =
            typeof (reqHeaders as Headers).get === "function"
                ? (reqHeaders as Headers).get("Authorization")
                : (reqHeaders as unknown as Record<string, string>)
                      .Authorization;
        return auth ? { Authorization: auth } : {};
    } catch (err) {
        if (!authWarned.has(audience)) {
            authWarned.add(audience);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
                `[legalDocs] no ID token for ${audience} (ok for public EU; HR/FR need run.invoker): ${msg}`,
            );
        }
        return {};
    }
}

async function fetchJson(
    url: string,
    headers: Record<string, string>,
): Promise<unknown> {
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
        throw new Error(`upstream ${resp.status}`);
    }
    return resp.json();
}

function str(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
}
function arr(v: unknown): Record<string, unknown>[] {
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * Bare article number from a label — handles suffixed HR articles written as
 * "Članak 17.a" / "Članak 17. a" / "Članak 17a" (all → "17a"). Normalization
 * (strip dots/whitespace, lowercase) MUST stay byte-identical to the
 * frontend's `normalizeArticleNumber` (legalSourceUtils.ts): the panel marks
 * cited articles by comparing these `number` values to the frontend's
 * normalized cited numbers.
 */
function extractArticleNumber(label: string | null | undefined): string | null {
    if (!label) return null;
    const raw = label.match(/\d+(?:\.?\s?[a-z](?![a-z]))?/i)?.[0];
    return raw ? raw.replace(/[.\s]/g, "").toLowerCase() : null;
}

// ---- per-jurisdiction normalizers ----------------------------------------

function normalizeEu(data: Record<string, unknown>): NormalizedDocument {
    const sections = arr(data.sections);
    const articles: NormalizedArticle[] = [];
    for (const s of sections) {
        const text = str(s.section_text);
        if (!text) continue;
        const number = str(s.section_number);
        const name = str(s.section_name);
        // section_name is the article's TITLE ("Definitions"), not "Article N".
        const label = number
            ? `Article ${number}${name ? ` — ${name}` : ""}`
            : (name ?? "Preamble");
        articles.push({
            id: String(s.section_id ?? s.id ?? articles.length),
            label,
            number,
            text,
        });
    }
    return { title: str(data.title) ?? "", articles };
}

function normalizeHrArticle(data: Record<string, unknown>): NormalizedDocument {
    const segments = arr(data.segments);
    const text = segments
        .map((s) => str(s.content_text))
        .filter((t): t is string => !!t)
        .join("\n\n");
    const label = str(data.article_label) ?? str(data.normalized_label);
    const number = extractArticleNumber(label);
    return {
        title: str(data.citation) ?? label ?? "",
        articles: text
            ? [{ id: label ?? "article", label, number, text }]
            : [],
    };
}

function normalizeHrDecision(
    meta: Record<string, unknown>,
    textResp: Record<string, unknown>,
): NormalizedDocument {
    const segments = arr(textResp.segments);
    const text = segments
        .map((s) => str(s.content_text))
        .filter((t): t is string => !!t)
        .join("\n\n");
    const title =
        str(meta.citation) ??
        str(meta.decision_number) ??
        str(meta.ecli) ??
        "Sudska odluka";
    return {
        title,
        articles: text
            ? [{ id: String(meta.id ?? "decision"), label: null, number: null, text }]
            : [],
    };
}

function normalizeHrRegulation(
    meta: Record<string, unknown>,
    structure: Record<string, unknown>,
): NormalizedDocument {
    // Whole-law citation: the HR API has no single full-text endpoint, so we
    // render an overview — abstract + the article table-of-contents (heading
    // per article). Each article is fetchable individually via /article/{label}.
    const items = arr(structure.items);
    const articles: NormalizedArticle[] = [];
    const abstract = str(meta.abstract);
    if (abstract) {
        articles.push({ id: "abstract", label: null, number: null, text: abstract });
    }
    for (const it of items) {
        const text = str(it.content_text);
        if (!text) continue;
        const label = str(it.label) ?? str(it.normalized_label);
        articles.push({
            id: String(it.id ?? articles.length),
            label,
            number: extractArticleNumber(label),
            text,
        });
    }
    return { title: str(meta.title) ?? "", articles };
}

/**
 * `hr_get_full_document` (MCP) → normalized whole-law document.
 *
 * The tool returns the WHOLE consolidated regulation as a linear `segments[]`
 * list (each an article/paragraph in `ordinal` order) plus denormalized
 * `full_text`/`full_html`. We render one `NormalizedArticle` per segment so the
 * panel shows the complete law and can mark + scroll to each cited article by
 * `number`. Falls back to nothing (caller keeps the TOC overview) when the
 * payload carries neither segments nor full text.
 */
function normalizeHrFullDocument(
    data: Record<string, unknown>,
): NormalizedDocument {
    const title = str(data.title) ?? str(data.citation) ?? "";
    const segments = arr(data.segments);
    const articles: NormalizedArticle[] = [];
    // Propagate the current article's number onto its body segments (stavak,
    // tocka, …) so the panel can mark + scroll the WHOLE article, not just its
    // heading line. Reset at every article_heading and at higher-level headings.
    let currentArticleNum: string | null = null;
    for (const s of segments) {
        const text = str(s.content_text) ?? str(s.content_html);
        if (!text) continue;
        const segmentType = str(s.segment_type);
        const label = str(s.label) ?? str(s.normalized_label);
        // Prefer the normalized label for number extraction — it's the stable,
        // language-independent form the panel's scroll-to-article keys on.
        const numberSrc = str(s.normalized_label) ?? label;
        const ownNum = extractArticleNumber(numberSrc);
        if (segmentType === "article_heading") {
            currentArticleNum = ownNum;
        } else if (segmentType && /_heading$/.test(segmentType)) {
            // part/chapter/section heading — leaves article scope.
            currentArticleNum = null;
        }
        articles.push({
            id: String(s.id ?? s.ordinal ?? articles.length),
            label,
            number: ownNum ?? currentArticleNum,
            text,
            segmentType,
        });
    }
    // No segments (include_segments was false or empty) — fall back to the
    // single denormalized full_text blob so the panel still shows the law.
    if (articles.length === 0) {
        const fullText = str(data.full_text);
        if (fullText) {
            articles.push({ id: "full", label: null, number: null, text: fullText });
        }
    }
    return {
        title,
        articles,
        citation: str(data.citation),
        gazetteRefs: extractGazetteRefs(data),
    };
}

/**
 * Collect all Narodne-novine references for the regulation's versions, newest
 * first, deduped — e.g. ["NN 156/2023", "NN 49/2023", …]. Scans likely amendment
 * / version arrays plus any consolidated citation string. Best-effort: the panel
 * falls back to the single version citation when nothing is found.
 */
function extractGazetteRefs(data: Record<string, unknown>): string[] {
    const refs: string[] = [];
    const push = (s: string | null) => {
        if (s) for (const m of s.match(/NN\s*\d+\/\d+/gi) ?? []) refs.push(m);
    };
    // Structured amendment/version lists under any of these keys.
    for (const key of ["amendments", "versions", "gazette_references", "nn_references"]) {
        for (const it of arr(data[key])) {
            push(str(it.citation) ?? str(it.gazette) ?? str(it.nn) ?? str(it.reference));
            if (typeof it === "string") push(it as unknown as string);
        }
    }
    // Plain string fields that may carry a consolidated "NN a/b, c/d" header.
    push(str(data.gazette_history) ?? str(data.consolidated_citation));
    // Dedup, preserve first-seen order; normalize spacing ("NN156/23" → "NN 156/23").
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of refs) {
        const norm = r.replace(/NN\s*/i, "NN ");
        if (!seen.has(norm)) {
            seen.add(norm);
            out.push(norm);
        }
    }
    return out;
}

function normalizeFr(data: Record<string, unknown>): NormalizedDocument {
    const text = str(data.content) ?? "";
    const articleNumber = str(data.article_number);
    const title =
        str(data.citation) ??
        [str(data.code_title), articleNumber].filter(Boolean).join(" ");
    return {
        title,
        articles: text
            ? [
                  {
                      id: articleNumber ?? "article",
                      label: articleNumber,
                      number: articleNumber,
                      text,
                  },
              ]
            : [],
    };
}

/**
 * SI/DE `ArticleResponse` (`/api/v1/regulations/{key}/article/{label}`) →
 * one-article document. Both eulex_endpoint country APIs share the shape:
 * { title, title_short, label, heading, text, citation, … }.
 */
export function normalizeCountryArticle(
    data: Record<string, unknown>,
): NormalizedDocument {
    const label = str(data.label) ?? str(data.normalized_label);
    const text = [str(data.heading), str(data.text)]
        .filter((t): t is string => !!t)
        .join("\n\n");
    const title =
        str(data.citation) ??
        [str(data.title_short) ?? str(data.title), label]
            .filter(Boolean)
            .join(", ");
    return {
        title,
        citation: str(data.citation),
        articles: text
            ? [
                  {
                      id: label ?? "article",
                      label,
                      number: extractArticleNumber(str(data.label)),
                      text,
                  },
              ]
            : [],
    };
}

/**
 * SI/DE `/full-document?include_provisions=true` → whole-act document, one
 * row per provision, mapped onto the HR segment vocabulary the panel's
 * `groupLegalSegments` folds on:
 *  - structural rows (part/chapter/…)          → "section_heading" divider;
 *  - article-TITLE rows (an `article` row with a label but no body text —
 *    the SI/DE data model puts the title on its own row just before the
 *    numbered article, exactly like HR's `article_subtitle`) → buffered
 *    subtitle;
 *  - numbered articles with text → no segmentType, so each renders as its
 *    own article card (label + body).
 */
export function normalizeCountryFullDocument(
    data: Record<string, unknown>,
): NormalizedDocument {
    const provisions = arr(data.provisions);
    const articles: NormalizedArticle[] = [];
    for (const [i, p] of provisions.entries()) {
        const type = str(p.provision_type);
        const label = str(p.label) ?? str(p.heading);
        const text = str(p.text)?.trim() ?? "";
        if (!label && !text) continue;
        let segmentType: string | null = null;
        if (type !== "article" && type !== "content" && !text) {
            segmentType = "section_heading";
        } else if (type === "article" && !text) {
            segmentType = "article_subtitle";
        }
        articles.push({
            id: str(p.path) ?? `prov-${i}`,
            label,
            number: extractArticleNumber(str(p.label)),
            text,
            segmentType,
        });
    }
    return {
        title: str(data.title) ?? str(data.title_short) ?? "",
        citation: str(data.citation),
        articles,
    };
}

/**
 * Fetch a whole HR regulation's FULL consolidated text via the HR API's
 * `/full-document` endpoint — the only source that returns the article bodies
 * (the `/structure` TOC returns headings only). Returns the normalized document
 * with one article per segment, or null on failure / empty so the caller falls
 * back to the TOC overview. Uses the same ID-token auth as the rest of the proxy.
 */
async function fetchHrFullDocument(
    base: string,
    regulationPath: string,
    headers: Record<string, string>,
    temporal = "",
): Promise<NormalizedDocument | null> {
    // Big laws (~400 KB) — `mixed` gives both text+html, `include_segments`
    // returns the per-article rows the panel keys its marking/scroll on.
    const url = `${base}${regulationPath}/full-document?format=mixed&include_segments=true${temporal}`;
    try {
        const data = (await fetchJson(url, headers)) as Record<string, unknown>;
        const doc = normalizeHrFullDocument(data);
        if (doc.articles.length === 0) {
            console.warn(
                `[legalDocs] full-document empty for ${regulationPath}; keys=${Object.keys(data).join(",")}`,
            );
            return null;
        }
        return doc;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[legalDocs] full-document failed for ${regulationPath}: ${msg}`);
        return null;
    }
}

// GET /legal-docs?scope=@hr&path=/api/v1/regulations/{uuid}/article/{label}
//   [&version_id={uuid} | &as_of=YYYY-MM-DD]   (HR point-in-time view)
legalDocsRouter.get("/", requireAuth, async (req, res) => {
    const scope = String(req.query.scope ?? "") as Scope;
    const path = String(req.query.path ?? "");
    const rawVersionId = String(req.query.version_id ?? "");
    const rawAsOf = String(req.query.as_of ?? "");
    const versionId = UUID_RE.test(rawVersionId) ? rawVersionId : null;
    const asOf = AS_OF_RE.test(rawAsOf) ? rawAsOf : null;

    if (!["@eu", "@hr", "@fr", "@si", "@de"].includes(scope)) {
        return void res.status(400).json({ detail: "Invalid scope" });
    }
    if (!isSafePath(path)) {
        return void res.status(400).json({ detail: "Invalid or disallowed path" });
    }

    const { base, token } = upstreamFor(scope);
    if (!base) {
        return void res
            .status(503)
            .json({ detail: `No upstream configured for ${scope}` });
    }

    try {
        const headers = await authHeaders(base, token);

        // EU: ask for sections so we get the article texts.
        let fetchPath = path;
        if (scope === "@eu" && !/[?&]include_sections=/.test(fetchPath)) {
            fetchPath += (fetchPath.includes("?") ? "&" : "?") +
                "include_sections=true";
        }

        let doc: NormalizedDocument;
        if (scope === "@eu") {
            const data = (await fetchJson(
                `${base}${fetchPath}`,
                headers,
            )) as Record<string, unknown>;
            doc = normalizeEu(data);
        } else if (scope === "@fr") {
            const data = (await fetchJson(
                `${base}${fetchPath}`,
                headers,
            )) as Record<string, unknown>;
            doc = normalizeFr(data);
        } else if (scope === "@si" || scope === "@de") {
            if (/\/article\//.test(path)) {
                // Single provision — the MCP's backend_fetch path as-is.
                const data = (await fetchJson(
                    `${base}${path}`,
                    headers,
                )) as Record<string, unknown>;
                doc = normalizeCountryArticle(data);
            } else {
                // Whole-act citation — full consolidated text, one row per
                // provision; fall back to bare act metadata on any miss.
                try {
                    const data = (await fetchJson(
                        `${base}${path}/full-document?include_provisions=true&format=text&max_chars=0`,
                        headers,
                    )) as Record<string, unknown>;
                    doc = normalizeCountryFullDocument(data);
                } catch {
                    const meta = (await fetchJson(
                        `${base}${path}`,
                        headers,
                    )) as Record<string, unknown>;
                    doc = normalizeCountryArticle(meta);
                }
            }
        } else {
            // HR — caselaw needs a separate /text call for the body segments.
            const isCaselaw = /\/api\/v1\/caselaw\//.test(path) &&
                !/\/article\//.test(path);
            if (isCaselaw) {
                const [meta, textResp] = await Promise.all([
                    fetchJson(`${base}${path}`, headers) as Promise<
                        Record<string, unknown>
                    >,
                    fetchJson(`${base}${path}/text`, headers) as Promise<
                        Record<string, unknown>
                    >,
                ]);
                doc = normalizeHrDecision(meta, textResp);
            } else if (/\/article\//.test(path)) {
                // Single article — full segment text.
                const sep = path.includes("?") ? "&" : "?";
                const temporal = temporalQuery(versionId, asOf);
                const data = (await fetchJson(
                    `${base}${path}${temporal ? sep + temporal.slice(1) : ""}`,
                    headers,
                )) as Record<string, unknown>;
                doc = normalizeHrArticle(data);
            } else {
                // Whole-law citation (/regulations/{uuid}, no article). First
                // try the `/full-document` endpoint for the FULL consolidated
                // text (article bodies); fall back to the metadata + /structure
                // TOC overview on any miss — but NEVER when a historical
                // version was requested: the fallback would silently show the
                // CURRENT text as if it were the selected version.
                const temporal = temporalQuery(versionId, asOf);
                const full = await fetchHrFullDocument(
                    base,
                    path,
                    headers,
                    temporal,
                );
                if (full) {
                    doc = full;
                } else if (temporal) {
                    return void res.status(502).json({
                        detail: "Version text unavailable",
                    });
                } else {
                    const [meta, structure] = await Promise.all([
                        fetchJson(`${base}${path}`, headers) as Promise<
                            Record<string, unknown>
                        >,
                        fetchJson(`${base}${path}/structure`, headers) as Promise<
                            Record<string, unknown>
                        >,
                    ]);
                    doc = normalizeHrRegulation(meta, structure);
                }
            }
        }

        res.json(doc);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[legalDocs] proxy failed scope=${scope} path=${path}: ${msg}`);
        res.status(502).json({ detail: "Failed to fetch legal document" });
    }
});

// ---- version timeline ------------------------------------------------------

type NormalizedVersion = {
    /** regulation_versions.id — pass back as `version_id` to view this text. */
    id: string;
    /** Owning regulation id — may differ from the requested one (lineage
     *  fragmentation: one law = several regulation rows over its history). */
    regulationId: string;
    versionNumber: number | null;
    /** not_in_force | in_force | future */
    status: string | null;
    enterIntoForce: string | null;
    applicationDate: string | null;
    endDate: string | null;
    /** "NN 64/2023" — the gazette issue that introduced this version. */
    nnReference: string | null;
    eliUrl: string | null;
};

function normalizeHrVersions(data: Record<string, unknown>): NormalizedVersion[] {
    const items = arr(data.items);
    const versions: NormalizedVersion[] = [];
    for (const it of items) {
        const id = str(it.id);
        const regulationId = str(it.regulation_id);
        if (!id || !regulationId) continue;
        const pub =
            it.publication && typeof it.publication === "object"
                ? (it.publication as Record<string, unknown>)
                : {};
        versions.push({
            id,
            regulationId,
            versionNumber:
                typeof it.version_number === "number" ? it.version_number : null,
            status: str(it.status),
            enterIntoForce: str(it.enter_into_force_date),
            applicationDate: str(it.application_date),
            endDate: str(it.end_date),
            nnReference: str(pub.nn_reference),
            eliUrl: str(pub.eli_url) ?? str(pub.url),
        });
    }
    // Chronological, oldest first — the timeline's stop order. Versions with
    // no date (rare data gaps) sink to the end so indices stay stable.
    versions.sort((a, b) => {
        if (!a.enterIntoForce) return b.enterIntoForce ? 1 : 0;
        if (!b.enterIntoForce) return -1;
        return a.enterIntoForce.localeCompare(b.enterIntoForce);
    });
    return versions;
}

// GET /legal-docs/versions?scope=@hr&path=/api/v1/regulations/{uuid}
// Full NN version history across the regulation's whole lineage (fragmented
// laws merged into one chronological list). HR only for now — EU/FR return 404
// until their version chains are wired up.
legalDocsRouter.get("/versions", requireAuth, async (req, res) => {
    const scope = String(req.query.scope ?? "") as Scope;
    const path = String(req.query.path ?? "");

    if (scope !== "@hr") {
        return void res
            .status(404)
            .json({ detail: `No version timeline for ${scope}` });
    }
    // Whole-regulation path only — never article/caselaw subpaths.
    if (!isSafePath(path) || !/^\/api\/v1\/regulations\/[0-9a-f-]{36}$/i.test(path)) {
        return void res.status(400).json({ detail: "Invalid or disallowed path" });
    }

    const { base, token } = upstreamFor(scope);
    if (!base) {
        return void res
            .status(503)
            .json({ detail: `No upstream configured for ${scope}` });
    }

    try {
        const headers = await authHeaders(base, token);
        // Lineage first (whole-law NN history across legacy fragments); plain
        // versions of the single regulation row as a fallback.
        let data: Record<string, unknown>;
        try {
            data = (await fetchJson(
                `${base}${path}/lineage-versions`,
                headers,
            )) as Record<string, unknown>;
        } catch {
            data = (await fetchJson(
                `${base}${path}/versions`,
                headers,
            )) as Record<string, unknown>;
        }
        res.json({ versions: normalizeHrVersions(data) });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[legalDocs] versions failed path=${path}: ${msg}`);
        res.status(502).json({ detail: "Failed to fetch version history" });
    }
});
