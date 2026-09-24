# mike-admin-mcp

> **Legacy.** The LIVE `mike-admin-mcp` Cloud Run service is built from the
> separate repo `Desk/eulex-max-admin-mcp` (scoped tokens, OAuth, PII modes,
> growth/product tools, `get_databases`). This directory is the original
> extraction point and is no longer deployed — do not run
> `scripts/deploy-admin-mcp.sh` against production.

ADMIN-ONLY FastMCP server exposing AdminMax stats + management over MCP.
It is a **thin wrapper over the `/adminmax` REST API** — no database of its
own. The backend enforces all rules, idempotency and audit logging.

## Tools

**Overview & users (read):** `get_overview`, `list_users`, `get_user`,
`get_analytics`, `new_users`, `get_user_usage`, `get_tier_history`.

**Tiers & entitlements (read):** `list_tiers`, `get_entitlement_catalog`.

**Billing (read):** `get_user_credits`, `list_promos`.

**Audit (read):** `get_audit`.

**Write (audited by backend):** `set_user_tier`, `update_user_profile`,
`grant_credits`, `void_credit`, `suspend_user`, `update_tier_limit`,
`create_tier`, `create_promo`, `set_promo_active`.

## PII redaction (on by default)

Personal data must not reach the MCP client's LLM context. Every response
passes through a redaction pass in `adminFetch` — one choke point, so tools
added later are covered without anyone remembering to.

**Blanked to `[redacted]`:** `email`, `display_name`, `ip`, `actor`, `notes`,
`external_reference`, plus any email address appearing anywhere in a string
(audit `payload` jsonb, backend error text, free-typed notes).

**Kept:** uuids, tier ids and labels, every number, timestamp, status, action
name, country. Everything an operator reasons about survives.

Lookup by email still works — redaction applies to what we *return*, not what
you send. `resolveUserId` reads the search result raw, compares the address in
process, and lets only the uuid out.

Set `ADMIN_MCP_REDACT=0` (or `off` / `false`) to disable, deliberately: the
server then logs a warning at startup. Any other value, or the variable being
absent, means redaction is **on** — a safety default you must not have to
remember to get.

## Not exposed on purpose: conversation content

The AdminMax API also serves `GET /chats`, `GET /chats/:id/full` and
`GET /users/:id/messages` — chat titles and full message bodies. **No MCP tool
wraps them, and none should.** Those are end-user legal questions and answers;
the dashboard shows them to a human operator, whereas an MCP tool would feed
them into an LLM client's context. Read that data in the dashboard.

`get_user_usage` covers per-request diagnostics (model, tokens, cost, status,
`chat_id`) without any message bodies — that is the supported path for
debugging a user's spend or errors.

Two schema details worth knowing before a write:

- **`entitlements`** (on `update_tier_limit` / `create_tier`) is *shallow-merged* —
  send only the keys you change. Only keys from `get_entitlement_catalog` are
  accepted; anything else is dropped by the backend, so read the catalog first.
- **`marketing`** (on `update_tier_limit`) *replaces* the whole object and needs
  both `hr` and `en` locales complete. The tool schema enforces that, because
  the backend would otherwise drop a partial object and the write would look
  like a silent no-op.

## Auth

- **Inbound (the admin gate):** the MCP client must send
  `Authorization: Bearer <EULEX_ADMIN_MCP_TOKEN>`. No token → 401.
- **Outbound:** the server logs into AdminMax with `ADMIN_MAX_PASSWORD`,
  caches the JWT, refreshes on expiry/401.

## Env

| var | required | default | purpose |
|-----|----------|---------|---------|
| `EULEX_ADMIN_MCP_TOKEN` | ✅ | — | inbound bearer secret (the admin gate) |
| `ADMIN_MAX_PASSWORD` | ✅ | — | AdminMax password used to mint the JWT |
| `ADMIN_API_BASE` | — | `https://api.eulex.ai` | backend base URL |
| `ADMIN_MCP_REDACT` | — | on | `0`/`off`/`false` disables PII redaction |
| `PORT` | — | `8080` | listen port (Cloud Run sets it) |

## Run locally

```bash
npm install
EULEX_ADMIN_MCP_TOKEN=dev ADMIN_MAX_PASSWORD=… ADMIN_API_BASE=https://api.eulex.ai \
  npm run dev
# MCP endpoint: http://localhost:8080/mcp
```

## Connect from an MCP client

Streamable-HTTP transport, URL `https://<service-url>/mcp`, with header
`Authorization: Bearer <EULEX_ADMIN_MCP_TOKEN>`.

## Deploy (Cloud Run)

See `scripts/deploy-admin-mcp.sh` (run from repo root). One-time: create the
`EULEX_ADMIN_MCP_TOKEN` secret. Reuses the existing `ADMIN_MAX_PASSWORD`
secret. This is a **separate** Cloud Run service from `mike-backend`.

## Branded OAuth consent screen

`src/consent.ts` replaces fastmcp's stock OAuth consent page (the generic
"Authorization Request … via <supabase-host>" card) with the Max paper/ink
design: Eulex logo, Sentient/Georgia, Croatian copy, Action-cyan CTA, dark
mode — and **no upstream-provider host leaked to the user**. fastmcp 4.x has
no template option, so the module overrides
`ConsentManager.prototype.generateConsentScreen` (exported from
`fastmcp/auth`) at import time. Any server variant that enables the OAuth
flow must `import "./consent.js";` before constructing the OAuth provider.
NOTE: the currently deployed service (v0.2.0, 32 tools, OAuth) is built from
a NEWER source tree than this directory (21 tools, bearer-only) — wire the
import there before its next deploy.
