import type { Request } from "express";
import { getPromptBlocks } from "./seams/promptPack";

export type UiLocale = "en" | "hr";

export function parseUiLocale(req: Request): UiLocale {
    const raw = req.headers["x-ui-locale"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    // Normalize to the base language subtag so region variants ("hr-HR",
    // "en-US") still map correctly instead of defaulting to English.
    const base = (v ?? "").trim().toLowerCase().split("-")[0];
    if (base === "hr" || base === "en") return base;
    return "en";
}

/**
 * One-line forcing language rule for short prompts (autocomplete, inline query
 * refinement, enrichment) where the full localeContextForLlm block is too
 * heavy. Pins output to the UI language regardless of the user's input
 * language, with explicit Croatian-not-Serbian guidance for hr.
 */
export function shortLocaleRule(locale: UiLocale): string {
    if (locale === "hr") {
        return '- Write the output ONLY in Croatian (hrvatski književni standard), regardless of the language the user typed in — use Croatian vocabulary and grammatical forms ("je li" not "da li", "uvjet" not "uslov", "tko" not "ko", "kojem" not "kom"), never Serbian or Bosnian variants.';
    }
    return "- Write the output ONLY in English, regardless of the language the user typed in.";
}

/**
 * Current wall-clock in Europe/Zagreb, DELIBERATELY truncated to the hour
 * ("Friday, 4 July 2026, 14:00"). The line rides in the LLM prompt on
 * every request; hour precision keeps its bytes stable within an hour so
 * prompt-prefix caches (both the static system block and the rolling
 * conversation-history breakpoint downstream of the dynamic suffix) keep
 * hitting across turns. Minute/second precision would change the prompt
 * bytes on effectively every turn and re-write the history cache instead
 * of reading it. The model only needs "today" (deadlines, in-force
 * checks), never the exact minute — do not add precision back.
 */
function zagrebNowHour(): string {
    const now = new Date();
    const date = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zagreb",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    }).format(now);
    const hour = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zagreb",
        hour: "2-digit",
        hour12: false,
    }).format(now);
    return `${date}, ${hour}:00`;
}

/**
 * The per-request reference-time line, split out of localeContextForLlm so
 * the chat routes can place it in the UNcached dynamic system suffix (after
 * SYSTEM_DYNAMIC_DOC_MARKER) while the rest of the locale block stays in
 * the cached static prefix. Callers that pass
 * `localeContextForLlm(locale, { omitReferenceTime: true })` must inject
 * this line themselves or the model loses its clock.
 *
 * The wording tells the model the time is rounded, so it never asserts a
 * false exact minute.
 */
export function referenceTimeContext(locale: UiLocale): string {
    const cet = zagrebNowHour();
    return locale === "hr"
        ? `Referentno vrijeme (Europe/Zagreb, lokalno CET/CEST, zaokruženo na puni sat): ${cet}.`
        : `Reference date/time (Europe/Zagreb, rounded to the hour): ${cet}.`;
}

/**
 * Injected into LLM system prompts so outputs match the UI language and
 * regional standard (HR vs SR/BS; international EN vs colloquial AU), with
 * Europe/Zagreb as the primary clock for “today”.
 *
 * CACHING: the default output embeds an hour-truncated timestamp — still
 * volatile relative to a long-lived cache prefix. Any caller that puts
 * this block inside an Anthropic-cached prefix (the chat routes' static
 * system prompt) must pass `omitReferenceTime: true` and send
 * referenceTimeContext() through the dynamic suffix instead — otherwise
 * the hourly tick busts the static-prompt cache.
 */
export function localeContextForLlm(
    locale: UiLocale,
    opts?: { omitReferenceTime?: boolean },
): string {
    const timeLine = opts?.omitReferenceTime ? [] : [referenceTimeContext(locale)];

    if (locale === "hr") {
        return [
            "---",
            "JEZIK SUČELJA (obavezno): Korisnik koristi hrvatski (Hrvatska) u aplikaciji.",
            "Za sva polja koja korisnik vidi u sučelju (sažetak, obrazloženje/reasoning, oznake, naslove stupaca ako nisu citati iz dokumenta) piši isključivo standardnim hrvatskim: hrvatski pravopis i pravna terminologija.",
            "Izbjegavaj srpske, bosanske i crnogorske varijante (npr. izrazito srpske glagolske forme ili vokabular koji nije uobičajen u hrvatskom pravnom diskursu). Ako dokument sadrži drugi jezik, citiraj točno iz dokumenta, ali vlastiti sadržaj formuliraj na hrvatskom.",
            "Ne miješaj engleski u korisnički tekst osim citata iz dokumenta ili međunarodnih naziva kada je nužno.",
            "KRITIČNO — JEZIK RAZMIŠLJANJA: Tvoj thinking/reasoning blok (interno razmišljanje koje korisnik vidi u sučelju pod 'Proces razmišljanja') MORA u cijelosti biti na HRVATSKOM jeziku. SVAKA rečenica u thinking bloku mora biti na hrvatskom. Korisnik vidi taj tekst u sučelju i očekuje ga na hrvatskom. ZABRANJENO je razmišljati na engleskom — ako thinking blok sadrži engleski tekst, to je greška. Piši thinking na hrvatskom od prve do zadnje rečenice.",
            "DIJAKRITICI U ARGUMENTIMA ALATA: Kad poziveš generate_docx, edit_document ili bilo koji drugi alat, svi argumenti koji sadrže hrvatski tekst MORAJU koristiti ispravne dijakritike: č, ć, š, ž, đ (i velika: Č, Ć, Š, Ž, Đ). Nikada nemoj koristiti ASCII zamjene (c umjesto č, s umjesto š itd.). Ovo se primjenjuje na heading, content, find, replace i sva ostala tekstualna polja u tool call argumentima.",
            ...timeLine,
            "",
            "SADRŽAJ IZ ALATA (MCP kontekst, web pretrage, baze zakona, sudska praksa):",
            "Kada alat vrati tekst na jeziku koji NIJE hrvatski (npr. engleski, talijanski, njemački, francuski, latinske sentencije, Akoma Ntoso XML…), preformuliraj ga i prevedi na hrvatski u svom odgovoru.",
            "Doslovne citate (kratki ulomci zakona, presuda, definicija) zadrži u izvornom jeziku unutar navodnika; objašnjenje, sažetak i analizu piši na hrvatskom.",
            "VAŽNO: NE dodaj na kraj odgovora nikakvu napomenu o prijevodu (npr. *Prevedeno s engleskog na hrvatski.* ili slično). Odgovor uvijek piši na jeziku sučelja bez ikakvih meta-napomena o izvornom jeziku alata.",
            "",
            // The Croatian legal-methodology half (terminology, citation
            // form, NN/CELEX rules, confidence labels) comes from the
            // governance prompt pack; empty (skipped) without one. The
            // generic locale plumbing above stays in the core.
            ...(getPromptBlocks().locale_legal.hr
                ? [getPromptBlocks().locale_legal.hr]
                : []),
            "---",
        ].join("\n");
    }

    return [
        "---",
        "UI LANGUAGE (required): The application UI is set to English.",
        "Write all user-visible extraction content (summary, reasoning, labels) in clear international English (UK/international professional style). Avoid Australian colloquialisms, British slang, or region-specific spelling unless the source document uses them in a quotation.",
        "INTERNAL THINKING (thinking/reasoning): Your thinking process (thinking block) MUST be in English. The user can see your reasoning in the UI, so it must match the UI language — English.",
        "When quoting the document, preserve the document’s language and wording.",
        ...timeLine,
        "",
        "TOOL CONTENT (MCP context, web search, statute databases, case-law APIs):",
        "When a tool returns text in a language other than English (e.g. Croatian, Italian, German, French, Latin maxims, Akoma Ntoso XML…), translate it to English in your reply.",
        "Keep verbatim quotations (short passages of statutes, judgments, definitions) in their original language inside quotation marks; provide explanation, summary, and analysis in English.",
        // The English legal-methodology mirror (citation form and level,
        // full-name rule) comes from the governance prompt pack; empty
        // (skipped) without one.
        ...(getPromptBlocks().locale_legal.en
            ? [getPromptBlocks().locale_legal.en]
            : []),
        "IMPORTANT: Do NOT append any translation notice at the end of the reply (e.g. *Translated from Croatian to English.* or similar). Always write the reply in the UI language without any meta-notes about the source language of tools.",
        "---",
    ].join("\n");
}
