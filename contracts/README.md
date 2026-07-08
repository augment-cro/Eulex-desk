# Open interface contracts

Generic, versioned contracts the Eulex Desk AGPL core speaks to **optional** external
services. Each seam is inert when its env var is unset — the core runs fully
standalone (the "standalone-core rule"). Any third party may implement these.

| Contract | Core env var | Direction |
|---|---|---|
| `context-provider.openapi.json` | `CONTEXTS_URL` | core → service (+ service → core `/notifications`) |
| `pre-inference-hook.openapi.json` | `GOVERNANCE_URL` | core → service |
| `prompt-pack.openapi.json` | `GOVERNANCE_URL` | core → service (fetch-and-cache + enrich proxy) |
| `audit-sink.openapi.json` | `AUDIT_SINK_URL` | core → service (fire-and-forget) |
| `service-identity.md` | `*_SERVICE_SECRET` / `AUDIT_SINK_SECRET` | both |

Versioning: each document carries `info.version` (semver). Breaking changes
bump the major version and add a new document version side by side.
