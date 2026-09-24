import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { closePool } from "./lib/db";
import { ensureSchema } from "./lib/ensureSchema";
import { assertTierSourceConfigAtBoot } from "./lib/tierLimitsStore";
import { seedEntitlementDefaults } from "./lib/entitlements";
import {
    applyMarketingRelaunchOnce,
    seedPlanMarketingDefaults,
} from "./lib/planCatalog";
import { chatRouter } from "./routes/chat";
import { chatGroupsRouter } from "./routes/chatGroups";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { contextsRouter } from "./routes/contexts";
import { realtimeRouter } from "./routes/realtime";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { legalDocsRouter } from "./routes/legalDocs";
import { mcpServersRouter, builtinMcpRouter } from "./routes/mcpServers";
import { mcpOauthRouter } from "./routes/mcpOauth";
import { authPairRouter } from "./routes/authPair";
import { searchRouter } from "./routes/search";
import { integrationsRouter } from "./routes/integrations";
import { chatSharesRouter } from "./routes/chatShares";
import { adminMaxRouter } from "./routes/adminMax";
import { statsRouter } from "./routes/stats";
import { piiRouter } from "./routes/pii";
import {
    billingRouter,
    stripeRawBodyParser,
    stripeWebhookHandler,
} from "./routes/billing";
import { draftRouter } from "./routes/draft";
import { teamsRouter } from "./routes/teams";
import serviceNotificationsRouter from "./routes/serviceNotifications";
import serviceTokenRouter from "./routes/serviceToken";
import { healthPayload } from "./lib/health";
import {
  awaitInitialPromptPack,
  touchPromptPack,
} from "./lib/seams/promptPack";
import { manifestPublicKey } from "./lib/manifestSigning";
import { safeErrorLog } from "./lib/safeError";

const app = express();
const PORT = process.env.PORT ?? 3001;

// FRONTEND_URL supports a comma-separated list — so the same backend can
// serve both the production domain (https://max.eulex.ai) and the raw
// Cloud Run preview URL (https://mike-frontend-…run.app) without a code
// change. Empty entries are filtered out so trailing commas are harmless.
const FRONTEND_URLS = (process.env.FRONTEND_URL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  // Word add-in dev server (webpack-dev-server with office-addin-dev-certs).
  // The taskpane is iframed inside Word, but its fetch() calls go from the
  // taskpane origin (https://localhost:3002) to the backend on :3001 — needs CORS.
  "https://localhost:3002",
  "https://127.0.0.1:3002",
  // Production: set FRONTEND_URL env var to your deployed frontend origin.
  // The env-var branch below handles it automatically.
  "https://max.eulex.ai",
  // Eulex Desk is also served on app.eulex.ai (domain mapping on the same
  // frontend service, traffic since 2026-09-09). Without this entry every
  // preflighted call from that origin fell through the cors() middleware
  // (origin rejected → next() → Express default OPTIONS 200 with no ACAO
  // headers) and the browser reported "Failed to fetch" (tracker #39).
  "https://app.eulex.ai",
  // Defensive: allow same-origin admin tooling and future internal pages
  // served from api.eulex.ai (e.g. an ops dashboard) to call the backend
  // without CORS surprises. Browsers don't send `Origin` header for
  // server-to-server traffic, so this is purely a no-op for the chat
  // path — present only so a future page on api.eulex.ai never trips on
  // a missing entry here.
  "https://api.eulex.ai",
  ...FRONTEND_URLS,
];

function isAllowedOrigin(origin: string | undefined | null): boolean {
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

// Defense-in-depth: ensure ACAO is on every response, including ones the
// route never gets to write (early throws, hung handlers, etc). Without
// this, the browser blames CORS for what is actually a 5xx, hiding the
// real error in the network tab.
app.use((req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (isAllowedOrigin(origin) && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, origin ?? true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    // Cross-origin JS (max.eulex.ai → api.eulex.ai) may only read
    // CORS-safelisted response headers unless they are listed here. The
    // rate-limit banner/usage ring read these off every reply; a wildcard
    // is ignored with credentials, so each header must be named.
    exposedHeaders: [
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
      "X-RateLimit-Used-Tokens",
      "X-RateLimit-Daily-Tokens",
      "X-RateLimit-Bonus-Tokens",
      "X-RateLimit-Questions",
      "X-RateLimit-Tier-Slug",
      "X-RateLimit-Tier-Label",
      "X-RateLimit-Topup-Available",
      // Pagination headers set by GET /projects — unreadable cross-origin
      // without this (issue #112).
      "X-Total-Count",
      "X-Pagination",
    ],
  }),
);

// Prompt-pack guard (tracker #41): on a quiet Cloud Run instance the
// background refresh starves under CPU throttling, so make sure the fetch
// runs on request CPU. Bounded and non-throwing; a no-op without
// GOVERNANCE_URL or once a pack is cached and fresh. Preflights skipped.
app.use((req, _res, next) => {
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  touchPromptPack().then(
    () => next(),
    () => next(),
  );
});

// Stripe webhook MUST receive the raw body for signature verification.
// Mount the raw parser + handler BEFORE express.json() so the JSON
// middleware never touches /billing/stripe/webhook.
app.post("/billing/stripe/webhook", stripeRawBodyParser, stripeWebhookHandler);

app.use(express.json({ limit: "50mb" }));

// Express 4 leaves req.body undefined when no parser matched (e.g. a POST
// without a JSON content-type). Route handlers destructure `req.body.<field>`
// directly; on undefined that throws inside a bare async handler, whose
// rejection never reaches the error middleware — the request then hangs
// until the Cloud Run timeout (issue #93). Normalize to {} so handlers get
// their own 400-validation paths instead of a hung connection.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

app.use("/billing", billingRouter);
// Must be mounted before chatRouter: its GET/PATCH/DELETE /chat/:chatId
// param routes would otherwise shadow /chat/groups.
app.use("/chat/groups", chatGroupsRouter);
app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/contexts", contextsRouter);
app.use("/realtime", realtimeRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/legal-docs", legalDocsRouter);
app.use("/user/mcp-servers", mcpServersRouter);
app.use("/builtin-mcp-servers", builtinMcpRouter);
app.use("/mcp/oauth", mcpOauthRouter);
app.use("/auth/pair", authPairRouter);
app.use("/search", searchRouter);
app.use("/integrations", integrationsRouter);
app.use("/adminmax", adminMaxRouter);
app.use("/pii", piiRouter);
app.use("/teams", teamsRouter);
app.use("/draft", draftRouter);
// License-boundary seams (contracts/): generic notification intake for
// configured external services (401s on every request when no seam
// secrets are set) + the user-facing identity-token endpoint (404s when
// the named service is unconfigured). Both inert without seam envs.
app.use("/internal/notifications", serviceNotificationsRouter);
app.use("/service-token", serviceTokenRouter);
// chatSharesRouter handles both /chat/:id/share* (owner side) and
// /share/:token* (recipient side), so it must mount at the root.
app.use("/", chatSharesRouter);

app.use("/stats", statsRouter);
app.get("/health", (_req, res) => res.json(healthPayload()));

// The Ed25519 public key this deployment signs project export manifests
// with ({algorithm, key_id, public_key}), or null when no key is configured.
// Deliberately unauthenticated: whoever checks a manifest is usually outside
// the workspace, and they need to get the key from the server rather than
// trust the copy inside the file they were handed.
app.get("/manifest-signing-key", (_req, res) => {
  try {
    res.json(manifestPublicKey());
  } catch (err) {
    console.error("[manifest-signing-key] failed", safeErrorLog(err));
    res.status(500).json({ detail: "Manifest signing key is misconfigured" });
  }
});

// Catch-all 404 — keeps unmatched paths inside Express so CORS headers
// (set by the middleware above) get attached, instead of letting Cloud
// Run's edge respond with a header-less default.
app.use((req, res) => {
  res.status(404).json({ detail: "Not found", path: req.path });
});

// Global error handler — converts unhandled route exceptions into a
// JSON 500 with CORS headers attached. Without this, an Express crash
// surfaces in the browser as a confusing CORS error.
app.use(
  (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[error-handler] ${req.method} ${req.path}:`,
      err instanceof Error ? err.stack ?? err.message : err,
    );
    if (res.headersSent) {
      // Stream already started; nothing left to do but kill the
      // connection — the browser will see a network error but at
      // least the server log captured the cause.
      res.end();
      return;
    }
    res.status(500).json({ detail: "Internal server error", error: message });
  },
);

// Catch async leaks that escape Express. Logging keeps Cloud Run's
// crash logs informative even when the route handler never awaits.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Fail fast on an internally inconsistent tier-source config (issue #69):
// TIERS_FROM_SUPABASE set without Supabase admin env would be silently
// ignored and this instance would diverge from the intended tier source.
// Throws before the listener starts; otherwise logs the effective source.
assertTierSourceConfigAtBoot();

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
try {
  const manifestKey = manifestPublicKey();
  if (manifestKey) {
    console.log(
      `[manifest-signing] export manifests signed with key ${manifestKey.key_id}`,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Hold `listen()` until the first prompt-pack fetch settles (bounded by
// the fetch timeout, ~10 s worst case). Cloud Run guarantees CPU until the
// container starts accepting connections, so this is the one window where
// the fetch cannot starve (tracker #41). Never rejects.
let server: ReturnType<typeof app.listen> | null = null;
void awaitInitialPromptPack().then(() => {
  server = app.listen(PORT, () => {
    console.log(`Eulex Desk backend running on port ${PORT}`);
    // Fire-and-forget: any DDL is idempotent, so a slow database does not
    // need to block the listener from accepting health checks.
    ensureSchema()
      .then(() => seedEntitlementDefaults())
      .then(() => seedPlanMarketingDefaults())
      .then(() => applyMarketingRelaunchOnce())
      .catch((err) => {
        console.error("[ensureSchema] unexpected failure:", err);
      });
  });
});

// ── Graceful shutdown (Cloud Run sends SIGTERM) ─────────────
//
// Cloud Run sends SIGTERM on revision swap (rolling deploy), scale-down,
// or `services update`. The service must keep in-flight chat streams
// alive long enough to finish — otherwise the stream's underlying
// Anthropic socket dies mid-answer with `UND_ERR_SOCKET: other side
// closed` and the browser shows a generic "load failed".
//
// `server.close()` (Node http) stops accepting new connections but lets
// existing ones drain. The forced `process.exit(1)` timer below MUST be
// at least as large as the longest expected in-flight request — i.e.
// the Cloud Run service-level --timeout. We size it to 1200s (20 min)
// to match `gcloud run services update --timeout=1200` so SIGTERM never
// truncates a stream the platform itself was still willing to hold open.
//
// NB: Cloud Run will SIGKILL anyway after its own grace expires
// (~10 min for revision swap), but at that point the request had max
// time to finish, and we exit with a non-zero so the platform records
// the forced termination.
function shutdown(signal: string) {
  console.log(`[shutdown] Received ${signal}, closing server…`);
  if (!server) {
    // Signal arrived before listen() (boot fetch still pending).
    void closePool().finally(() => process.exit(0));
    return;
  }
  server.close(async () => {
    await closePool();
    console.log("[shutdown] Clean exit");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn(
      "[shutdown] Forced exit after 1200s — in-flight requests did not drain in time",
    );
    process.exit(1);
  }, 1_200_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
