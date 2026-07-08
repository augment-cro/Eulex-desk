# Eulex Desk Word Add-in

Microsoft Word task pane that brings Eulex Desk's chat, project context, and
track-change suggestions directly inside Word. Same backend, same JWT
auth — paired to your Eulex Desk account via a one-time 6-digit code.

## Architecture in 30 seconds

```
Word ──► Office.js ──► taskpane (React 18, this package)
                       ├─► /auth/pair/redeem  (one-time, exchanges code for JWT)
                       └─► /chat, /projects/:id/chat (SSE), /projects, /single-documents
```

The taskpane bundle and `manifest.xml` are emitted into
`frontend/public/word-addin/` by webpack and served from the same origin
as the Eulex Desk web frontend (e.g. `https://mike.example.com/word-addin/...`).
That keeps `fetch()` from the taskpane same-origin, avoiding CORS for the
streaming chat path.

Auth flow:

1. User logs into Eulex Desk on the web (OAuth PKCE → eulex.ai).
2. On `Account → Word add-in`, frontend calls `POST /auth/pair/start`,
   gets a 6-digit code with a 5-minute TTL.
3. User installs this add-in in Word, pastes the code into the Login
   screen.
4. Add-in calls `POST /auth/pair/redeem`; backend hands over the JWT it
   stored alongside the code, and the row is deleted.
5. Add-in stores the JWT in `localStorage["mike.token"]` and uses it as
   `Authorization: Bearer …` for every subsequent request.

## Local development

### One-time setup

```bash
cd word-addin
npm install
npm run install-certs   # installs self-signed certs Office uses for sideloading
cp .env.example .env    # adjust API_BASE_URL if needed
```

The default `.env` points the add-in at `http://localhost:3001` (the
Eulex Desk backend). Adjust if you run the backend on a different host.

### Dev loop

```bash
# Start the Eulex Desk stack (in their own terminals)
npm run dev --prefix backend
npm run dev --prefix frontend

# Start the taskpane dev server (HTTPS, port 3002)
cd word-addin
npm run dev
```

Then sideload the add-in in Word:

1. Open any document in Word (desktop, not Web).
2. **Insert → Add-ins → My Add-ins → Upload My Add-in.**
3. Browse to `word-addin/manifest.xml`.

The Eulex Desk pane appears on the Home tab. Click **Open Eulex Desk**.

To pair: in the web frontend, open `Account → Word add-in`, click
**Generate pairing code**, type the 6 digits into Word.

### Generating a pairing code from the CLI (for quick iteration)

```bash
# 1. Get a JWT for your account from the frontend (open DevTools →
#    Application → Local Storage → mike_oauth_tokens → access_token).
TOKEN=...

# 2. Start a pairing code:
curl -sX POST http://localhost:3001/auth/pair/start \
     -H "Authorization: Bearer $TOKEN" | jq

# 3. Redeem it (the add-in's Login does this internally):
curl -sX POST http://localhost:3001/auth/pair/redeem \
     -H "Content-Type: application/json" \
     -d '{"code":"123456"}' | jq
```

## Production build

```bash
cd word-addin
ADDIN_URL=https://mike.example.com npm run build
```

This emits the bundle into `frontend/public/word-addin/`:

- `taskpane.html`
- `taskpane.bundle.js`
- `manifest.xml` (with `${ADDIN_URL}` placeholders substituted)

When the frontend container is built afterwards, those files travel
along with the rest of `public/` and end up served at
`https://mike.example.com/word-addin/...`.

There is also a convenience script in the frontend package:

```bash
cd frontend
npm run build:with-addin
```

That installs the add-in's deps, builds the bundle into `public/`, and
runs `next build` — useful for one-shot CI pipelines.

The web frontend's `Account → Word add-in` page already links to
`/word-addin/manifest.xml`, which users download and sideload.

## What's in the package

```
word-addin/
├─ manifest.xml                  Office add-in manifest (uses ${ADDIN_URL})
├─ webpack.config.js             dev: HTTPS:3002, prod: ../frontend/public/word-addin/
├─ package.json
└─ src/taskpane/
   ├─ index.html / index.tsx     Office.onReady → React 18 root
   ├─ App.tsx                    AuthProvider wraps Login | MainLayout
   ├─ globals.css                Tailwind + scrollbar polish
   ├─ contexts/AuthContext.tsx   isAuthenticated / pairWithCode / logout
   ├─ lib/
   │   ├─ auth.ts                Pairing-code redeem + token storage
   │   ├─ api.ts                 streamChat / streamProjectChat / uploads
   │   ├─ wordWrite.ts           Apply markdown writes into the open doc
   │   ├─ wordComments.ts        Track-changes + Word comment helpers
   │   └─ wordDocBytes.ts        Read open .docx as Blob (for upload)
   ├─ hooks/
   │   ├─ useChat.ts             SSE consumer (content_delta, reasoning, …)
   │   ├─ useProjects.ts         GET /projects with refresh
   │   └─ useWordDoc.ts          Selection state, track-changes mode, find/replace
   └─ components/
       ├─ Login.tsx              6-digit pairing input
       ├─ MainLayout.tsx         Header + tabs + content
       ├─ BottomTabs.tsx         Chat | Projects
       ├─ ChatPanel.tsx          Streaming chat scroller
       ├─ ChatInput.tsx          Textarea, attach-doc, selection chip
       ├─ ChatMessage.tsx        Markdown rendering + edit-apply buttons
       ├─ ProjectsTab.tsx        Project picker
       ├─ MikeLogo.tsx
       └─ ErrorBoundary.tsx
```

## Known limitations / non-goals (yet)

- **Workflows / Tabular Review** are not exposed in the add-in. Users
  who need those open Eulex Desk on the web.
- **Comment placement when no selection exists** anchors at the current
  caret. Fine, but not as good as multi-range placement.
- **Rich formatting** (bold/italic, alignment) is stripped when applying
  assistant writes — we render plain text instead of guessing the user's
  intent. Headings (`#`, `##`, `###`) and lists (`- `, `1. `) are honored.
- The add-in is **sideload-only** for now. Microsoft AppSource publishing
  is a separate workstream.

## Troubleshooting

- "Code expired" / "Invalid code": the code TTL is 5 minutes, single-use.
  Generate a fresh code on `Account → Word add-in` and try again.
- Pane is blank after sideload: open Word's **Insert → My Add-ins** list
  and remove the entry, then upload `manifest.xml` again. Office caches
  manifests aggressively.
- `fetch` fails with CORS in dev: make sure the backend includes
  `https://localhost:3002` in `ALLOWED_ORIGINS` (it does by default in
  `backend/src/index.ts`).
- Track-changes inserts go missing on Word for Mac: the add-in already
  uses the two-step "insert before + delete" pattern that works around
  that bug.

## License

AGPL-3.0-only.
