# Service identity (v1)

Short-TTL HS256 JWTs with a **distinct shared secret per service**.

## Core → service (outbound)

Sent as `Authorization: Bearer <jwt>` on every seam call.

| Claim | Value |
|---|---|
| `sub` | `desk-<userId>` |
| `tenant` | core team ID or `null` (personal account) |
| `scope` | `seam:contexts` \| `seam:governance` \| `seam:audit` \| `seam:billing` |
| `email` | optional — the user's email when the core knows it; services that support email-based sharing consume it, others ignore it |
| `system_contexts` | optional, `contexts` only — `true` when the user's tier grants EULEX system contexts (entitlement `systemContexts`); without it the contexts service neither lists nor resolves them |
| `iss` | `eulex-desk` |
| `aud` | `contexts` \| `governance` \| `audit` \| `billing` |
| `exp` | `iat + 3600` (cached per user, refreshed 300 s early) |

Secrets (core env): `CONTEXTS_SERVICE_SECRET`, `GOVERNANCE_SERVICE_SECRET`,
`AUDIT_SINK_SECRET`, `BILLING_SERVICE_SECRET`. A seam with no secret configured sends no
`Authorization` header (dev/localhost).

### Operator variant (admin APIs)

For a service's admin API (AdminMax proxies) the core mints the same HS256
token with `sub` = `adminmax`, `scope` = `seam:<service>-admin`, a 5-minute
`exp`, and no user claims. Used by the billing-provider seam
(`seam:billing-admin`). The frontend service-token endpoint never issues
billing tokens of either kind: billing calls always originate in the core.

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

## Platform identity variant (benchmark seam)

The benchmark seam (`BENCHMARK_SERVICE_URL`) is admin-only and never carries a
user identity, so the core sends a platform-signed OIDC identity token instead
of the HS256 service token: `Authorization: Bearer <Google ID token>` with
`aud` = the service URL (Cloud Run "invoker" IAM). A service implementing
`benchmark.openapi.json` outside that platform may accept the HS256 token from
this document with `scope` = `seam:benchmark`, `aud` = `benchmark` and
`BENCHMARK_SERVICE_SECRET` on the core side. In non-production only, the core
may send a static `BENCHMARK_DEV_TOKEN`.

## Upgrade path

RS256 + JWKS when a third party implements a contract (planned, not v1).
