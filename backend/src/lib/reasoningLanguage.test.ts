import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
    chunkCut,
    createReasoningGate,
    detectReasoningLanguage,
    isUsableTranslation,
    keepsPlaceholders,
    modelReasoningTranslator,
    reasoningTranslationPrompt,
} from "./reasoningLanguage";
import type { UiLocale } from "./uiLocale";

const EN_BLOCK =
    "The user wants to know whether the contract allows early termination. I need to check clause 13 of the document and compare it with the general terms, then answer in Croatian.";
const HR_BLOCK =
    "Korisnik pita može li se ugovor raskinuti prije roka. Moram provjeriti članak 13. ugovora i usporediti ga s općim uvjetima, a zatim odgovoriti što kraće i jasnije.";

type Sse = { type: string; text?: string };

function parse(chunks: string[]): Sse[] {
    return chunks.map((c) => {
        const body = c.replace(/^data: /, "").trim();
        return body === "[DONE]" ? { type: "done" } : (JSON.parse(body) as Sse);
    });
}

function shownReasoning(chunks: string[]): string {
    return parse(chunks)
        .filter((e) => e.type === "reasoning_delta")
        .map((e) => e.text)
        .join("");
}

function deferred() {
    let resolve!: (v: string) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const content = (text: string) =>
    `data: ${JSON.stringify({ type: "content_delta", text })}\n\n`;
const blockEnd = `data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`;

function setup(locale: UiLocale | undefined, translate: (t: string, l: UiLocale) => Promise<string>) {
    const out: string[] = [];
    const gate = createReasoningGate({ locale, emit: (s) => out.push(s), translate });
    return { out, gate };
}

describe("detectReasoningLanguage", () => {
    it("tells English and Croatian reasoning apart", () => {
        assert.equal(detectReasoningLanguage(EN_BLOCK), "en");
        assert.equal(detectReasoningLanguage(HR_BLOCK), "hr");
    });

    it("stays English with a Croatian quotation inside", () => {
        const text =
            "The document says „Ugovor se može raskinuti uz otkazni rok od 30 dana” — so I should check whether the notice was given and what the user wants to do about it.";
        assert.equal(detectReasoningLanguage(text), "en");
    });

    it("recognises one-line blocks", () => {
        // The first block on staging (29. 9.) slipped through untranslated.
        assert.equal(detectReasoningLanguage("I need to read both documents."), "en");
        assert.equal(detectReasoningLanguage("Pročitat ću oba ugovora."), "hr");
        assert.equal(detectReasoningLanguage("OK."), "unknown");
        assert.equal(detectReasoningLanguage("13.7"), "unknown");
    });
});

describe("isUsableTranslation", () => {
    it("requires every PII placeholder to survive the translation", () => {
        assert.ok(keepsPlaceholders("Call ⟦PII:PERSON_1⟧ now", "Nazovi ⟦PII:PERSON_1⟧ odmah"));
        assert.ok(!keepsPlaceholders("Call ⟦PII:PERSON_1⟧ now", "Nazovi Ivana odmah"));
    });

    it("rejects a translation cut to under half the source", () => {
        assert.ok(isUsableTranslation(EN_BLOCK, "x".repeat(EN_BLOCK.length * 0.8)));
        assert.ok(!isUsableTranslation(EN_BLOCK, "Korisnik želi znati"));
    });
});

describe("reasoningTranslationPrompt", () => {
    it("does not call the text reasoning — Sonnet 5.5 declines that as reasoning_extraction", () => {
        for (const locale of ["hr", "en"] as const) {
            assert.doesNotMatch(reasoningTranslationPrompt(locale), /reasoning|thinking|razmišlj/i);
        }
    });

    it("pins Croatian legal terms that a translation gets wrong", () => {
        const prompt = reasoningTranslationPrompt("hr");
        assert.match(prompt, /ugovor o djelu \(NEVER „ugovor o radu”/);
        assert.match(prompt, /ugovorna kazna/);
        assert.doesNotMatch(reasoningTranslationPrompt("en"), /ugovor o djelu/);
    });
});

describe("createReasoningGate", () => {
    it("passes everything through unchanged without a locale", async () => {
        const { out, gate } = setup(undefined, async () => assert.fail("no translation"));
        gate.reasoningDelta(EN_BLOCK);
        gate.write(content("Odgovor"));
        assert.equal(await gate.endReasoning(), "");
        await gate.drain();
        assert.deepEqual(parse(out).map((e) => e.type), ["reasoning_delta", "content_delta"]);
        assert.equal(shownReasoning(out), EN_BLOCK);
    });

    it("streams reasoning in the UI language live, without translating", async () => {
        const { out, gate } = setup("hr", async () => assert.fail("no translation"));
        gate.reasoningDelta(HR_BLOCK.slice(0, 40));
        assert.equal(out.length, 0); // not enough text to decide yet
        gate.reasoningDelta(HR_BLOCK.slice(40));
        assert.equal(shownReasoning(out), HR_BLOCK);
        gate.reasoningDelta(" Još jedna rečenica.");
        assert.equal(out.length, 2); // live after the decision
        gate.write(content("Odgovor"));
        assert.equal(await gate.endReasoning(), HR_BLOCK + " Još jedna rečenica.");
    });

    it("translates an English block and keeps the answer behind it", async () => {
        const d = deferred();
        const { out, gate } = setup("hr", (text, locale) => {
            assert.equal(locale, "hr");
            assert.equal(text, EN_BLOCK);
            return d.promise;
        });
        gate.reasoningDelta(EN_BLOCK);
        gate.write(content("Da, "));
        gate.write(content("može."));
        const shown = gate.endReasoning();
        gate.write(blockEnd);
        assert.equal(out.length, 0); // nothing leaks before the translation

        d.resolve(HR_BLOCK);
        assert.equal(await shown, HR_BLOCK);
        await gate.drain();
        assert.deepEqual(
            parse(out).map((e) => [e.type, e.text]),
            [
                ["reasoning_delta", HR_BLOCK],
                ["content_delta", "Da, "],
                ["content_delta", "može."],
                ["reasoning_block_end", undefined],
            ],
        );
    });

    it("translates paragraph by paragraph and emits them in order", async () => {
        const first = deferred();
        const second = deferred();
        const calls: string[] = [];
        const { out, gate } = setup("hr", (text) => {
            calls.push(text);
            return calls.length === 1 ? first.promise : second.promise;
        });
        const p1 = `${EN_BLOCK} ${EN_BLOCK}\n\n`;
        const p2 = "Now I should look at the notice period and whether the user has already sent the termination letter.";
        gate.reasoningDelta(p1);
        assert.equal(calls.length, 1); // the first paragraph goes out before the block ends
        gate.reasoningDelta(p2);
        gate.write(content("Odgovor"));
        assert.equal(calls.length, 2);

        second.resolve("Sada trebam pogledati otkazni rok i je li korisnik već poslao izjavu o raskidu ugovora.");
        await new Promise((r) => setImmediate(r));
        assert.equal(out.length, 0); // second is done, but the first is not

        first.resolve(`${HR_BLOCK} ${HR_BLOCK}`);
        await gate.drain();
        assert.equal(shownReasoning(out), `${HR_BLOCK} ${HR_BLOCK}\n\n` + "Sada trebam pogledati otkazni rok i je li korisnik već poslao izjavu o raskidu ugovora.");
        assert.equal(parse(out).at(-1)?.type, "content_delta");
    });

    it("shows the original when the translation fails or drops a placeholder", async () => {
        const failing = setup("hr", async () => {
            throw new Error("vertex down");
        });
        failing.gate.reasoningDelta(EN_BLOCK);
        failing.gate.write(content("Odgovor"));
        await failing.gate.drain();
        assert.equal(shownReasoning(failing.out), EN_BLOCK);

        const withPii = `${EN_BLOCK} The tenant ⟦PII:PERSON_1⟧ signed it.`;
        const lossy = setup("hr", async () => "Najmoprimac Ivan Horvat ga je potpisao.");
        lossy.gate.reasoningDelta(withPii);
        lossy.gate.write(content("Odgovor"));
        await lossy.gate.drain();
        assert.equal(shownReasoning(lossy.out), withPii);
    });

    it("cuts chunks at paragraph ends between 300 and 1200 characters", () => {
        const para = (n: number) => `${"x".repeat(n - 2)}\n\n`;
        assert.equal(chunkCut(para(100) + para(100)), -1); // too short, wait
        assert.equal(chunkCut(para(100) + para(250) + "rest"), 350);
        const long = "word ".repeat(400); // 2000 chars, no paragraph break
        assert.equal(chunkCut(long), 1200);
        assert.equal(chunkCut(`${"a".repeat(700)}. ${"b".repeat(900)}`), 702);
    });

    it("abandon writes held text at once, untranslated and in order", async () => {
        const { out, gate } = setup("hr", () => new Promise<string>(() => {}));
        gate.reasoningDelta(`${EN_BLOCK}\n\n`);
        gate.reasoningDelta("And one more thing to check before answering the user.");
        gate.write(content("Odgovor"));
        assert.equal(out.length, 0);
        const shown = gate.endReasoning();
        gate.abandon();
        const text = `${EN_BLOCK}\n\nAnd one more thing to check before answering the user.`;
        assert.equal(shownReasoning(out), text);
        assert.equal(parse(out).at(-1)?.type, "content_delta");
        await gate.drain();
        // The never-resolving translation does not keep the turn waiting.
        assert.equal(await shown, text);
    });

    it("re-decides at every paragraph: an English paragraph after a Croatian one is translated", async () => {
        const d = deferred();
        const calls: string[] = [];
        const { out, gate } = setup("hr", (text) => {
            calls.push(text);
            return d.promise;
        });
        gate.reasoningDelta(`${HR_BLOCK}\n\n`);
        assert.equal(shownReasoning(out), `${HR_BLOCK}\n\n`); // live
        gate.reasoningDelta(EN_BLOCK); // prod 30. 9.: this slipped through
        gate.write(content("Odgovor"));
        assert.deepEqual(calls, [EN_BLOCK]);
        assert.equal(shownReasoning(out), `${HR_BLOCK}\n\n`); // English held
        const shown = gate.endReasoning();
        d.resolve(HR_BLOCK);
        assert.equal(await shown, `${HR_BLOCK}\n\n${HR_BLOCK}`);
        await gate.drain();
        assert.equal(shownReasoning(out), `${HR_BLOCK}\n\n${HR_BLOCK}`);
        assert.equal(parse(out).at(-1)?.type, "content_delta");
    });

    it("keeps a live Croatian block and a translated English one in stream order", async () => {
        const d = deferred();
        const { out, gate } = setup("hr", () => d.promise);
        gate.reasoningDelta(HR_BLOCK);
        const firstShown = gate.endReasoning();
        gate.write(blockEnd);
        gate.write(`data: ${JSON.stringify({ type: "tool_call_start", name: "read_document" })}\n\n`);
        gate.reasoningDelta(EN_BLOCK); // next iteration, after the tool result
        const secondShown = gate.endReasoning();
        gate.write(blockEnd);
        gate.write(content("Odgovor"));
        assert.equal(await firstShown, HR_BLOCK);
        d.resolve(HR_BLOCK);
        assert.equal(await secondShown, HR_BLOCK);
        await gate.drain();
        assert.deepEqual(
            parse(out).map((e) => e.type),
            [
                "reasoning_delta",
                "reasoning_block_end",
                "tool_call_start",
                "reasoning_delta",
                "reasoning_block_end",
                "content_delta",
            ],
        );
    });
});

describe("modelReasoningTranslator", () => {
    it("retries a declined (empty) translation on the fallback model", async () => {
        const models: string[] = [];
        const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
            const body = JSON.parse(String(init.body));
            models.push(body.model);
            const declined = body.model === "claude-sonnet-5-5";
            return new Response(
                JSON.stringify({
                    id: "msg_test",
                    type: "message",
                    role: "assistant",
                    model: body.model,
                    content: declined ? [] : [{ type: "text", text: HR_BLOCK }],
                    stop_reason: declined ? "refusal" : "end_turn",
                    stop_details: declined ? { type: "refusal", category: "reasoning_extraction" } : null,
                    stop_sequence: null,
                    usage: { input_tokens: 10, output_tokens: declined ? 0 : 50 },
                }),
                { status: 200, headers: { "content-type": "application/json", "request-id": "req_test" } },
            );
        });
        const warn = mock.method(console, "warn", () => {});
        const usageModels: string[] = [];
        try {
            const translate = modelReasoningTranslator({
                apiKeys: { claude: "test-key" },
                onUsage: (_u, _ms, model) => usageModels.push(model),
            });
            assert.equal(await translate(EN_BLOCK, "hr"), HR_BLOCK);
        } finally {
            fetchMock.mock.restore();
            warn.mock.restore();
        }
        assert.deepEqual(models, ["claude-sonnet-5-5", "claude-sonnet-5"]);
        assert.deepEqual(usageModels, ["claude-sonnet-5-5", "claude-sonnet-5"]);
    });
});
