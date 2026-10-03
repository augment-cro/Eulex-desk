/**
 * Keeps the reasoning the user sees ("Proces razmišljanja") in the UI
 * language.
 *
 * The per-message note (uiLanguageTurnNote) keeps Opus 5.5's FIRST thinking
 * block in the UI language, but after long tool results (a contract read in
 * a project, English MCP output) it still switches to English on ~1 of 4
 * blocks. Repeating the note after every tool_result did not help, and the
 * summarized-thinking API has no language parameter — so a block written in
 * the other language is translated (Haiku) before the user sees it.
 *
 * The gate owns the order of every SSE write in the stream: a block being
 * translated holds its place, and whatever the stream writes after it
 * (answer text, tool events, [DONE]) queues behind it. A block in the UI
 * language streams through live, as before. Translation runs paragraph by
 * paragraph while the model is still thinking, so a block ends up delayed
 * by roughly one paragraph's translation, not the whole block's.
 */
import { completeText } from "./llm";
import type { UserApiKeys } from "./llm";
import type { LlmUsage } from "./llm/types";
import type { UiLocale } from "./uiLocale";

export type ReasoningLanguage = UiLocale | "unknown";

// Frequent words of reasoning prose that the other language does not
// share. "i", "to", "on", "a", "do" are words in both and are left out.
const EN_WORDS = new Set([
    "the", "and", "of", "is", "are", "was", "be", "this", "that", "these",
    "with", "for", "from", "about", "should", "will", "would", "need", "let",
    "me", "my", "it's", "its", "what", "which", "who", "now", "so", "but",
    "not", "have", "has", "there", "their", "they", "user", "i'll", "i'm",
    "can", "check", "look", "answer", "whether", "also", "then", "into",
    "in", "at", "by", "or", "as", "an", "if", "when", "all", "both", "read",
    "first", "next", "search", "find", "looking", "reading", "document",
    "documents", "contract", "contracts", "clause", "article", "law", "here",
    "question", "compare", "provisions", "because", "since", "while", "just",
]);
const HR_WORDS = new Set([
    "je", "da", "se", "na", "za", "što", "koji", "koja", "koje", "treba",
    "nije", "su", "od", "ovo", "ali", "iz", "kao", "ili", "prema", "moram",
    "trebam", "sada", "pa", "li", "će", "bi", "sam", "još", "kako", "gdje",
    "korisnik", "korisnika", "članak", "članka", "ugovor", "ugovora", "jer",
    "ako", "po", "te", "zbog", "već", "provjeriti", "provjerit", "tražim",
    "u", "s", "sa", "o", "uz", "oba", "obje", "zatim", "samo", "sve", "može",
    "mogu", "nisam", "bih", "ovaj", "ova", "taj", "nego", "dokument",
    "dokumente", "ugovore", "zakon", "zakona", "odredbe", "odredbu", "gledam",
]);
const HR_LETTERS = /[čćšžđ]/gi;
const MIN_WORDS = 3;
// A one-line block ("I need to read both documents.") has few function
// words; below this many words one is enough when the other side has none.
const SHORT_TEXT_WORDS = 12;

/**
 * Crude but sufficient for reasoning prose: counts frequent words and
 * Croatian letters. "unknown" for mixed or wordless text — the caller then
 * leaves the text as it is.
 */
export function detectReasoningLanguage(text: string): ReasoningLanguage {
    const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
    let en = 0;
    let hr = 0;
    for (const w of words) {
        if (EN_WORDS.has(w)) en++;
        else if (HR_WORDS.has(w)) hr++;
    }
    const letters = text.match(HR_LETTERS)?.length ?? 0;
    if (letters > 0) hr += Math.max(1, Math.floor(letters / 2));
    const min = words.length < SHORT_TEXT_WORDS ? 1 : MIN_WORDS;
    if (en >= min && en > 2 * hr) return "en";
    if (hr >= min && hr > 2 * en) return "hr";
    return "unknown";
}

const PLACEHOLDER_RE = /⟦[^⟧]*⟧/g;

function placeholders(text: string): string[] {
    return (text.match(PLACEHOLDER_RE) ?? []).sort();
}

/** A translation that dropped or altered a PII placeholder is not used. */
export function keepsPlaceholders(source: string, translated: string): boolean {
    const a = placeholders(source);
    const b = placeholders(translated);
    return a.length === b.length && a.every((p, i) => p === b[i]);
}

/**
 * Croatian and English run to similar lengths; a translation under half
 * the source was cut off (max_tokens) and would hide part of the reasoning.
 */
export function isUsableTranslation(source: string, translated: string): boolean {
    return (
        translated.length >= source.length * 0.5 &&
        keepsPlaceholders(source, translated)
    );
}

// The terms Haiku got wrong on staging (29. 9.): "work contract" became
// "ugovor o radu" (an employment contract) and "penalty" "penalizacija".
const HR_LEGAL_TERMS = [
    "contract for work / work contract / contract for services → ugovor o djelu (NEVER „ugovor o radu”, which is an employment contract)",
    "employment contract → ugovor o radu; mandate contract → ugovor o nalogu",
    "client (in a contract for work or services) → naručitelj; contractor → izvođač / izvršitelj (as the document calls it)",
    "contractual penalty / penalty clause → ugovorna kazna",
    "termination / rescission of a contract → raskid ugovora; terminate → raskinuti; notice of termination → izjava o raskidu",
    "damages → naknada štete; statute of limitations → zastara; jurisdiction / competent court → nadležnost / nadležni sud",
    "Civil Obligations Act → Zakon o obveznim odnosima (ZOO); article → članak; paragraph → stavak; item → točka",
];

// The prompt must NOT describe the text as a model's reasoning: Sonnet 5.5
// declines that as `reasoning_extraction` (stop_reason "refusal", empty
// text) — every translation on staging 29. 9. came back empty.
export function reasoningTranslationPrompt(target: UiLocale): string {
    const lines = [
        `Translate the user's text into ${target === "hr" ? "Croatian" : "English"}. It is working notes on a legal matter.`,
        "Output ONLY the translation — no preface, no comments, no quotation marks around it.",
        "Keep unchanged: quotations from documents and laws, names, file names, article and case numbers, dates, amounts, URLs, markdown formatting, and every token in ⟦…⟧ brackets.",
        `If the text is already in ${target === "hr" ? "Croatian" : "English"}, return it unchanged.`,
    ];
    if (target === "hr") {
        lines.push(
            "Write standard Croatian (književni standard) with Croatian legal terminology — e.g. the future tense is „provjerit ću”, not „provjeriti ću”. Terms:",
            ...HR_LEGAL_TERMS.map((t) => `- ${t}`),
        );
    }
    return lines.join("\n");
}

// The language is decided as soon as the first sentence or two tell it
// (a summarized-thinking delta is usually a whole sentence or more), and
// at the latest after DECIDE_CHARS — still unclear then → left as it is.
const EARLY_DECIDE_CHARS = 60;
const DECIDE_CHARS = 200;
// Translation chunks: whole paragraphs, at least MIN_CHUNK_CHARS (fewer
// calls for short ones) and at most MAX_CHUNK_CHARS (a long block runs as
// several parallel calls, so it does not wait for one huge translation).
const MIN_CHUNK_CHARS = 300;
const MAX_CHUNK_CHARS = 1200;

/** Where the next translation chunk ends in `text`, or -1 to wait for more. */
export function chunkCut(text: string): number {
    const para = text.indexOf("\n\n", MIN_CHUNK_CHARS);
    if (para >= 0 && para + 2 <= MAX_CHUNK_CHARS) return para + 2;
    if (text.length <= MAX_CHUNK_CHARS) return -1;
    const window = text.slice(0, MAX_CHUNK_CHARS);
    const p = window.lastIndexOf("\n\n");
    if (p > 0) return p + 2;
    const sentence = window.lastIndexOf(". ");
    if (sentence > 0) return sentence + 2;
    const space = window.lastIndexOf(" ");
    return space > 0 ? space + 1 : MAX_CHUNK_CHARS;
}

type Slot = { parts: string[]; closed: boolean };
type Block = {
    mode: "undecided" | "pass" | "translate";
    pending: string;
    /** Text written out live (untranslated) before any translation. */
    passed: string;
    slot: Slot | null;
    pieces: Array<Promise<string>>;
};

export type ReasoningGate = {
    /** Every SSE chunk of the stream goes through here. */
    write(chunk: string): void;
    /** A reasoning delta as it came from the provider. */
    reasoningDelta(text: string): void;
    /**
     * Ends the open block(s) and resolves to the reasoning text the user
     * was shown since the previous call (translated where it was), for
     * the persisted `reasoning` event.
     */
    endReasoning(): Promise<string>;
    /** Resolves once every held chunk has been written. */
    drain(): Promise<void>;
    /** Error path: write everything still held at once, untranslated. */
    abandon(): void;
};

export function createReasoningGate(opts: {
    /** UI language; undefined → pass-through, exactly the old behavior. */
    locale?: UiLocale;
    emit: (chunk: string) => void;
    translate: (text: string, target: UiLocale) => Promise<string>;
}): ReasoningGate {
    const { locale, emit, translate } = opts;
    const queue: Slot[] = [];
    const drainWaiters: Array<() => void> = [];
    let abandoned = false;
    let onAbandon: () => void = () => {};
    const abandonedP = new Promise<void>((resolve) => {
        onAbandon = resolve;
    });
    let block: Block | null = null;
    let settled: Array<Promise<string>> = [];
    // Chunks sent for translation and not yet written, in order.
    const inflight: Array<{ slot: Slot; raw: string; emitted: boolean }> = [];

    const safeEmit = (chunk: string) => {
        try {
            emit(chunk);
        } catch (err) {
            console.warn(
                `[reasoning-language] write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    const pump = () => {
        while (queue.length) {
            const head = queue[0];
            const parts = head.parts;
            head.parts = [];
            for (const p of parts) safeEmit(p);
            if (!head.closed) return;
            queue.shift();
        }
        while (drainWaiters.length) drainWaiters.shift()!();
    };

    // Behind whatever is held, or straight out when nothing is.
    const enqueue = (chunk: string) => {
        if (!queue.length) {
            safeEmit(chunk);
            return;
        }
        const tail = queue[queue.length - 1];
        if (tail.closed) tail.parts.push(chunk);
        else queue.push({ parts: [chunk], closed: true });
    };

    const write = (chunk: string) => {
        settleBlock();
        enqueue(chunk);
    };

    const deltaChunk = (text: string) =>
        `data: ${JSON.stringify({ type: "reasoning_delta", text })}\n\n`;

    const translateChunk = (b: Block, chunk: string) => {
        const slot = b.slot!;
        const m = chunk.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        const [, lead, core, trail] = m;
        const piece: Promise<string> =
            !core || detectReasoningLanguage(core) === locale
                ? Promise.resolve(chunk)
                : translate(core, locale!).then(
                      (t) => {
                          const out = t.trim();
                          return isUsableTranslation(core, out)
                              ? lead + out + trail
                              : chunk;
                      },
                      (err: unknown) => {
                          console.warn(
                              `[reasoning-language] translation failed — showing original: ${err instanceof Error ? err.message : String(err)}`,
                          );
                          return chunk;
                      },
                  );
        // Emit strictly in paragraph order, whatever order they finish in.
        const entry = { slot, raw: chunk, emitted: false };
        inflight.push(entry);
        const prev = b.pieces.at(-1) ?? Promise.resolve("");
        // After abandon() nothing waits for a translation any more.
        const settledPiece = Promise.race([piece, abandonedP.then(() => chunk)]);
        const ordered = prev.then(() => settledPiece).then((text) => {
            if (entry.emitted) return entry.raw; // abandon() already wrote it
            entry.emitted = true;
            inflight.splice(inflight.indexOf(entry), 1);
            slot.parts.push(deltaChunk(text));
            pump();
            return text;
        });
        b.pieces.push(ordered);
    };

    // Cut complete chunks off `pending` and send them for translation.
    const feed = (b: Block, final: boolean) => {
        for (;;) {
            const cut = chunkCut(b.pending);
            if (cut < 0) break;
            const chunk = b.pending.slice(0, cut);
            b.pending = b.pending.slice(cut);
            translateChunk(b, chunk);
        }
        if (final && b.pending) {
            translateChunk(b, b.pending);
            b.pending = "";
        }
    };

    // enqueue, NOT write(): write() would settle the open block.
    const passThrough = (b: Block, text: string) => {
        if (!text) return;
        b.passed += text;
        enqueue(deltaChunk(text));
    };

    const startTranslating = (b: Block) => {
        b.mode = "translate";
        if (!b.slot) {
            b.slot = { parts: [], closed: false };
            queue.push(b.slot);
        }
        feed(b, false);
    };

    // The language is decided per paragraph, not once per block: a block
    // that starts in the UI language can switch mid-way (prod 30. 9.:
    // Croatian notes, then "I'm thinking through how to structure the
    // answer…" streamed through untranslated). Once a block needs
    // translation it stays held — its later paragraphs in the UI language
    // pass through translateChunk untouched.
    const consume = (b: Block, text: string, final: boolean) => {
        let rest = text;
        for (;;) {
            if (b.mode === "translate") {
                b.pending += rest;
                feed(b, final);
                return;
            }
            if (b.mode === "pass") {
                const brk = rest.indexOf("\n\n");
                if (brk < 0) {
                    passThrough(b, rest);
                    return;
                }
                passThrough(b, rest.slice(0, brk + 2));
                rest = rest.slice(brk + 2);
                b.mode = "undecided";
                continue;
            }
            // undecided: judge the first paragraph of what is pending
            b.pending += rest;
            rest = "";
            const brk = b.pending.indexOf("\n\n");
            const para = brk >= 0 ? b.pending.slice(0, brk + 2) : b.pending;
            if (!para) return;
            const lang = detectReasoningLanguage(para);
            const ready =
                final ||
                brk >= 0 ||
                para.length >= DECIDE_CHARS ||
                (para.length >= EARLY_DECIDE_CHARS && lang !== "unknown");
            if (!ready) return;
            if (lang !== "unknown" && lang !== locale) {
                startTranslating(b);
                if (final) feed(b, true);
                return;
            }
            b.pending = b.pending.slice(para.length);
            passThrough(b, para);
            if (brk < 0) {
                b.mode = "pass"; // the rest of this paragraph streams live
                return;
            }
            rest = b.pending; // next paragraph: decide again
            b.pending = "";
            b.mode = "undecided";
            if (!rest) return;
        }
    };

    function settleBlock() {
        const b = block;
        if (!b) return;
        block = null;
        if (b.mode === "undecided") consume(b, "", true);
        if (b.mode === "translate") {
            feed(b, true);
            const slot = b.slot!;
            const passed = b.passed;
            const done = Promise.all(b.pieces).then((parts) => {
                slot.closed = true;
                pump();
                return passed + parts.join("");
            });
            settled.push(done);
        } else {
            settled.push(Promise.resolve(b.passed));
        }
    }

    return {
        write(chunk) {
            if (!locale || abandoned) safeEmit(chunk);
            else write(chunk);
        },
        reasoningDelta(text) {
            if (!locale || abandoned) {
                safeEmit(deltaChunk(text));
                return;
            }
            if (!block) {
                block = { mode: "undecided", pending: "", passed: "", slot: null, pieces: [] };
            }
            consume(block, text, false);
        },
        async endReasoning() {
            if (!locale) return "";
            settleBlock();
            const mine = settled;
            settled = [];
            return (await Promise.all(mine)).join("");
        },
        drain() {
            settleBlock();
            if (!queue.length) return Promise.resolve();
            return new Promise<void>((resolve) => drainWaiters.push(resolve));
        },
        abandon() {
            if (abandoned) return;
            abandoned = true;
            onAbandon();
            // What is still being translated, and the untranslated rest of
            // the open block, go out as they are — in their places.
            for (const e of inflight.splice(0)) {
                e.emitted = true;
                e.slot.parts.push(deltaChunk(e.raw));
            }
            const b = block;
            block = null;
            if (b && b.mode !== "pass" && b.pending) {
                if (b.slot) b.slot.parts.push(deltaChunk(b.pending));
                else enqueue(deltaChunk(b.pending));
            }
            for (const s of queue) s.closed = true;
            pump();
        },
    };
}

// Sonnet, not Haiku: Haiku mistranslated legal terms and Croatian grammar
// on staging (29. 9.). Still a few cents per turn at most. Sonnet 5.5 since
// it was enabled in Vertex Model Garden (29. 9., `eu` probe OK); a model not
// enabled there 404s, and claude.ts treats a Vertex 404 as an infra error
// and falls back to the direct API — outside the EU.
export const REASONING_TRANSLATION_MODEL = "claude-sonnet-5-5";
// Retried here when the main model returns nothing (a safety decline):
// Sonnet 5 runs fewer classifiers — Anthropic's own fallback for 5.5.
export const REASONING_TRANSLATION_FALLBACK_MODEL = "claude-sonnet-5";
const TRANSLATE_TIMEOUT_MS = 20_000;

/** The production translator: one model call per chunk, with a deadline. */
export function modelReasoningTranslator(opts: {
    apiKeys?: UserApiKeys;
    onUsage?: (usage: LlmUsage, durationMs: number, model: string) => void;
}): (text: string, target: UiLocale) => Promise<string> {
    const once = async (model: string, text: string, target: UiLocale) => {
        const t0 = Date.now();
        const call = completeText({
            model,
            systemPrompt: reasoningTranslationPrompt(target),
            user: text,
            // ~1 token per 2.5 chars of Croatian, plus headroom for the
            // (low-effort) thinking, which counts against max_tokens.
            maxTokens: Math.min(12_000, 3072 + Math.ceil(text.length / 2)),
            apiKeys: opts.apiKeys,
            // Low: the translation holds the stream, but thinking stays on.
            effort: "low",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`timed out after ${TRANSLATE_TIMEOUT_MS}ms`)),
                TRANSLATE_TIMEOUT_MS,
            );
        });
        try {
            const res = await Promise.race([call, deadline]);
            if (res.usage) opts.onUsage?.(res.usage, Date.now() - t0, model);
            return res.text;
        } finally {
            clearTimeout(timer);
        }
    };
    return async (text, target) => {
        const first = await once(REASONING_TRANSLATION_MODEL, text, target);
        if (first.trim()) return first;
        return once(REASONING_TRANSLATION_FALLBACK_MODEL, text, target);
    };
}
