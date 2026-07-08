# Eulex Desk

Eulex Desk is an AI legal assistant for lawyers and legal professionals: document
analysis, legal Q&A with citations, document drafting, tabular document
review, and a Microsoft Word add-in. It is a substantially modified fork of
[Mike](https://github.com/willchen96/mike) — see [NOTICE](NOTICE).

## What Eulex Desk adds on top of Mike

- **In-browser DOCX editing (SuperDoc)** — uploaded and generated documents
  open in an embedded [SuperDoc](https://superdoc.dev) editor for review and
  editing without leaving the app.
- **Integrated MCP framework** — server-side always-on MCP connectors
  (`mike/mcp.json`) plus per-user connectors managed in the UI, with
  localized tool labels in the chat timeline.
- **Tabular document review** — multi-document × multi-column analysis
  matrix with per-cell extraction and export.
- **Microsoft Word add-in** — Office.js taskpane paired to the user account.
- **Legal-source citations** — inline citations resolved against EU (CELEX)
  and Croatian legal sources, with a dedicated source panel.
- **Multi-provider LLM orchestration** — Anthropic, Google Gemini, OpenAI,
  OpenRouter, and self-hosted vLLM, with per-tier model selection.
- **Workflow packs** — declarative YAML workflow/prompt definitions,
  JSON-schema validated.
- **Croatian + English UI** — full i18n, Croatian default.
- **Open service seams** — `contracts/` documents optional external
  services (contexts, governance, PII, audit); the core runs standalone.

## Repository layout

| Package | What it is |
|---|---|
| `frontend/` | Next.js (App Router) web app |
| `backend/` | Express API server — LLM orchestration, MCP, workflows, billing |
| `word-addin/` | Office.js Word taskpane add-in |
| `contracts/` | Open interface contracts for optional external services |
| `schemas/`, `workflow-packs/` | Workflow-pack schema + examples |

## Requirements

- Node.js 22+, npm
- PostgreSQL (backend persistence)
- LLM provider API key(s): Anthropic, Google Gemini, OpenAI, and/or Mistral

## Build & run

Environment templates: `backend/.env.example` and
`frontend/.env.local.example` — copy to `backend/.env` /
`frontend/.env.local` and fill in your credentials.

### Backend

    cd backend
    npm install
    # configure env: DATABASE_URL, provider API keys (see backend/src/lib/llm/),
    # PORT (default 3001)
    npm run dev        # development (tsx watch)
    npm run build && npm start   # production

### Database

For a fresh database run the one-shot schema:

    psql -h 127.0.0.1 -U <user> -d max -f backend/migrations/000_one_shot_schema.sql

For an existing database apply the numbered migrations in
`backend/migrations/` in order.

### Frontend

    cd frontend
    npm install
    # NEXT_PUBLIC_BACKEND_URL must point at the backend (baked at build time)
    npm run dev        # development on :3000
    npm run build      # production build (build:with-addin includes the add-in)

### Word add-in

    cd word-addin
    npm install
    npm run build      # emits into frontend/public/word-addin/
    npm test

For local development against Word:

    npm run install-certs   # one-time, self-signed Office certificate
    npm run dev             # task pane at https://localhost:3002

Sideload `word-addin/manifest.xml` in Microsoft Word, then pair from
**Account → Word add-in** (6-digit code, 5-minute TTL).

### PII anonymization (optional)

PII anonymization is provided by an external service configured via
`PII_SHIELD_URL` (not included in this repository). The backend runs fully
without it — `PII_SHIELD_URL` unset = feature off.

## LLM configuration

The backend reads provider keys from `backend/.env`:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter (multi-provider) |
| `VLLM_BASE_URL` + `VLLM_API_KEY` + `VLLM_MAIN_MODEL` | Self-hosted vLLM |

At least one provider must be configured. The application selects models based
on the keys present.

## Web search (optional)

The `web_search` LLM tool (and the `/search` HTTP route) call any of four
optional search providers. Set whichever keys you want active in `backend/.env`:

| Variable | Provider |
|---|---|
| `TAVILY_API_KEY` | [Tavily](https://app.tavily.com) |
| `EXA_API_KEY` | [Exa](https://dashboard.exa.ai/api-keys) |
| `PARALLEL_API_KEY` | [Parallel](https://platform.parallel.ai) |
| `YOU_API_KEY` | [You.com](https://api.you.com) |

Auto-pick priority when no specific provider is requested:
`tavily → exa → parallel → you`. If no key is set, the `web_search` tool
returns a clear error and the LLM continues without it.

## Workflow packs

Eulex Desk supports declarative workflow/prompt-pack definitions in YAML format,
validated against `schemas/workflow.schema.json`. Example layouts ship in
`workflow-packs/examples/`.

## MCP connectors

Server-side ("always-on") MCP connectors are declared in `mike/mcp.json`
(gitignored — copy from `mike/mcp.json.example`). Servers listed there are
loaded on every chat request and never appear in the per-user connectors UI.
Environment variables referenced as `${VAR_NAME}` in the file are expanded at
runtime. See [`mike/README.md`](mike/README.md) for the full format.

When adding or exposing a new MCP tool, give it a friendly display label in
**both** locales: map the `(server, tool)` pair to an i18n key in
`frontend/src/app/lib/mcpToolLabels.ts` and add the key under
`streaming.toolLabels` in both `frontend/messages/hr.json` and
`frontend/messages/en.json`. The chat timeline falls back to the raw tool
name only when a label is missing.

## Optional external services

The core runs standalone. `contracts/` documents optional network seams
(`CONTEXTS_URL`, `GOVERNANCE_URL`, `AUDIT_SINK_URL`) — each is inert when
unset; any third party may implement them.

## License

AGPL-3.0-only — see [LICENSE](LICENSE) and [NOTICE](NOTICE). This is a
modified version of Mike; if you run a modified version as a network
service, AGPL §13 applies to you too.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
