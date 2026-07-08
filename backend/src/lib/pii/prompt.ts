/**
 * PII Shield — system prompt addendum.
 *
 * When a chat turn runs through the sidecar (mode != "off"), documents
 * arrive at the LLM with `⟦PII:ENTITY_TYPE_N⟧` placeholders standing in
 * for sensitive values. Without explicit instructions, models tend to:
 *
 *   1. Replace placeholders with generic terms ("the party", "the
 *      claimant", "the user"), silently dropping coreference — which
 *      destroys our ability to lazily de-anonymise the answer on the
 *      client (the placeholders never appear, so `usePiiRenderedText`
 *      finds nothing to render).
 *
 *   2. Hallucinate real values ("John Smith", "12 Main St") even though
 *      the source text contained `⟦PII:PERSON_1⟧`. That's a fabrication
 *      vulnerability we want to forbid by policy.
 *
 *   3. Treat placeholders as REDACTED markers and explicitly refuse,
 *      saying "this information has been removed". Which is wrong:
 *      the information is NOT removed, only proxied — and the user will
 *      see the real value on their device after the round-trip.
 *
 * This addendum tells the model exactly what placeholders mean and
 * how to use them. It's injected ONLY when the chat is in an active
 * PII mode; otherwise it would just waste prompt tokens.
 *
 * Wording rules:
 *  - Bilingual (hr + en) because the chat itself may run in either UI
 *    language; the rules are too important to be lost in translation.
 *  - Concrete examples ("⟦PII:PERSON_1⟧ je dužnik" vs "Dužnik je…")
 *    make the rule unambiguous in practice. LLMs follow examples far
 *    more reliably than abstract directives.
 *  - Short — adds ~700 input-tokens per turn, which is acceptable for
 *    privacy-critical surfaces.
 */

import type { PiiMode } from "./client";

/**
 * Render the addendum string for the given mode/locale.
 *
 * Returns an empty string when the mode is "off" so callers can append
 * unconditionally without a null check at the call site.
 */
export function piiSystemPromptAddendum(args: {
    mode: PiiMode | "off";
    locale: "hr" | "en";
}): string {
    if (args.mode === "off") return "";

    const headerHr =
        "PII SHIELD — chat radi s anonimiziranim podacima.";
    const headerEn =
        "PII SHIELD — this chat operates on anonymised data.";

    const bodyHr = `
Svi osjetljivi podaci u dokumentima koje si dobio (imena fizičkih osoba, OIB,
adrese, IBAN-ovi, datumi rođenja, brojevi telefona, e-mail adrese, brojevi
predmeta itd.) zamijenjeni su tokenima oblika:

    ⟦PII:ENTITY_TYPE_N⟧

Primjeri: ⟦PII:PERSON_1⟧, ⟦PII:HR_OIB_2⟧, ⟦PII:EMAIL_ADDRESS_3⟧,
⟦PII:LOCATION_1⟧, ⟦PII:PHONE_NUMBER_1⟧, ⟦PII:HR_IBAN_1⟧.

Apsolutno obvezna pravila:

1. Kad u svom odgovoru spomeneš osobu, broj, datum, adresu ili bilo koji
   drugi entitet koji je u izvornom tekstu predstavljen placeholder-om —
   MORAŠ DOSLOVNO PREPISATI taj placeholder uključujući zagrade ⟦ ⟧.
   ISPRAVNO: "⟦PII:PERSON_1⟧ je dužnik."
   POGREŠNO: "Dužnik je [redacted]." ili "Dužnik je Ivan Horvat."

2. ISTI placeholder za ISTU osobu — koristi koreferenciju.
   Ako se ⟦PII:PERSON_1⟧ pojavljuje više puta, uvijek ponovi isti broj.
   NIKAD ne preimenuj entitete niti mijenjaj brojeve.

3. NIKAD ne izmišljaj prave vrijednosti.
   Ako u tekstu nigdje nema "Ivan Horvat", ne smiješ pisati to ime u
   odgovoru čak i ako ti se čini logično iz konteksta. Koristi placeholder.

4. NEMOJ ih smatrati redaktiranima ili izbrisanima.
   Podaci NISU obrisani — naš sustav ih privatno čuva i prikazat će
   stvarnu vrijednost korisniku kad render izvrši na njegovom uređaju.
   Tvoj zadatak je samo zadržati placeholdere u odgovoru.

5. Ako odgovor zahtijeva spominjanje entiteta koji NIJE u tekstu (npr.
   korisnik pita "tko je predsjednik RH?" — nema veze s ugovorom):
   slobodno odgovori uobičajeno. Ovo pravilo vrijedi SAMO za entitete
   koji su prisutni u tekstu kao placeholder.

6. Strukturirani odgovori (npr. JSON, tablice, popis stranaka):
   sva polja koja sadrže imena/OIB/IBAN itd. moraju također sadržavati
   placeholder, ne stvarne vrijednosti.

Korisnik ne vidi sirove ⟦PII:…⟧ tokene — frontend ih automatski zamijeni
stvarnim vrijednostima nakon tvog odgovora. Tvoj odgovor MORA sadržavati
placeholdere doslovno kako bi taj mehanizam radio.
`.trim();

    const bodyEn = `
All sensitive values in the documents you received (natural-person names,
national IDs, addresses, IBANs, dates of birth, phone numbers, email
addresses, case numbers, etc.) have been replaced with tokens of the form:

    ⟦PII:ENTITY_TYPE_N⟧

Examples: ⟦PII:PERSON_1⟧, ⟦PII:HR_OIB_2⟧, ⟦PII:EMAIL_ADDRESS_3⟧,
⟦PII:LOCATION_1⟧, ⟦PII:PHONE_NUMBER_1⟧, ⟦PII:HR_IBAN_1⟧.

Hard rules:

1. When you refer in your answer to a person, number, date, address or
   any other entity represented by a placeholder in the source text,
   YOU MUST REPRODUCE THE PLACEHOLDER EXACTLY, including the brackets.
   GOOD: "⟦PII:PERSON_1⟧ is the debtor."
   BAD:  "The debtor is [redacted]." or "The debtor is John Smith."

2. SAME placeholder for the SAME entity — preserve coreference. If
   ⟦PII:PERSON_1⟧ occurs multiple times, always reuse the same number.
   Never renumber or rename.

3. NEVER invent real values. If "John Smith" does not appear in the
   text, you must NOT write that name in your answer even if it seems
   contextually plausible. Use the placeholder.

4. Placeholders are NOT redactions or deletions. The information is
   preserved privately in our system and will be restored on the
   user's device when the answer is rendered. Your job is to keep the
   placeholders intact.

5. If the answer requires mentioning an entity that does NOT appear in
   the text (e.g. user asks "who is the president of Croatia?", unrelated
   to the contract), answer normally. This rule applies only to entities
   that are present as placeholders.

6. Structured answers (JSON, tables, party lists): every field carrying
   a name/national-ID/IBAN etc. must also contain the placeholder, not
   the real value.

The user does not see the raw ⟦PII:…⟧ tokens — the frontend swaps them
back to real values after your response. Your answer MUST carry the
placeholders verbatim for that mechanism to work.
`.trim();

    if (args.locale === "hr") {
        return `\n\n---\n${headerHr}\n\n${bodyHr}\n---\n`;
    }
    return `\n\n---\n${headerEn}\n\n${bodyEn}\n---\n`;
}
