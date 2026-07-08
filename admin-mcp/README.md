# mike-admin-mcp

ADMIN-ONLY FastMCP server exposing AdminMax stats + management over MCP.
It is a **thin wrapper over the `/adminmax` REST API** — no database of its
own. The backend enforces all rules, idempotency and audit logging.

## Tools

**Read:** `get_overview`, `list_users`, `get_user`, `get_analytics`,
`list_tiers`, `new_users`.

**Write (audited by backend):** `set_user_tier`, `update_user_profile`,
`grant_credits`, `suspend_user`, `update_tier_limit`.

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
