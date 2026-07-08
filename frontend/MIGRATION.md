# MIGRATION.md — shadcn / komponentizacija frontenda

Plan migracije Max frontenda s legacy raw-`className` koda na shadcn + tokene.
Nadopunjuje [CLAUDE.md](../CLAUDE.md) (pravila dizajna). Ovaj dokument je **plan
i checklist** — kako trenutno stojimo, što treba napraviti, kojim redom.

> Cilj: prebaciti što više UI-a na komponente bez "big bang" prepisivanja.
> Temelj (shadcn + tokeni + `cn()`) već postoji — posao je **usvajanje**, ne gradnja.

---

## 1. Trenutno stanje (dijagnoza)

### Temelj koji već postoji ✅
- **9 vendoranih primitiva** u `src/components/ui/`: `button`, `badge`, `input`,
  `dialog`, `dropdown-menu`, `tabs`, `tooltip`, `cite-button`, `text-search-widget`.
  7 prati ispravan pattern (cva + `cn()` + `data-slot` + `VariantProps`).
  `cite-button` i `text-search-widget` su stari (hardkodirane boje) → modernizirati.
- **Token sustav** u `src/app/globals.css`: OKLCH semantički tokeni, brand-blue
  ramp `rgb(0,136,255)`, zasebna EULEX paleta (landing), fontovi, radius skala.
- **`cn()`** (`src/lib/utils.ts`) = clsx + tailwind-merge.
- **Uzor kako treba izgledati sve:** `src/app/components/account/PlanCards.tsx`
  (koristi `Badge`, `cn()`, semantičke tokene).

### Dug (brojke)
| Mjera | Količina |
|---|---|
| Fajlovi s raw template-literal `className` | ~103–122 |
| `text-gray-*` / `bg-gray-*` / `border-gray-*` (trebaju biti tokeni) | ~1.121 pojava |
| `text-blue-*` / `bg-blue-*` | ~55 |
| Hardkodirani hex (#RRGGBB) | ~39 |
| Ručni modali (`fixed inset-0`) | **28** |
| Primitiva realno u upotrebi | ~4 (`Button`, `Dialog`, `DropdownMenu`, `Tooltip`) |

**Zaključak:** temelj 9/10, usvajanje 2/10.

### Kako su ključne površine napravljene danas
- **App shell** — `src/app/(pages)/layout.tsx`: raw className, hardkodirani sivi
  (`bg-white`, `border-gray-100`), raw `<button>` za mobilni header.
- **Lijevi bar** — `src/app/components/shared/AppSidebar.tsx` (~317 linija):
  monolit, ternari u template literalima, hardkodirani sivi. State (collapse,
  localStorage, responsive) je dobar — ostaje; refaktorira se samo prezentacija.
- **Centralni ekran (chat)** — najveći i najgori po stilu fajlovi:
  `AssistantMessage.tsx` (2.394), `SuperDocView.tsx` (1.762), `ChatView.tsx` (800),
  `ChatInput.tsx` (729). Cijela assistant+shared zona (~52 fajla / ~16k linija)
  uvozi samo 4 primitiva.
- **Predmeti** — `ProjectPage.tsx` (1.884): ručna tablica, sticky stupci,
  folder-tree, inline rename. Sve raw. Tabular zona (`TRChatPanel.tsx` 1.559,
  `TabularReviewView.tsx` 885) ~98% raw.

---

## 2. Principi (provodi ih svaki PR)

1. **Tokeni, ne literali.** `bg-gray-50`→`bg-muted`, `border-gray-200`→`border-border`,
   `text-gray-500`→`text-muted-foreground`. Donosi i dark mode besplatno.
2. **cva + `cn()`, ne ternari u template literalu.** Svaka komponenta s >1 stanjem
   ide kroz varijante (vidi `button.tsx`).
3. **Jedan modal / dropdown / toggle.** Konsolidacija na shadcn, ne N kopija.
4. **Nove primitive dodaj kroz shadcn MCP**, nikad iz memorije (vidi CLAUDE.md §2).
5. **Landing/login/signup ostaju na EULEX paleti** (`.eu-btn*`, `bg-paper`…) —
   ne diramo ih.

---

## 3. Pristup

Ne "big bang". Rizik regresija na chat/editor UI-u je previsok.
- **Ciljano** srušiti dijeljenu infrastrukturu (modali, sidebar, gumbi) — najviše
  fajlova uz najmanji rizik.
- **Oportunistički** — "kad diraš fajl, podigni ga na shadcn" (CLAUDE.md). Svaki
  PR ostavlja zonu čišćom.

---

## 4. Faze (checklist)

### Faza 0 — Foundation (~1–2 dana)
Dodati nedostajuće primitive preko shadcn MCP-a; modernizirati stara dva.

- [ ] `card` 🔴 (zamjenjuje `border border-gray-200 rounded-lg bg-white`, 20+ fajlova)
- [ ] `label` 🔴 (30+ form polja)
- [ ] `separator` 🔴 (10+ ručnih dividera)
- [ ] `select` 🔴 (forme / ručni dropdowni)
- [ ] `switch` 🟡 (ručni toggle u `DisplayWorkflowModal.tsx`)
- [ ] `textarea` 🟡 (`ChatInput`, `TRChatPanel`, modali)
- [ ] `skeleton` 🟡 (loaderi, `EnrichmentPanel`)
- [ ] `alert` 🟡 (rate-limit banneri)
- [ ] Modernizirati `cite-button.tsx` i `text-search-widget.tsx` na tokene
- [ ] (opcionalno) `sidebar`, `scroll-area`, `avatar`, `popover` — po potrebi

### Faza 1 — Modali (~2–3 dana) · visok impact, nizak rizik
- [ ] Napraviti `<AppModal>` wrapper oko `Dialog` (header/body/footer + close + a11y)
- [ ] Migrirati svih **28** ručnih `fixed inset-0` modala na `AppModal`/`Dialog`
- [ ] Maknuti ad-hoc z-index ljestvicu (`z-[99]`, `z-[101]`, `z-[199]`, `z-9999`…)
- [ ] Konsolidirati `modals/confirm-dialog.tsx` (zadržati promise-based hook,
      bazu prebaciti na Dialog)

Glavni pogođeni fajlovi: `projects/NewProjectModal.tsx`,
`tabular/AddNewTRModal.tsx`, `tabular/AddColumnModal.tsx`,
`workflows/{DisplayWorkflowModal,NewWorkflowModal,WFEditColumnModal,ShareWorkflowModal,WFColumnViewModal}.tsx`,
`assistant/{AssistantWorkflowModal,DocumentAnonymizationPreviewModal,SelectAssistantProjectModal}.tsx`,
`shared/{PeopleModal,UploadNewVersionModal,TopupModal,ShareChatModal,AddDocumentsModal,AddProjectDocsModal}.tsx`,
`modals/{credits-exhausted-modal,delete-chats-modal,simple-link-dialog}.tsx`.

### Faza 2 — Shell + Sidebar (~2–3 dana) · najvidljivije korisniku
- [ ] Tokenizirati `src/app/(pages)/layout.tsx` (sivi → tokeni, mobilni header → `Button`)
- [ ] Dekomponirati `AppSidebar.tsx`:
  - [ ] `<SidebarNavItem>` (cva: active/hover/disabled, icon slot)
  - [ ] `<SidebarUserMenu>` (trigger + `DropdownMenu`)
  - [ ] `<SidebarChatList>` (collapse header + chat itemi)
  - [ ] state ostaje nepromijenjen, mijenja se samo prezentacija

### Faza 3 — Gumbi, badge-evi, banneri (~3–4 dana) · globalni sweep
- [ ] Button varijante: `accept` (tamni) / `reject` (svijetli) / icon-button —
      ponavljaju se u `AssistantMessage`, `EditCard`, `DocPanel`, `SuperDocView`
      (accept/reject tracked changes)
- [ ] `<RateLimitAlert variant="soft|hard">` — spojiti `RateLimitBanner.tsx` +
      `RateLimitChatNotice.tsx`
- [ ] `<DocPill>` / `<StatusBadge>` / `<FileIcon>` — file-pillovi i badge-evi
      (`ChatInput`, paneli)
- [ ] Sweep `text-gray-*`/`bg-gray-*`/`border-gray-*` → semantički tokeni

### Faza 4 — Hotspoti (~3–5 tjedana) · najveći rizik, ide oportunistički
Dekompozicija + tokenizacija najvećih fajlova, fajl po fajl, uz testiranje:
- [ ] `AssistantMessage.tsx` (2.394) — izdvojiti ~30 sub-komponenti u zasebne fajlove
- [ ] `SuperDocView.tsx` (1.762) — izdvojiti `TrackChangePopup`, edit modal → Dialog
- [ ] `ChatInput.tsx` (729) — `ComposerInput`, `WorkflowPicker`, ghost-text hint
- [ ] `ChatView.tsx` (800) — skeleton → `Skeleton`, panel toggle → `Sheet`
- [ ] `ProjectPage.tsx` (1.884) — `<FolderTree>` (dijeli s `ProjectExplorer`),
      tablica → row-komponente
- [ ] `tabular/TRChatPanel.tsx` (1.559), `tabular/TabularReviewView.tsx` (885)

---

## 5. Sizing

| Faza | Procjena | Rizik |
|---|---|---|
| 0 — Foundation | ~1–2 dana | nizak |
| 1 — Modali | ~2–3 dana | nizak |
| 2 — Shell + Sidebar | ~2–3 dana | nizak/srednji |
| 3 — Gumbi/badge/banneri | ~3–4 dana | srednji |
| 4 — Hotspoti | ~3–5 tjedana | visok |

**Ukupno ~6–8 tjedana** (1 dev) za potpunu migraciju.
**~80% koristi dolazi iz Faza 0–3 (~2 tjedna).** Faza 4 ide oportunistički.

---

## 6. Definicija gotovog (po fajlu)
PR koji "migrira" fajl je gotov kad:
- [ ] nema raw `text-gray-*`/`bg-gray-*`/`border-gray-*` (osim namjernih iznimaka)
- [ ] nema ternara u template-literal className (koristi `cn()` / cva)
- [ ] gumbi/inputi/modali koriste `@/components/ui/*`
- [ ] nema novih `rounded-[Npx]` ni hardkodiranih hexova
- [ ] `cd frontend && node node_modules/typescript/bin/tsc --noEmit` prolazi
- [ ] i18n: svaki novi string ima ključ u `hr.json` **i** `en.json`

---

## 7. Anti-patterni (ne uvoditi)
Vidi CLAUDE.md §7. Najvažnije za ovu migraciju:
- ❌ Nova ručna modal/overlay implementacija → koristi `AppModal`/`Dialog`.
- ❌ Drugi toggle/dropdown/tooltip umjesto postojećih.
- ❌ shadcn komponenta iz memorije → dodaj kroz MCP.
- ❌ Diranje landing/login EULEX palete bez razloga.
