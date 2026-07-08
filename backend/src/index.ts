import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { closePool } from "./lib/db";
import { ensureSchema } from "./lib/ensureSchema";
import { seedEntitlementDefaults } from "./lib/entitlements";
import {
    applyMarketingRelaunchOnce,
    seedPlanMarketingDefaults,
} from "./lib/planCatalog";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { contextsRouter } from "./routes/contexts";
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
  }),
);

// Stripe webhook MUST receive the raw body for signature verification.
// Mount the raw parser + handler BEFORE express.json() so the JSON
// middleware never touches /billing/stripe/webhook.
app.post("/billing/stripe/webhook", stripeRawBodyParser, stripeWebhookHandler);

app.use(express.json({ limit: "50mb" }));

app.use("/billing", billingRouter);
app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/contexts", contextsRouter);
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

const server = app.listen(PORT, () => {
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
