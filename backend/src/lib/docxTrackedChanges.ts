/**
 * DOCX tracked-changes helpers.
 *
 * `applyTrackedEdits` rewrites a .docx so that the requested substitutions
 * appear as `<w:ins>` / `<w:del>` tracked changes rather than direct text
 * replacements. `resolveTrackedChange` accepts or rejects one change by
 * its `w:id`, producing a new .docx with only that change collapsed.
 *
 * Only text inside `<w:p><w:r><w:t>` is considered. Headers, footers,
 * comments, footnotes are left alone. Pre-existing tracked changes in the
 * paragraph are presented to the matcher in *accepted view*: w:ins runs are
 * treated as normal text, w:del wrappers are invisible. When a new edit's
 * range lands on runs inside a pre-existing w:ins, the wrapper is dropped
 * (accepting that insertion) before the new change is emitted.
 */

import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import fastDiff from "fast-diff";

// ---------------------------------------------------------------------------
// JSZip path helpers
// ---------------------------------------------------------------------------
//
// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
}

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
}

export interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
}

// ---------------------------------------------------------------------------
// Preserve-order tree helpers
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// Build a w:r element that wraps a piece of text. Newlines and tabs in the
// text are emitted as <w:br/> / <w:tab/> (interleaved with w:t/w:delText
// segments) so models can request multi-line replacements without the
// literal "\n" showing up as visible text.
function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText"): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    for (const seg of text.split(/(\n|\t)/)) {
        if (seg === "\n") children.push(makeEl("w:br", []));
        else if (seg === "\t") children.push(makeEl("w:tab", []));
        else if (seg.length > 0) {
            children.push(
                makeEl(tagName, [makeText(seg)], { "xml:space": "preserve" }),
            );
        }
    }
    return makeEl("w:r", children);
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

// ---------------------------------------------------------------------------
// Automatic numbering labels (tracker #94)
// ---------------------------------------------------------------------------
//
// Word renders "Članak 1.", "1.1" or "a)" from numbering.xml — the label is
// not in any w:t, so the model used to read contracts as if their articles
// were unnumbered. Both the text the model reads (extractDocxBodyText) and
// the edit matcher (applyTrackedEdits) now put the label in front of the
// paragraph as synthetic characters: visible and matchable, but never part
// of an edit's deleted text.

interface NumLevel {
    start: number;
    numFmt: string;
    lvlText: string;
    suff: string;
    isLgl: boolean;
}

interface NumberingDefs {
    abstracts: Map<string, Map<number, NumLevel>>;
    nums: Map<string, { abstractId: string; startOverrides: Map<number, number> }>;
    styleNumPr: Map<string, { numId?: string; ilvl?: number }>;
}

function childEl(n: unknown, name: string): XNode | null {
    for (const c of elChildren(n)) if (elName(c) === name) return c;
    return null;
}

function valAttr(n: unknown): string | undefined {
    const v = elAttrs(n)["@_w:val"];
    return v == null ? undefined : String(v);
}

function readNumPr(pPr: unknown): { numId?: string; ilvl?: number } | null {
    const numPr = childEl(pPr, "w:numPr");
    if (!numPr) return null;
    const numId = valAttr(childEl(numPr, "w:numId"));
    const ilvlRaw = valAttr(childEl(numPr, "w:ilvl"));
    const ilvl = ilvlRaw == null ? undefined : parseInt(ilvlRaw, 10);
    return { numId, ilvl: Number.isFinite(ilvl) ? ilvl : undefined };
}

async function parseNumberingDefs(
    zip: JSZip,
    parser: ReturnType<typeof createParser>,
): Promise<NumberingDefs> {
    const defs: NumberingDefs = {
        abstracts: new Map(),
        nums: new Map(),
        styleNumPr: new Map(),
    };
    try {
        const numFile = getZipEntry(zip, "word/numbering.xml");
        if (numFile) {
            const tree = parser.parse(await numFile.async("string")) as XNode[];
            for (const top of tree) {
                if (elName(top) !== "w:numbering") continue;
                for (const n of elChildren(top)) {
                    const name = elName(n);
                    const attrs = elAttrs(n);
                    if (name === "w:abstractNum") {
                        const levels = new Map<number, NumLevel>();
                        for (const lvl of elChildren(n)) {
                            if (elName(lvl) !== "w:lvl") continue;
                            const ilvl = parseInt(String(elAttrs(lvl)["@_w:ilvl"] ?? "0"), 10);
                            const start = parseInt(valAttr(childEl(lvl, "w:start")) ?? "1", 10);
                            levels.set(ilvl, {
                                start: Number.isFinite(start) ? start : 1,
                                numFmt: valAttr(childEl(lvl, "w:numFmt")) ?? "decimal",
                                lvlText: valAttr(childEl(lvl, "w:lvlText")) ?? "",
                                suff: valAttr(childEl(lvl, "w:suff")) ?? "tab",
                                isLgl: childEl(lvl, "w:isLgl") != null,
                            });
                        }
                        defs.abstracts.set(String(attrs["@_w:abstractNumId"] ?? ""), levels);
                    } else if (name === "w:num") {
                        const abstractId = valAttr(childEl(n, "w:abstractNumId"));
                        if (abstractId == null) continue;
                        const startOverrides = new Map<number, number>();
                        for (const o of elChildren(n)) {
                            if (elName(o) !== "w:lvlOverride") continue;
                            const ilvl = parseInt(String(elAttrs(o)["@_w:ilvl"] ?? "0"), 10);
                            const so = valAttr(childEl(o, "w:startOverride"));
                            if (so != null && Number.isFinite(parseInt(so, 10))) {
                                startOverrides.set(ilvl, parseInt(so, 10));
                            }
                        }
                        defs.nums.set(String(attrs["@_w:numId"] ?? ""), {
                            abstractId,
                            startOverrides,
                        });
                    }
                }
            }
        }

        // Heading styles often carry the numbering ("Članak %1." on
        // Heading 1) — resolve it through the basedOn chain.
        const stylesFile = getZipEntry(zip, "word/styles.xml");
        if (stylesFile) {
            const tree = parser.parse(await stylesFile.async("string")) as XNode[];
            const own = new Map<string, { numPr: { numId?: string; ilvl?: number } | null; basedOn?: string }>();
            for (const top of tree) {
                if (elName(top) !== "w:styles") continue;
                for (const st of elChildren(top)) {
                    if (elName(st) !== "w:style") continue;
                    const id = String(elAttrs(st)["@_w:styleId"] ?? "");
                    if (!id) continue;
                    own.set(id, {
                        numPr: readNumPr(childEl(st, "w:pPr")),
                        basedOn: valAttr(childEl(st, "w:basedOn")),
                    });
                }
            }
            for (const id of own.keys()) {
                let numId: string | undefined;
                let ilvl: number | undefined;
                let cur: string | undefined = id;
                for (let depth = 0; cur && depth < 10; depth++) {
                    const s = own.get(cur);
                    if (!s) break;
                    if (numId === undefined && s.numPr?.numId !== undefined) numId = s.numPr.numId;
                    if (ilvl === undefined && s.numPr?.ilvl !== undefined) ilvl = s.numPr.ilvl;
                    cur = s.basedOn;
                }
                if (numId !== undefined) defs.styleNumPr.set(id, { numId, ilvl });
            }
        }
    } catch {
        // Malformed numbering/styles — the text simply has no labels.
    }
    return defs;
}

function toRoman(n: number): string {
    const table: [number, string][] = [
        [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
        [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
    ];
    let out = "";
    let rest = n;
    for (const [v, s] of table) {
        while (rest >= v) {
            out += s;
            rest -= v;
        }
    }
    return out;
}

function formatNumber(n: number, fmt: string): string {
    switch (fmt) {
        case "decimalZero":
            return n < 10 ? `0${n}` : String(n);
        case "lowerLetter":
        case "upperLetter": {
            if (n < 1) return String(n);
            // Word repeats the letter past z: a … z, aa … zz.
            const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
            return fmt === "upperLetter" ? letter.toUpperCase() : letter;
        }
        case "lowerRoman":
            return n < 1 ? String(n) : toRoman(n);
        case "upperRoman":
            return n < 1 ? String(n) : toRoman(n).toUpperCase();
        default:
            return String(n);
    }
}

/**
 * Hands out numbering labels in document order. Counters are shared per
 * abstract list — Word continues a list across w:num instances unless one
 * carries a startOverride — and a level resets every deeper level.
 */
class NumberingCounter {
    private counters = new Map<string, (number | undefined)[]>();
    private seenNums = new Set<string>();

    constructor(private defs: NumberingDefs) {}

    /** Label for a paragraph ("" when it is not numbered). */
    labelFor(pNode: XNode): string {
        const pPr = childEl(pNode, "w:pPr");
        const own = readNumPr(pPr);
        const styleId = valAttr(childEl(pPr, "w:pStyle"));
        const fromStyle = styleId ? this.defs.styleNumPr.get(styleId) : undefined;
        const numId = own?.numId ?? fromStyle?.numId;
        if (!numId || numId === "0") return "";
        const ilvl = own?.ilvl ?? fromStyle?.ilvl ?? 0;
        const num = this.defs.nums.get(numId);
        if (!num) return "";
        const levels = this.defs.abstracts.get(num.abstractId);
        const lvl = levels?.get(ilvl);
        if (!levels || !lvl) return "";

        const st = this.counters.get(num.abstractId) ?? [];
        if (!this.seenNums.has(numId)) {
            this.seenNums.add(numId);
            for (const [l, v] of num.startOverrides) st[l] = v - 1;
        }
        st[ilvl] = (st[ilvl] ?? lvl.start - 1) + 1;
        for (let k = ilvl + 1; k < st.length; k++) st[k] = undefined;
        this.counters.set(num.abstractId, st);

        let label: string;
        if (lvl.numFmt === "bullet") {
            // Bullet glyphs usually live in a symbol font's private-use
            // range — show a plain bullet instead of a mojibake character.
            label = /^[-]*$/.test(lvl.lvlText) ? "•" : lvl.lvlText;
        } else if (lvl.numFmt === "none") {
            label = lvl.lvlText.replace(/%[1-9]/g, "");
        } else {
            label = lvl.lvlText.replace(/%([1-9])/g, (_, d: string) => {
                const l = Number(d) - 1;
                const lv = levels.get(l);
                const value = st[l] ?? lv?.start ?? 1;
                return formatNumber(value, lvl.isLgl ? "decimal" : (lv?.numFmt ?? "decimal"));
            });
        }
        if (!label) return "";
        return label + (lvl.suff === "nothing" ? "" : lvl.suff === "space" ? " " : "\t");
    }
}

// ---------------------------------------------------------------------------
// Paragraph flattening
// ---------------------------------------------------------------------------

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Line breaks and tabs (w:br, w:cr, w:tab) are entries too,
     * `synthetic`, with "\n" / "\t" as their text — so the matcher sees
     * the same characters the model reads, and rebuilding a touched run
     * re-emits the original element instead of silently dropping it
     * (tracker #94). Other children (w:sym, …) are ignored.
     */
    textNodes: {
        wtEl: XNode;
        text: string;
        paraStart: number;
        paraEnd: number;
        synthetic?: boolean;
    }[];
}

interface Flattened {
    paraText: string;
    // For each char index in paraText: which run slot + which textNode + offset within text
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
    charOffset: Int32Array;   // offset within that textNode.text
    runs: RunSlot[];          // order corresponds to their paragraph position
}

/** Synthetic character for a non-text run child, or null. */
function runChildChar(name: string | null): string | null {
    if (name === "w:br" || name === "w:cr") return "\n";
    if (name === "w:tab") return "\t";
    return null;
}

function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";
    const charRunArr: number[] = [];
    const charTextNodeArr: number[] = [];
    const charOffsetArr: number[] = [];

    const processRun = (rEl: XNode, topChildIdx: number) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
                continue;
            }
            const synthCh = runChildChar(name);
            if (name !== "w:t" && synthCh === null) continue;
            const txt = synthCh ?? getTextContent(rk);
            const start = paraText.length;
            textNodes.push({
                wtEl: rk,
                text: txt,
                paraStart: start,
                paraEnd: start + txt.length,
                ...(synthCh !== null ? { synthetic: true } : {}),
            });
            const runIdx = runs.length;
            const tnIdx = textNodes.length - 1;
            paraText += txt;
            for (let i = 0; i < txt.length; i++) {
                charRunArr.push(runIdx);
                charTextNodeArr.push(tnIdx);
                charOffsetArr.push(i);
            }
        }
        runs.push({ childIndex: topChildIdx, rPr, textNodes });
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        const child = paraChildren[ci];
        const name = elName(child);
        if (name === "w:r") {
            processRun(child, ci);
        } else if (name === "w:ins") {
            // Accepted view: include inner runs as if bare. childIndex points
            // at the w:ins wrapper so reconstruction can drop the wrapper
            // whole when a new edit touches any of these runs.
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") processRun(inner, ci);
            }
        }
        // w:del: skip entirely — accepted view excludes deleted text.
    }

    return {
        paraText,
        charRun: Int32Array.from(charRunArr),
        charTextNode: Int32Array.from(charTextNodeArr),
        charOffset: Int32Array.from(charOffsetArr),
        runs,
    };
}

/**
 * The paragraph as the model reads it — numbering label plus text (line
 * breaks and tabs included) — whitespace-normalized for anchor matching.
 * `start[i]` / `end[i]` give the paraText range behind normalized char i;
 * label characters cover an empty range, so they are never deleted.
 */
interface ParaView {
    norm: string;
    start: number[];
    end: number[];
    /** Leading normalized chars that come from the numbering label. */
    labelNormLen: number;
}

function buildParaView(flat: Flattened, label: string): ParaView {
    const chars: string[] = [];
    const srcStart: number[] = [];
    const srcEnd: number[] = [];
    const isLabel: boolean[] = [];
    const push = (ch: string, s: number, e: number, lab: boolean) => {
        chars.push(ch);
        srcStart.push(s);
        srcEnd.push(e);
        isLabel.push(lab);
    };
    for (const ch of label) push(ch, 0, 0, true);
    const text = flat.paraText;
    for (let i = 0; i < text.length; i++) push(text[i], i, i + 1, false);

    const pre = preNormalize(chars.join(""));
    const norm: string[] = [];
    const start: number[] = [];
    const end: number[] = [];
    let labelNormLen = 0;
    let prevSpace = false;
    for (let i = 0; i < pre.length; i++) {
        const ch = pre[i];
        const space = /\s/.test(ch);
        if (space && prevSpace) continue;
        norm.push(space ? " " : ch);
        start.push(srcStart[i]);
        end.push(srcEnd[i]);
        if (isLabel[i]) labelNormLen = norm.length;
        prevSpace = space;
    }
    return { norm: norm.join(""), start, end, labelNormLen };
}

/** Map a normalized [start, end) range of a ParaView back to paraText. */
function mapViewRangeToPara(
    view: ParaView,
    origLen: number,
    normStart: number,
    normEnd: number,
): { start: number; end: number } {
    const start = normStart < view.start.length ? view.start[normStart] : origLen;
    const end =
        normEnd === normStart
            ? start
            : normEnd - 1 < view.end.length
              ? Math.max(start, view.end[normEnd - 1])
              : origLen;
    return { start, end };
}

/**
 * Cut the leading part of `s` whose whitespace-normalized form is `prefix`
 * (case-insensitive). Returns null when `s` does not start with it.
 */
function stripNormalizedPrefix(s: string, prefix: string): string | null {
    if (!prefix) return s;
    const pre = preNormalize(s);
    const want = prefix.toLowerCase();
    let got = "";
    let prevSpace = false;
    let i = 0;
    for (; i < pre.length && got.length < want.length; i++) {
        const ch = pre[i];
        const space = /\s/.test(ch);
        if (space && prevSpace) continue;
        got += space ? " " : ch.toLowerCase();
        prevSpace = space;
    }
    if (got !== want) return null;
    return s.slice(i);
}

// ---------------------------------------------------------------------------
// Planning edits on a paragraph
// ---------------------------------------------------------------------------

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    editIndex: number;            // source edit index
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    deletedText: string;          // substring of paraText in [start, end)
    insertedText: string;         // may be empty
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    changeId: string;             // logical id (not the w:id)
    delWId?: string;              // w:id of w:del wrapper (if deletedText non-empty)
    insWId?: string;              // w:id of w:ins wrapper (if insertedText non-empty)
}

/**
 * Collapse a `fast-diff` result into a minimal `{deletedText, insertedText}`
 * tuple anchored at a single start position. `fast-diff` produces
 * sequences like EQ-DEL-EQ-INS. For tracked-change UI we want one
 * "replace this substring with that substring" card per edit, so we
 * merge everything into the outer span.
 */
function collapseDiff(find: string, replace: string): { deleted: string; inserted: string; leadingEq: number; trailingEq: number } {
    // Find leading/trailing common substrings so the tracked range is minimal
    let leading = 0;
    const minLen = Math.min(find.length, replace.length);
    while (leading < minLen && find[leading] === replace[leading]) leading++;
    let trailing = 0;
    while (
        trailing < minLen - leading &&
        find[find.length - 1 - trailing] === replace[replace.length - 1 - trailing]
    ) {
        trailing++;
    }
    const deleted = find.slice(leading, find.length - trailing);
    const inserted = replace.slice(leading, replace.length - trailing);
    return { deleted, inserted, leadingEq: leading, trailingEq: trailing };
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction
// ---------------------------------------------------------------------------

/**
 * Given a paragraph's children and a sorted, non-overlapping list of
 * `PlannedChange`s that fall within it, return a new children array with
 * tracked changes inserted.
 */
function reconstructParagraph(
    paraChildren: XNode[],
    flat: Flattened,
    plan: PlannedChange[],
    now: string,
    author: string,
): XNode[] {
    if (plan.length === 0) return paraChildren;

    // Determine the run-index span that edits touch.
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = flat.charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        // Also include the run to the left/right of a pure insertion so we
        // can inherit its rPr.
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.paraText.length) {
            const r = flat.charRun[p.deleteStart];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        } else if (p.deleteStart === p.deleteEnd && p.deleteStart > 0) {
            const r = flat.charRun[p.deleteStart - 1];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
    }
    if (firstRunIdx > lastRunIdx) {
        // No runs touched (edits against empty paragraph?) — nothing to do.
        return paraChildren;
    }

    // Child-index range in paragraph.children we are going to replace.
    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;

    // Paragraph-text range that this run span covers.
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    // Walk [spanStart, spanEnd) in paraText, producing a new children array.
    const newRunGroup: XNode[] = [];

    // Helper: get the rPr for the run containing paragraph offset `pos`
    // (clamped to the touched span). Used to inherit formatting for
    // insertions that fall exactly on a boundary.
    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.paraText.length) pos = flat.paraText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.runs[flat.charRun[pos]].rPr;
    };

    // Emit a "normal" run fragment covering [a, b) of paraText, grouping
    // consecutive chars that belong to the same source text node.
    const emitNormal = (a: number, b: number) => {
        if (a >= b) return;
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const rPr = slot.rPr;
            const node = slot.textNodes[tnIdx];
            if (node.synthetic) {
                // Keep the original w:br / w:tab (incl. w:type="page").
                newRunGroup.push(
                    makeEl("w:r", [
                        ...(rPr ? [cloneNode(rPr)] : []),
                        cloneNode(node.wtEl),
                    ]),
                );
            } else {
                const slice = flat.paraText.slice(i, j);
                newRunGroup.push(buildRun(rPr, slice, "w:t"));
            }
            i = j;
        }
    };

    // Emit a w:del wrapping run fragments covering [a, b) of paraText.
    const emitDel = (a: number, b: number, wId: string) => {
        if (a >= b) return;
        const inner: XNode[] = [];
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const node = slot.textNodes[tnIdx];
            if (node.synthetic) {
                inner.push(
                    makeEl("w:r", [
                        ...(slot.rPr ? [cloneNode(slot.rPr)] : []),
                        cloneNode(node.wtEl),
                    ]),
                );
            } else {
                const slice = flat.paraText.slice(i, j);
                inner.push(buildRun(slot.rPr, slice, "w:delText"));
            }
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    // Emit a w:ins at position `pos` inheriting rPr from there.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const run = buildRun(rPr, text, "w:t");
        newRunGroup.push(
            makeEl("w:ins", [run], {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    let cursor = spanStart;
    for (const p of plan) {
        // Untouched slice before this edit
        emitNormal(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    // Replace only the w:r children that the edits touch; preserve any other
    // interleaved elements (bookmarks, existing tracked-changes, w:sdt …) at
    // their original positions.
    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.runs[r].childIndex);
    }
    // Any w:del wrappers that sit inside the span we're rewriting are also
    // dropped, which accepts their deletions (their text is already absent
    // from paraText in the accepted view).
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
    void endChildIdx;
    const out: XNode[] = [];
    for (let i = 0; i < paraChildren.length; i++) {
        if (i === firstDroppedIdx) {
            for (const n of newRunGroup) out.push(n);
        }
        if (droppedChildIdx.has(i)) continue;
        out.push(paraChildren[i]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Locating context in the document
// ---------------------------------------------------------------------------

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: Flattened;
    globalStart: number; // where this paragraph starts in the full doc text
}

function indexAll(hay: string, needle: string): number[] {
    if (!needle) return [];
    const out: number[] = [];
    let i = 0;
    while (i <= hay.length - needle.length) {
        const j = hay.indexOf(needle, i);
        if (j < 0) break;
        out.push(j);
        i = j + 1;
    }
    return out;
}

// --- Whitespace / punctuation normalization for anchor matching -------------
// The text LLMs see (via mammoth's extractRawText) does not line up 1:1 with
// the raw w:t concatenation: smart quotes, non-breaking spaces, tabs, and
// runs of whitespace all differ. We normalize both haystack and needle to
// a canonical form for matching, then map matched offsets back to the
// original paragraph text.

export function preNormalize(s: string): string {
    // All 1-to-1 character replacements — preserves length for straightforward
    // index mapping.
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
    // origIdx[i] = index in the *original* string for norm[i]
    origIdx: number[];
}

function normalizeWs(input: string): Normalized {
    const s = preNormalize(input);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch);
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate the unique position in `hayNorm` where `findNorm` appears AND is
 * preceded by `ctxBeforeNorm` AND followed by `ctxAfterNorm`. The context
 * check uses direct string-slice equality rather than concatenation so
 * boundary-whitespace collapsing doesn't matter. Returns the normalized
 * [start, end) range of the `find` portion, or a structured error.
 */
function findUniqueAnchor(
    hayNorm: string,
    findNorm: string,
    ctxBeforeNorm: string,
    ctxAfterNorm: string,
): { start: number; end: number } | { error: "none" | "ambiguous" } {
    const candidates: number[] = [];

    // Case-INSENSITIVE matching. The find_in_document search tool lowercases
    // both haystack and query (normalizeWithMap/normalizeQuery in chatTools),
    // so the model copies a `find` whose casing may differ from the document
    // ("članak" vs "Članak"). The edit matcher used to be case-sensitive,
    // which produced "Pronađeno … 1 rezultat" (search) followed by
    // "Uređivanje nije uspjelo" (edit) — a retry loop. We lowercase only for
    // COMPARISON; the returned indices still address the original case-
    // preserving `hayNorm`, so the downstream origIdx mapping is unchanged.
    // Safe because Croatian/Latin (incl. č ć š ž đ) lowercase 1:1 — character
    // positions don't shift. The actual w:ins/w:del text still comes from the
    // original document run, so casing in the redline is preserved.
    const hayCmp = hayNorm.toLowerCase();
    const findCmp = findNorm.toLowerCase();
    const ctxBeforeCmp = ctxBeforeNorm.toLowerCase();
    const ctxAfterCmp = ctxAfterNorm.toLowerCase();

    const checkCtx = (pos: number): boolean => {
        if (ctxBeforeCmp) {
            const start = pos - ctxBeforeCmp.length;
            if (start < 0) return false;
            if (hayCmp.slice(start, pos) !== ctxBeforeCmp) return false;
        }
        if (ctxAfterCmp) {
            const end = pos + findCmp.length;
            if (hayCmp.slice(end, end + ctxAfterCmp.length) !== ctxAfterCmp)
                return false;
        }
        return true;
    };

    if (findCmp.length === 0) {
        // Pure insertion — scan every position
        for (let i = 0; i <= hayCmp.length; i++) {
            if (checkCtx(i)) candidates.push(i);
        }
    } else {
        let from = 0;
        while (from <= hayCmp.length - findCmp.length) {
            const idx = hayCmp.indexOf(findCmp, from);
            if (idx < 0) break;
            if (checkCtx(idx)) candidates.push(idx);
            from = idx + 1;
        }
    }

    if (candidates.length === 0) return { error: "none" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return {
        start: candidates[0],
        end: candidates[0] + findCmp.length,
    };
}

// ---------------------------------------------------------------------------
// Main: applyTrackedEdits
// ---------------------------------------------------------------------------

const W_NS_ATTRS: Record<string, string> = {
    "xmlns:w":
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
};

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseAttributeValue: false,
        // Text nodes stay strings. The default coerces a run whose whole
        // text looks numeric into a JS number, so "10.000" (Croatian
        // thousands separator) read as "10" and every applyTrackedEdits
        // rewrote untouched runs that way. Same fix as upstream d8183be4.
        parseTagValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

function replaceBody(doc: XNode[], bodyChildren: XNode[]): void {
    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        for (const c of docKids) {
            if (elName(c) === "w:body") setChildren(c, bodyChildren);
        }
    }
}

/**
 * Walk a tree and collect all max w:id values in w:ins/w:del so new changes
 * can start their numbering safely above it.
 */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

/**
 * Parse `word/comments.xml` from the zip and return a map from comment id
 * to `{ author, text }`.  Returns an empty map if the file doesn't exist
 * or is malformed — callers can safely proceed without comments.
 */
async function parseComments(
    zip: JSZip,
    parser: ReturnType<typeof createParser>,
): Promise<Map<string, { author: string; text: string }>> {
    const map = new Map<string, { author: string; text: string }>();
    const commentsFile = getZipEntry(zip, "word/comments.xml");
    if (!commentsFile) return map;
    try {
        const xml = await commentsFile.async("string");
        const tree = parser.parse(xml) as XNode[];
        // tree → [ { "w:comments": [...] } ]
        for (const top of tree) {
            if (elName(top) !== "w:comments") continue;
            for (const cNode of elChildren(top)) {
                if (elName(cNode) !== "w:comment") continue;
                const attrs = elAttrs(cNode);
                const id = String(attrs["@_w:id"] ?? "");
                const author = String(attrs["@_w:author"] ?? "Unknown");
                // Collect all text from w:p > w:r > w:t inside the comment
                const parts: string[] = [];
                const collectText = (nodes: XNode[]) => {
                    for (const n of nodes) {
                        const name = elName(n);
                        if (!name) {
                            if (isTextNode(n)) parts.push(String(n[TEXT_KEY] ?? ""));
                            continue;
                        }
                        if (name === "w:t") {
                            parts.push(getTextContent(n));
                        } else {
                            collectText(elChildren(n));
                        }
                    }
                };
                collectText(elChildren(cNode));
                if (id) map.set(id, { author, text: parts.join("") });
            }
        }
    } catch {
        // Malformed comments.xml — continue without comments
    }
    return map;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 *
 * Comment bubbles from `word/comments.xml` are surfaced as inline markers:
 * `{>>by Author Name: comment text<<}` placed at the w:commentRangeEnd
 * position within the paragraph.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const parser = createParser();

    // Load comments map (empty if no comments.xml)
    const commentsMap = await parseComments(zip, parser);
    const numbering = new NumberingCounter(await parseNumberingDefs(zip, parser));

    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return "";
    const docXmlRaw = await docXmlFile.async("string");
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return "";

    const lines: string[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                // Walk paragraph children to build text + inline comments
                const paraKids = elChildren(n);
                // Automatic numbering label ("Članak 1.\t"), same as the
                // matcher's view (tracker #94).
                let paraText = numbering.labelFor(n);
                // Text, line breaks and tabs of one run — the same
                // characters flattenParagraph + buildParaView match against.
                const runText = (rEl: XNode) => {
                    for (const rk of elChildren(rEl)) {
                        const rkName = elName(rk);
                        if (rkName === "w:t") {
                            paraText += getTextContent(rk);
                        } else {
                            paraText += runChildChar(rkName) ?? "";
                        }
                    }
                };
                // Pending comment IDs that have started but not yet ended
                for (const kid of paraKids) {
                    const kidName = elName(kid);
                    if (kidName === "w:r") {
                        runText(kid);
                    } else if (kidName === "w:ins") {
                        // Accepted view: include inserted text
                        for (const inner of elChildren(kid)) {
                            if (elName(inner) === "w:r") runText(inner);
                        }
                    } else if (kidName === "w:commentRangeEnd") {
                        // Insert comment marker at this position
                        const attrs = elAttrs(kid);
                        const commentId = String(attrs["@_w:id"] ?? "");
                        const comment = commentsMap.get(commentId);
                        if (comment) {
                            paraText += ` {>>by ${comment.author}: ${comment.text}<<}`;
                        }
                    }
                    // w:del, w:commentRangeStart, w:bookmarkStart/End, etc. — skip
                }
                lines.push(paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    return lines.join("\n");
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}

// `extractDocxBodyText` surfaces Word comments to the model as synthetic
// `{>>by Author: text<<}` markers (with a leading space). The matcher's
// `paraText` (flattenParagraph) does NOT contain them, so if the model copies
// a `find`/`context` that overlaps a marker, the anchor can't be located and
// the edit silently no-ops. The system prompt tells the model these are
// read-only annotations, but as a server-side safety net we also strip the
// full injected marker from the anchor strings before matching. Stripping
// find + replace together keeps collapseDiff aligned; the marker is synthetic,
// so it must never be part of an edit's deleted/inserted text.
const INJECTED_COMMENT_MARKER_RE = /\s?\{>>by [\s\S]*?<<\}/g;
function stripInjectedCommentMarkers(s: string): string {
    return s.includes("{>>by ") ? s.replace(INJECTED_COMMENT_MARKER_RE, "") : s;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Eulex Desk";
    const now = new Date().toISOString();

    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");
    // Same labels, in the same document order, as extractDocxBodyText.
    const numbering = new NumberingCounter(await parseNumberingDefs(zip, parser));
    const labels: string[] = [];

    // Build paragraph table (only w:p at the top level of the body — does not
    // recurse into tables; for tables, w:p also appears inside w:tbl > w:tr >
    // w:tc so we need to traverse deeper).
    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const flat = flattenParagraph(kids);
                labels.push(numbering.labelFor(n));
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat,
                    globalStart: 0, // set below
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    // Assign global offsets (paragraphs joined by "\n" so context can
    // straddle a paragraph boundary, though edits themselves must stay
    // inside a single paragraph).
    {
        let off = 0;
        for (const p of paragraphs) {
            p.globalStart = off;
            off += p.flat.paraText.length + 1; // +1 for synthetic separator
        }
    }

    // Precompute the match view per paragraph for reuse across edits.
    const paraNorms: ParaView[] = paragraphs.map((p, i) =>
        buildParaView(p.flat, labels[i]),
    );

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChanges: AppliedChange[] = [];
    const errors: EditError[] = [];

    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
        const edit = edits[editIdx];
        // Strip any synthetic comment markers the model may have copied from
        // read_document/find_in_document output — they aren't in the matcher's
        // paraText, so leaving them in would silently fail to locate the anchor.
        const find = stripInjectedCommentMarkers(edit.find ?? "");
        const replace = stripInjectedCommentMarkers(edit.replace ?? "");
        const ctxBefore = stripInjectedCommentMarkers(edit.context_before ?? "");
        const ctxAfter = stripInjectedCommentMarkers(edit.context_after ?? "");

        if (!find && !replace) {
            errors.push({ index: editIdx, reason: "Empty edit." });
            continue;
        }
        if (!find && !ctxBefore && !ctxAfter) {
            errors.push({
                index: editIdx,
                reason: "Pure insertion requires context_before or context_after.",
            });
            continue;
        }

        const findNorm = normalizeWs(find).norm;
        const ctxBeforeNorm = normalizeWs(ctxBefore).norm;
        const ctxAfterNorm = normalizeWs(ctxAfter).norm;

        // Strategy:
        //   1) find + full context  (strictest — preferred)
        //   2) find + half context  (drop whichever context side is shorter)
        //   3) find alone           (only if globally unique across doc)
        // At each stage we scan every paragraph. "Unique across the doc"
        // means exactly one paragraph yields exactly one match.
        type Hit = { paraIdx: number; normStart: number; normEnd: number };

        /**
         * Search every paragraph with the given context sides. If any
         * paragraph returns a match AND no paragraph is internally ambiguous,
         * return the collected hits; otherwise signal ambiguous.
         */
        const tryStrategy = (
            cb: string,
            ca: string,
        ): { kind: "ok"; hits: Hit[] } | { kind: "ambiguous" } => {
            const hits: Hit[] = [];
            let ambiguous = false;
            for (let pi = 0; pi < paragraphs.length; pi++) {
                const r = findUniqueAnchor(
                    paraNorms[pi].norm,
                    findNorm,
                    cb,
                    ca,
                );
                if ("error" in r) {
                    if (r.error === "ambiguous") ambiguous = true;
                    continue;
                }
                hits.push({ paraIdx: pi, normStart: r.start, normEnd: r.end });
            }
            if (ambiguous || hits.length > 1) return { kind: "ambiguous" };
            return { kind: "ok", hits };
        };

        let selected: Hit | null = null;
        const attempts = [
            { cb: ctxBeforeNorm, ca: ctxAfterNorm },
            { cb: ctxBeforeNorm, ca: "" },
            { cb: "", ca: ctxAfterNorm },
            { cb: "", ca: "" }, // find-only
        ];
        let sawAmbiguous = false;
        for (const { cb, ca } of attempts) {
            const r = tryStrategy(cb, ca);
            if (r.kind === "ambiguous") {
                sawAmbiguous = true;
                continue;
            }
            if (r.hits.length === 1) {
                selected = r.hits[0];
                break;
            }
        }

        if (!selected) {
            errors.push({
                index: editIdx,
                reason: sawAmbiguous
                    ? `Ambiguous match for find="${truncate(find, 80)}". Add longer context_before / context_after so the anchor is unique.`
                    : `Could not locate find="${truncate(find, 80)}" in the document. Re-read the document and copy context verbatim (including punctuation & whitespace).`,
            });
            continue;
        }

        const hit = selected;
        const paraIdx = hit.paraIdx;
        const paraNorm = paraNorms[paraIdx];
        const origLen = paragraphs[paraIdx].flat.paraText.length;

        // `find` may start inside the automatic numbering label the model
        // read ("1.\tPredmet"). The label is not text: keep it only if
        // `replace` repeats it, and refuse an edit that changes it.
        let replaceText = replace;
        if (findNorm.length > 0 && hit.normStart < paraNorm.labelNormLen) {
            const labelPart = findNorm.slice(
                0,
                Math.min(paraNorm.labelNormLen - hit.normStart, findNorm.length),
            );
            const stripped = stripNormalizedPrefix(replaceText, labelPart);
            if (stripped === null || hit.normEnd <= paraNorm.labelNormLen) {
                errors.push({
                    index: editIdx,
                    reason: `"${truncate(labelPart.trim(), 40)}" is automatic Word numbering, not text — it cannot be edited. Leave the number out of find/replace and change only the text after it.`,
                });
                continue;
            }
            replaceText = stripped.replace(/^\s+/, "");
        }

        const { start: findStart, end: findEnd } = mapViewRangeToPara(
            paraNorm,
            origLen,
            hit.normStart,
            hit.normEnd,
        );

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const { deleted, inserted, leadingEq } = collapseDiff(
            originalFind,
            replaceText,
        );
        const minStart = findStart + leadingEq;
        const minEnd = minStart + deleted.length;
        void findEnd;

        const changeId = `mike-${editIdx}-${Date.now()}`;
        const plan: PlannedChange = {
            editIndex: editIdx,
            deleteStart: minStart,
            deleteEnd: minEnd,
            deletedText: deleted,
            insertedText: inserted,
            contextBefore: ctxBefore,
            contextAfter: ctxAfter,
            reason: edit.reason,
            changeId,
            delWId: deleted ? String(nextWId++) : undefined,
            insWId: inserted ? String(nextWId++) : undefined,
        };

        // Check for overlap with earlier plans in the same paragraph.
        const existing = plansPerParagraph.get(paraIdx) ?? [];
        const overlap = existing.some(
            (p) => !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd),
        );
        if (overlap) {
            errors.push({
                index: editIdx,
                reason: "Overlaps a previous edit in the same paragraph.",
            });
            continue;
        }

        existing.push(plan);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        appliedChanges.push({
            id: changeId,
            delId: plan.delWId,
            insId: plan.insWId,
            deletedText: plan.deletedText,
            insertedText: plan.insertedText,
            contextBefore: plan.contextBefore,
            contextAfter: plan.contextAfter,
            reason: plan.reason,
        });
    }

    // Apply plans per paragraph.
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        const newKids = reconstructParagraph(
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
        );
        setChildren(p.paraNode, newKids);
    }

    const builder = createBuilder();
    const rebuiltXml = builder.build(tree);
    const withDecl = ensureXmlDeclaration(rebuiltXml);
    setZipEntry(zip, "word/document.xml", withDecl);

    const outBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: outBuf, changes: appliedChanges, errors };
}

// ---------------------------------------------------------------------------
// Resolve a single tracked change (Accept or Reject)
// ---------------------------------------------------------------------------

/**
 * Walk the XML tree and transform matching w:ins/w:del wrappers for the
 * given change id. Returns { found, updatedTree }.
 */
function resolveInTree(
    doc: XNode[],
    changeIds: string[],
    mode: "accept" | "reject",
): { found: boolean } {
    const ids = new Set(changeIds.map((s) => String(s)));
    let touched = false;

    const rewrite = (parentKids: XNode[]): XNode[] => {
        const out: XNode[] = [];
        for (const n of parentKids) {
            const name = elName(n);
            if (!name) {
                out.push(n);
                continue;
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            if (name === "w:ins" || name === "w:del") {
                const a = elAttrs(n);
                const wId = String(a["@_w:id"] ?? "");
                if (ids.has(wId)) {
                    touched = true;
                    if (
                        (name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")
                    ) {
                        // Keep children, drop wrapper. For w:del rejected, we
                        // also need to convert inner w:delText → w:t so the
                        // text reverts to normal body content.
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
                        // accept-del / reject-ins → drop the wrapper and its
                        // inner runs entirely.
                        continue;
                    }
                }
            }

            out.push(n);
        }
        return out;
    };

    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:r") {
        const kids = elChildren(n).map(unwrapDelText);
        setChildren(n, kids);
        return n;
    }
    if (name === "w:delText") {
        const attrs = elAttrs(n);
        return {
            "w:t": elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}),
        };
    }
    return n;
}

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const { found } = resolveInTree(tree, changeIds, mode);

    const builder = createBuilder();
    const rebuilt = ensureXmlDeclaration(builder.build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, found };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function truncate(s: string, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

// Lightweight guards used elsewhere; exported for tests.
export const _internal = {
    flattenParagraph,
    collapseDiff,
    indexAll,
};

// Silence unused import if fastDiff is ever reintroduced for ranged matching.
// kept available in the file because the plan references it for future work.
export const _fastDiff = fastDiff;

// Suppress unused warning for W_NS_ATTRS (kept for potential future use when
// emitting standalone w:ins/w:del into parts without a namespace inheritance).
export const _nsAttrs = W_NS_ATTRS;
