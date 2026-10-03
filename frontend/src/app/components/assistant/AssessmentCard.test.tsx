import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import hr from "../../../../messages/hr.json";
import en from "../../../../messages/en.json";
import type { AssessmentFinding, AssessmentSnapshot } from "../shared/types";

const downloadTableAsXlsx = vi.fn(async () => {});
vi.mock("./tableXlsx", () => ({ downloadTableAsXlsx }));

const { AssessmentCard } = await import("./AssessmentCard");
const { latestAssessment, parseAssessmentSnapshot } = await import("./assessmentEvents");

// Plain react-dom rendering: @testing-library/react's `dom` peer is not
// installed (legacy-peer-deps).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;

const mounted: Root[] = [];

afterEach(() => {
    mounted.splice(0).forEach((root) => act(() => root.unmount()));
    document.body.innerHTML = "";
    downloadTableAsXlsx.mockClear();
});

function renderIn(locale: "hr" | "en", ui: ReactElement): HTMLElement {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    act(() =>
        root.render(
            <NextIntlClientProvider locale={locale} messages={locale === "hr" ? hr : en}>
                {ui}
            </NextIntlClientProvider>,
        ),
    );
    return container;
}

const finding = (over: Partial<AssessmentFinding> = {}): AssessmentFinding => ({
    id: "F-1",
    check_id: "AA-20",
    requirement: "Ljudski nadzor s ovlašću odbijanja",
    category: "zakon",
    applicability: "sada",
    evidence: [{ doc_id: "doc-0", filename: "Prilog 2.pdf", quote: "ovlast odbijanja", page: "2" }],
    evidence_weight: "dokument",
    verification: "provjereno",
    status: "ok",
    action: "—",
    closure_criterion: "Postupak i primjer intervencije",
    ...over,
});

const snapshot = (over: Partial<AssessmentSnapshot> = {}): AssessmentSnapshot => ({
    assessment_id: "PROC-1A2B",
    version: 2,
    recorded_at: "2026-10-03T10:00:00Z",
    title: "Provjera alata za zapošljavanje",
    task_id: "RT-10",
    facts_as_of: null,
    sources_checked_at: "2026-10-03",
    context: { id: "ctx-1", version_label: "v1.3" },
    workflow: { id: "ctx-ctx-1-RT-10", title: "RT-10 Provjera usklađenosti dokumenta" },
    facts: [],
    decisions: [],
    findings: [
        finding(),
        finding({ id: "F-3", check_id: undefined, requirement: "Evidencija obrade", category: "smjernica", status: "gap", verification: "djelomično", evidence: [], action: "Dopuniti evidenciju" }),
        finding({ id: "F-4", requirement: "Zapisi (logovi)", category: "interno", status: "insufficient", verification: "potrebna provjera", evidence: [], action: "Zatražiti uzorak zapisa" }),
    ],
    unread_documents: ["Prilog B (skenirani PDF)"],
    source_conflicts: ["Ugovor i politika različito navode rok čuvanja"],
    warning: "REVIEW",
    superseded: ["F-2"],
    counts: { material: 0, gap: 1, legal: 0, insufficient: 1, ok: 1 },
    total: 3,
    changes: { from_version: 1, closed: ["F-1"], added: ["F-4"], changed: ["F-3"], superseded: ["F-2"] },
    ...over,
});

describe("AssessmentCard — REZULTAT", () => {
    it("header, counts as soft dots, warning level, what changed, one row per finding (hr)", () => {
        const c = renderIn("hr", <AssessmentCard assessment={snapshot()} onContinue={() => {}} />);
        const card = c.querySelector('[data-slot="assessment-card"]')!;
        expect(card.getAttribute("aria-label")).toBe("Rezultat · v2");
        expect(card.textContent).toContain("Provjera alata za zapošljavanje · PROC-1A2B · RT-10");
        const header = card.querySelectorAll("p")[1];
        expect([...header.querySelectorAll('[data-slot="status-dot"]')].map((d) => d.getAttribute("aria-label"))).toEqual([
            "Materijalni problem",
            "Nedostatak",
            "Potrebna pravna procjena",
            "Nedovoljno informacija",
            "Nema materijalnog nedostatka",
        ]);
        expect(header.textContent).toBe("🔴0🟡1🔵0⚪1🟢13 nalaza");
        expect(card.querySelector('[data-slot="badge"]')?.textContent).toBe("REVIEW");
        expect(card.textContent).toContain("U odnosu na v1: zatvoreno 1 · novo 1 · promijenjeno 1 · zamijenjeno 1");
        const rows = [...card.querySelectorAll("tbody tr")];
        expect(rows).toHaveLength(3);
        expect([...rows[0].querySelectorAll("td")].map((td) => td.textContent)).toEqual([
            "F-1AA-20",
            "Ljudski nadzor s ovlašću odbijanja",
            "zakon",
            "🟢",
            "provjereno",
            "1",
            "—",
        ]);
        expect(rows[2].querySelector('[data-slot="status-dot"]')?.getAttribute("aria-label")).toBe("Nedovoljno informacija");
        expect(card.textContent).toContain("Nepročitani dokumenti: Prilog B (skenirani PDF)");
        expect(card.textContent).toContain("Proturječni izvori: Ugovor i politika različito navode rok čuvanja");
    });

    it("in English, with the record's Croatian labels translated", () => {
        const c = renderIn("en", <AssessmentCard assessment={snapshot()} />);
        const card = c.querySelector('[data-slot="assessment-card"]')!;
        expect(card.getAttribute("aria-label")).toBe("Result · v2");
        expect(card.textContent).toContain("Against v1: closed 1 · new 1 · changed 1 · superseded 1");
        const row = [...card.querySelectorAll("tbody tr")][1];
        expect(row.textContent).toContain("guidance");
        expect(row.textContent).toContain("partly verified");
        // No handler → no "continue" button.
        expect(c.textContent).not.toContain("Continue the assessment");
    });

    it("collapses a long list of findings", () => {
        const many = Array.from({ length: 11 }, (_, i) => finding({ id: `F-${i + 1}` }));
        const c = renderIn("hr", <AssessmentCard assessment={snapshot({ findings: many, total: 11, changes: undefined })} />);
        expect(c.querySelectorAll("tbody tr")).toHaveLength(8);
        const more = [...c.querySelectorAll("button")].find((b) => b.textContent === "Prikaži sve (11)")!;
        act(() => more.click());
        expect(c.querySelectorAll("tbody tr")).toHaveLength(11);
        expect(c.textContent).not.toContain("U odnosu na");
    });

    it("Nastavi procjenu selects the task again with the assessment id filled in", () => {
        const onContinue = vi.fn();
        const c = renderIn("hr", <AssessmentCard assessment={snapshot()} onContinue={onContinue} />);
        const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Nastavi procjenu")!;
        act(() => btn.click());
        expect(onContinue).toHaveBeenCalledWith({
            workflow: { id: "ctx-ctx-1-RT-10", title: "RT-10 Provjera usklađenosti dokumenta", type: "assistant" },
            text: "Nastavi procjenu PROC-1A2B: ",
        });
    });

    it("Preuzmi kao Excel writes one row per finding through the table export", async () => {
        const c = renderIn("hr", <AssessmentCard assessment={snapshot()} />);
        const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Preuzmi kao Excel")!;
        await act(async () => btn.click());
        expect(downloadTableAsXlsx).toHaveBeenCalledTimes(1);
        const [rows, names] = downloadTableAsXlsx.mock.calls[0] as unknown as [string[][], { fileName: string; sheetName: string }];
        expect(names).toEqual({ fileName: "Procjena PROC-1A2B v2", sheetName: "Nalazi" });
        expect(rows[0].slice(0, 6)).toEqual(["ID", "Provjera", "Zahtjev", "Kategorija", "Primjenjivost", "Status"]);
        expect(rows[1].slice(0, 9)).toEqual([
            "F-1", "AA-20", "Ljudski nadzor s ovlašću odbijanja", "zakon", "sada",
            "Nema materijalnog nedostatka", "provjereno", "dokument", "Prilog 2.pdf, 2: „ovlast odbijanja”",
        ]);
        expect(rows).toHaveLength(4);
    });

    const withChecker = () =>
        snapshot({
            facts: [
                { id: "C-1", statement: "Sustav rangira kandidate", status: "document_supported", evidence: [{ doc_id: "doc-1", filename: "Politika.docx", quote: "rangira prijave", page: "str. 2" }] },
                { id: "C-2", statement: "Organizacija sustav kupuje", status: "user_asserted", evidence: [] },
            ],
            decisions: [
                { id: "CHK-U1-Q1", use_case_id: "U1", topic: "Checker Q1 — uloga organizacije", classification: null, reasoning: "Odgovor: subjekt koji uvodi sustav.", legal_sources: ["čl. 3. t. 4. Akta"], fact_ids: ["C-2"] },
                { id: "CHK-U1-QAIS5", use_case_id: "U1", topic: "Checker QAIS 5 — Prilog III.", classification: "potencijalno visokorizičan", limitation: "INTERPRETATION REQUIRED", reasoning: "Odgovor: zapošljavanje. Odluka pala ovdje.", legal_sources: ["Prilog III. t. 4. Akta"], fact_ids: ["C-1"] },
            ],
        });

    it("the classification per use case and the path through the Checker, the decisive question marked, with its evidence", () => {
        const c = renderIn("hr", <AssessmentCard assessment={withChecker()} />);
        const card = c.querySelector('[data-slot="assessment-card"]')!;
        expect(card.textContent).toContain("Klasifikacija");
        expect(card.querySelector("ul li")?.textContent).toBe(
            "U1 · potencijalno visokorizičan · INTERPRETATION REQUIRED — Checker QAIS 5 — Prilog III.",
        );
        // Collapsed: only the findings table.
        expect(c.querySelectorAll("table")).toHaveLength(1);
        const toggle = [...c.querySelectorAll("button")].find((b) => b.textContent === "Put kroz Checker · 2 pitanja")!;
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        act(() => toggle.click());
        const checker = c.querySelectorAll("table")[0];
        const rows = [...checker.querySelectorAll("tbody tr")];
        expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
            ["Checker Q1 — uloga organizacije", "Odgovor: subjekt koji uvodi sustav.", "izjava"],
            ["Checker QAIS 5 — Prilog III.odluka", "Odgovor: zapošljavanje. Odluka pala ovdje. · INTERPRETATION REQUIRED", "Politika.docx, str. 2"],
        ]);
        expect(rows[1].querySelector('[data-slot="badge"]')?.getAttribute("title")).toBe("Na ovom je pitanju pala odluka o klasifikaciji");
        expect([...c.querySelectorAll("button")].some((b) => b.textContent === "Sakrij put kroz Checker")).toBe(true);
    });

    it("Excel gets a second sheet with the decisions and the Checker path", async () => {
        const c = renderIn("hr", <AssessmentCard assessment={withChecker()} />);
        const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Preuzmi kao Excel")!;
        await act(async () => btn.click());
        const [, , more] = downloadTableAsXlsx.mock.calls[0] as unknown as [string[][], unknown, { sheetName: string; rows: string[][] }[]];
        expect(more).toHaveLength(1);
        expect(more[0].sheetName).toBe("Odluke i Checker");
        expect(more[0].rows[0]).toEqual(["ID", "Namjena", "Pitanje ili tema", "Klasifikacija", "Ograničenje", "Obrazloženje", "Odredbe", "Dokaz"]);
        expect(more[0].rows[2]).toEqual([
            "CHK-U1-QAIS5", "U1", "Checker QAIS 5 — Prilog III.", "potencijalno visokorizičan", "INTERPRETATION REQUIRED",
            "Odgovor: zapošljavanje. Odluka pala ovdje.", "Prilog III. t. 4. Akta", "Politika.docx, str. 2",
        ]);
    });

    it("no Checker section and a single sheet when the record has no decisions", async () => {
        const c = renderIn("hr", <AssessmentCard assessment={snapshot()} />);
        expect(c.textContent).not.toContain("Klasifikacija");
        expect(c.textContent).not.toContain("Put kroz Checker");
        const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Preuzmi kao Excel")!;
        await act(async () => btn.click());
        expect((downloadTableAsXlsx.mock.calls[0] as unknown[])[2]).toEqual([]);
    });
});

describe("assessment events", () => {
    it("a message shows its latest version; malformed snapshots are ignored", () => {
        const v1 = snapshot({ version: 1, changes: undefined });
        const v2 = snapshot();
        expect(latestAssessment([{ type: "assessment_recorded", assessment: v1 }, { type: "content", text: "x" }, { type: "assessment_recorded", assessment: v2 }])?.version).toBe(2);
        expect(latestAssessment([{ type: "content", text: "x" }])).toBeNull();
        expect(parseAssessmentSnapshot({ assessment_id: "x", version: "2", findings: [], counts: {} })).toBeNull();
        expect(parseAssessmentSnapshot({ assessment_id: "x", version: 1, findings: [], counts: {} })?.unread_documents).toEqual([]);
    });
});
