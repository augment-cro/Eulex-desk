# Service identity (v1)

Short-TTL HS256 JWTs with a **distinct shared secret per service**.

## Core → service (outbound)

Sent as `Authorization: Bearer <jwt>` on every seam call.

| Claim | Value |
|---|---|
| `sub` | `desk-<userId>` |
| `tenant` | core team ID or `null` (personal account) |
| `scope` | `seam:contexts` \| `seam:governance` \| `seam:audit` |
| `email` | optional — the user's email when the core knows it; services that support email-based sharing consume it, others ignore it |
| `iss` | `eulex-desk` |
| `aud` | `contexts` \| `governance` \| `audit` |
| `exp` | `iat + 3600` (cached per user, refreshed 300 s early) |

Secrets (core env): `CONTEXTS_SERVICE_SECRET`, `GOVERNANCE_SERVICE_SECRET`,
`AUDIT_SINK_SECRET`. A seam with no secret configured sends no
`Authorization` header (dev/localhost).

## Service → core (inbound, e.g. `/notifications`)

Same per-service secret, reversed direction:
`iss` = the service name, `aud` = `eulex-desk`. The core tries each configured
secret; requests failing verification get `401`.

## Frontend → service (user-held token)

For flows where the core's own frontend calls a configured service directly
(e.g. management UIs), the core exposes an authenticated endpoint
`GET /service-token/{service}` that returns the same outbound token
(`{ token, expires_in }`) for the calling user. The endpoint responds `404`
when the named service has no secret configured — with no seam envs set it is
inert (standalone-core rule).

## Upgrade path

RS256 + JWKS when a third party implements a contract (planned, not v1).
