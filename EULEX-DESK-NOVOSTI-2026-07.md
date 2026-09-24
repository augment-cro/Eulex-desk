# Eulex Desk — što je sve novo (lipanj → srpanj 2026.)

Pregled svega što je napravljeno na proizvodu **Eulex Desk** (max.eulex.ai) i na
pravnoj podatkovnoj platformi **EULEX AI** u zadnjih mjesec dana — bez samog
preimenovanja, koje ovdje ne brojimo kao feature.

> Razdoblje: ~14. 6. – 14. 7. 2026. · 237 commitova u glavnom repou + veliki
> iskoraci na EULEX podatkovnoj strani (novi MCP serveri po jurisdikcijama).

---

## 1. Konteksti (Custom Contexts) — što su i čemu služe

**Problem koji rješavaju:** svaki razgovor s AI asistentom dosad je "kretao od
nule". Odvjetnik koji stalno radi u istom regulatornom podskupu (npr. *GDPR za
hrvatski fintech*) nije imao način da taj podskup izolira, obogati vlastitim
znanjem, ponovno koristi, podijeli s kolegama ili prati njegove izmjene.

**Što je kontekst?** Imenovani, ponovno iskoristivi i djeljivi "paket znanja" —
skup pravnih izvora + vlastite upute. Sadrži:

- **Naziv i opis** — npr. „GDPR za hrvatski fintech".
- **Izvore** — kurirani popis propisa, pojedinačnih članaka, sudske prakse i
  web-poveznica. Svaki izvor je **prikvačen** (tekst je uvijek u vidokrugu) ili
  **dohvatljiv** (dohvaća se po potrebi), uz kratku napomenu kako ga čitati.
- **Bilješke / upute** — markdown s vlastitim tumačenjima, stavovima ureda i
  praktičnim smjernicama; to znanje ulazi u svaki relevantni razgovor.
- **Obavijesti (alerts)** — uključi/isključi: „javi mi kad se bilo koji praćeni
  propis promijeni" (v1: EU propisi; in-app indikator + dnevni e-mail digest).
- **Dijeljenje** — privatno / s imenovanim kolegama / s cijelim timom.

**Kako se koristi i što korisnik dobiva:**

- **Fokusirano pretraživanje.** Kad je kontekst uključen, dohvat iz pravne baze
  ograničen je na izvore tog konteksta — manji, precizniji i izolirani okvir
  umjesto cijelog korpusa.
- **Suzdržavanje umjesto izmišljanja.** Ako pitanje izlazi izvan konteksta,
  asistent to izričito kaže („nije pronađeno unutar konteksta X") i ponudi širu
  pretragu — nikad tiho ne širi opseg.
- **Tri načina korištenja:** globalni prekidač u composeru (ostaje aktivan
  preko razgovora, s trajnim čipom), prilaganje workflowu ili projektu.
- **Kreiranje iz razgovora.** „Spremi kao kontekst" iz chata — automatski
  povlači citirane izvore i skicira upute iz načina na koji su korišteni.
- **Izvoz/uvoz** kao verzionirani „context pack" (temelj budućeg Context
  Storea — kupnja/pretplata/objava konteksata).

*Status: implementirano i na stagingu; EU-alerting i posljednje ovisnosti u
dovršavanju prije LIVE-a.*

---

## 2. PII zaštita (Eulex PII Shield)

Zaseban servis koji je **jedini** dio sustava koji ikad vidi vezu između
stvarnih osobnih podataka i njihovih zamjenskih oznaka. Glavni backend i
frontend **nikad ne dešifriraju PII**.

**Kako radi (pseudonimizacija, „sandwich" uzorak):**

1. **Anonimizacija** — pri čitanju dokumenta ili unosa, tekst prolazi kroz
   detekciju entiteta (Microsoft Presidio + spaCy) i stvarne vrijednosti se
   zamjenjuju oznakama poput `⟦PII:PERSON_1⟧`.
2. **LLM vidi samo oznake** — Claude/GPT/Gemini nikad ne primaju stvarna imena,
   adrese, OIB-e, IBAN-e…; čak se i odgovori **pohranjuju** s oznakama.
3. **Vraćanje na uređaju** — stvarne vrijednosti vraćaju se tek pri prikazu u
   pregledniku korisnika; u bazi su šifrirane (AES-256-GCM + Cloud KMS).

**Hrvatski prepoznavatelji s pravom validacijom:** OIB (ISO 7064 kontrolna
znamenka), hrvatski IBAN (mod-97), MBS, **brojevi sudskih predmeta**
(P-, Gž-, Kž-, St-…), poštanski brojevi — uz standardne (osobe, e-mail,
telefon, kartice, lokacije). Ista vrijednost unutar sesije uvijek dobiva istu
oznaku, i preko više dokumenata.

**Razine zaštite po razgovoru:** `off` / `standard` / `strict_legal`
(obavezni pregled anonimizacije svakog novog dokumenta) / `strict`
(**fail-closed**: pri bilo kakvoj grešci dokument se uskraćuje, blokiraju se i
alati). U composeru je vidljiva PII značka (shield ikona s tooltipom).

**Novo ovaj mjesec:** PII pokrivenost proširena na **sve LLM putove** (korisnički
unosi, generiranje naslova, obogaćivanje upita, tabularne Analize i predlagač
stupaca); vlastita, odvojena **`pii` baza** s Row-Level Securityjem (glavni
backend fizički ne može čitati stvarne vrijednosti); GDPR čl. 30 audit log s
13-mjesečnom retencijom; hardening prepoznavatelja (grupirani IBAN-i, prefiksi
sudova, neutralizacija lažnih oznaka).

---

## 3. Usklada dizajna — paper/ink redizajn

Cijela aplikacija prebačena je na **paper/ink dizajn-sustav dijeljen s
eulex.ai** stranicom — jedinstven vizualni identitet weba i proizvoda:

- **Topli krem „papir", tinta-smeđi tekst**, Sentient (serif) + Azeret Mono
  tipografija, bez sjena — dubina se gradi kontrastom; štedljivi lime /
  magenta / cijan akcenti (jedan pravi CTA po ekranu).
- **Jedan izvor teme:** tokeni žive u ograđenoj `SHARED THEME` sekciji,
  identičnoj u aplikaciji i na marketinškoj stranici.
- **Prekidač tema za korisnika:** paper ⇄ tamna tema.
- Zabranjene tvrdo kodirane boje — automatska provjera prije svakog deploya.
- EULEX logotip na svim površinama; usklađene ikone, brand ikone na
  social-login gumbima.

Uz redizajn i niz UI poboljšanja: **preuređeni sidebar** (grupiranje razgovora,
prikvačivanje, arhiva, promjenjiva širina), **composer** (toolbar koji se
prilagođava širini, PII i enrichment ikone s tooltipovima, slanje s priloženim
dokumentom/workflowom bez teksta), **prsten dnevne potrošnje** tokena s
postocima.

---

## 4. Pravni izvori: nove države i vremenska ljestvica

Najveći iskorak na podatkovnoj strani — EULEX platforma sada pokriva **tri
jurisdikcije kroz jedinstveni sustav** (EU + Hrvatska + Francuska), a u
aplikaciji su citati iz sve tri klikabilni.

### 🇭🇷 Hrvatska — zakonodavstvo + sudska praksa

- **28.900 propisa**, 47.247 verzija, 7,5 milijuna segmenata dokumenata,
  pokrivenost od 1811. do danas (Narodne novine).
- **Sudska praksa: 180.000+ sudskih odluka** (1,3 milijuna segmenata) s
  ECLI oznakama, sudom i poslovnim brojem; semantičko indeksiranje korpusa u
  tijeku (korpus se dalje proširuje). Četiri nova alata: pretraga prakse,
  dohvat odluke, citati u odluci, povezane odluke.
- **Point-in-time**: dohvat članka „na dan" (`as_of`), povijest verzija i
  NN-lineage kroz `hr_get_status`.

### 🇫🇷 Francuska — Légifrance

- **50 kodova** (Code civil, Code de commerce…), **34.000+ članaka**,
  62.884 verzije članaka, semantička pretraga.
- Dohvat članka na važeći datum ili bilo koji povijesni datum + **povijest
  verzija članka** (`fr_get_article_versions`).

### 🇪🇺 Europska unija

- **200.000+ dokumenata** (uredbe, direktive, odluke, praksa Suda EU),
  581.000+ sekcija, graf znanja s ~803.000 čvorova / 2,2 milijuna veza,
  ~2,3 milijuna vektorskih embeddinga.
- Podrška upita na **engleskom, hrvatskom, njemačkom, francuskom, talijanskom
  i španjolskom** (EU sinteza).
- Provjera važenja (`verify`, uz live EUR-Lex Cellar provjeru), status
  transpozicije direktiva, Eurostat statistika.

### ⏱ Vremenska ljestvica (timeline)

- **EU `get_timeline`** — kronologija pravnih događaja dokumenta: objava,
  stupanje na snagu, datumi primjene, izmjene, stavljanje izvan snage.
  **4.108 verificiranih događaja**, uz filtar po vrsti događaja; radi i s
  uobičajenim imenima (GDPR, AI Act, DORA, NIS2, DSA, DMA).
- **HR/FR verzijske ljestvice** — povijest izmjena propisa/članka kroz vrijeme
  s dohvatom teksta kakav je vrijedio na određeni datum.

### Jedinstveni EULEX server

Novi objedinjeni MCP server pokriva **@hr + @eu + @fr kroz jedan skup alata**
(17 alata, jedinstvena URI shema `@hr/Zakon o radu`, `@eu/GDPR`…). Dodavanje
nove države više ne traži nove alate — samo novi backend u registru. Uz to i
**parra.hr** računovodstveni proxy (HR propisi + mišljenja Porezne uprave +
TEB članci).

---

## 5. Citati i pravni panel u aplikaciji

- **Inline citati u odgovoru** za sve tri jurisdikcije (EUR-Lex, Narodne
  novine, Légifrance) — podcrtana referenca u tekstu odgovora.
- **Desni panel s izvorom:** klik na citat odmah prikazuje citirani odlomak, u
  pozadini dohvaća **cijeli dokument** i skrola na citirano mjesto. Gumb uvijek
  vodi na službeni izvor.
- **Precizni pinpoint:** panel razumije „članak 38. stavak 2. točka a)" —
  članak se označava zeleno, točan stavak/točka magenta markerom. Ako
  strukturnog poklapanja nema, radije ne označava ništa nego pogrešno.
- **Hrvatska sudska praksa klikabilna** — prepoznavanje citata odluka, bedževi
  i oznake u panelu; podrška za članke sa sufiksom (npr. 17.a).
- Ispravljen redoslijed naslova članaka u prikazu cijelog HR zakona
  (podnaslov prije naslova članka).

---

## 6. Analize (tabularni pregled dokumenata)

- Tablični prikaz: **retci = dokumenti, stupci = pitanja** koja definirate;
  svaku ćeliju odgovara AI, s **citatom natrag u izvorni dokument**.
- **AI predlagač stupaca** — predlaže stupce na temelju dokumenata, uz živi
  prikaz napretka.
- Formatirani odgovori po tipu stupca (da/ne, datum, tekst…), chat panel po
  analizi, prikaz napretka izvođenja.
- Niz ispravaka ovaj mjesec: pouzdano čuvanje dokumenata analize, lokalizirani
  izvoz, ispravan prikaz napretka; zadani model za Analize sada je
  **Claude Sonnet** za sve korisnike.

---

## 7. Računi, prijava i platforma

- **Nova prijava (Supabase Auth):** e-mail + lozinka, magic-link/OTP prijava,
  zaboravljena lozinka, **Google i Microsoft (Entra) prijava** — umjesto stare
  WordPress prijave; migracija postojećih korisnika. Domena **app.eulex.ai**.
- **Naplata (Stripe):** samoposlužno **otkazivanje obnove pretplate**, ispravno
  praćenje razdoblja pretplate, cjenici po tierovima povezani sa Stripe
  proizvodima, MRR na admin dashboardu.
- **Kvote i tierovi:** dnevne token-kvote po tieru s prikazom potrošnje u
  composeru; definicije tierova centralizirane.
- **AdminMax (administracija):** audit trag administratorskih radnji, globalni
  popis razgovora, analitika korištenja po površinama, **BugFix statusna
  ploča** (živo praćenje GitHub issue-a/PR-ova/deploya), kolone tier + cijena,
  kartica plaćenih korisnika.
- **Kvaliteta i jezik:** sustavni i18n prolaz (svi vidljivi stringovi kroz
  hr/en lokalizaciju, uključujući poruke o greškama s backenda), garancija
  latinice u hrvatskim odgovorima na svim modelima.
- **Veliki bug-sweep:** sekcijski pregled cijele aplikacije (asistent,
  projekti, Analize, workflowi, konteksti) — zatvoreno **40+ prijavljenih
  bugova** u jednom valu (#84–#126), plus raniji val (#10–#76).

---

*Dokument sastavljen 14. 7. 2026. iz git povijesti (`nforum/mike`), interne
dokumentacije (`_ai/`) i EULEX podatkovnog repoa (`eulex_endpoint`).*
