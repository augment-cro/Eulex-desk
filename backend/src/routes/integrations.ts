/**
 * Native file-source connectors (Google Drive / OneDrive / Box).
 *
 *   GET    /integrations                          (auth)  — list providers + my accounts
 *   POST   /integrations/:provider/oauth/start    (auth)  — returns { authorize_url }
 *   GET    /integrations/:provider/oauth/callback (no auth, state-verified)
 *   DELETE /integrations/:provider                (auth)
 *   GET    /integrations/:provider/files          (auth)  — list/search remote files
 *   POST   /integrations/:provider/import         (auth)  — { file_id } → documents row
 *
 * Auth notes:
 *   - All routes except /oauth/callback use Bearer JWT (requireAuth).
 *   - /oauth/callback is reached by the user's browser via 302 from the
 *     provider, so it cannot carry our Bearer header. We instead encode
 *     `{ userId, provider, nonce }` into a short-lived signed JWT and
 *     pass it as the OAuth `state` parameter; the callback verifies the
 *     signature and pulls userId out of it. EULEX_MCP_JWT_SECRET (the
 *     same secret already used for our main auth) signs both the state
 *     and the user JWT — no new secret to provision.
 */

import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    getAdapter,
    isValidProviderId,
    listProviders,
} from "../lib/integrations/registry";
import {
    deleteAccount,
    getValidAccessToken,
    listAccountsForUser,
    upsertAccount,
} from "../lib/integrations/store";
import type { ProviderId } from "../lib/integrations/types";
import { processDocumentBytes } from "./documents";

export const integrationsRouter = Router();

const STATE_TTL_MINUTES = 10;

interface OAuthStateClaims {
    sub: string; // userId (UUID)
    provider: ProviderId;
    nonce: string;
    iat: number;
    exp: number;
}

function signState(userId: string, provider: ProviderId): string {
    const secret = process.env.EULEX_MCP_JWT_SECRET;
    if (!secret) throw new Error("EULEX_MCP_JWT_SECRET not configured");
    const nonce = require("crypto").randomBytes(16).toString("hex");
    return jwt.sign(
        {
            sub: userId,
            provider,
            nonce,
        },
        secret,
        {
            algorithm: "HS256",
            expiresIn: `${STATE_TTL_MINUTES}m`,
            audience: "integrations-oauth",
            issuer: "mike-backend",
        },
    );
}

function verifyState(token: string): OAuthStateClaims {
    const secret = process.env.EULEX_MCP_JWT_SECRET;
    if (!secret) throw new Error("EULEX_MCP_JWT_SECRET not configured");
    return jwt.verify(token, secret, {
        algorithms: ["HS256"],
        audience: "integrations-oauth",
        issuer: "mike-backend",
    }) as OAuthStateClaims;
}

function callbackUrl(provider: ProviderId): string {
    // The redirect_uri passed to the provider during /authorize MUST
    // match exactly what's whitelisted in their developer console.
    // We derive it from BACKEND_PUBLIC_URL so dev (localhost:3001) and
    // prod (Cloud Run) just work without per-env hand-coding.
    const base =
        process.env.BACKEND_PUBLIC_URL?.trim() ||
        process.env.BACKEND_URL?.trim() ||
        "http://localhost:3001";
    return `${base.replace(/\/+$/, "")}/integrations/${provider}/oauth/callback`;
}

// GET /integrations — what providers exist and which I'm connected to.
integrationsRouter.get("/", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const providers = listProviders();
    const accounts = await listAccountsForUser(userId);
    const byProvider = new Map(accounts.map((a) => [a.provider, a]));
    res.json({
        providers: providers.map((p) => {
            const acc = byProvider.get(p.id);
            return {
                ...p,
                connected: Boolean(acc),
                account_email: acc?.account_email ?? null,
                account_name: acc?.account_name ?? null,
                expires_at: acc?.expires_at ?? null,
            };
        }),
    });
});

// POST /integrations/:provider/oauth/start
integrationsRouter.post(
    "/:provider/oauth/start",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = req.params.provider;
        if (!isValidProviderId(provider)) {
            return void res.status(404).json({ detail: "Unknown provider" });
        }
        const adapter = getAdapter(provider);
        if (!adapter || !adapter.isConfigured()) {
            return void res.status(503).json({
                detail: `Provider '${provider}' is not configured on this server.`,
            });
        }
        const state = signState(userId, provider);
        const authorize_url = adapter.buildAuthorizeUrl({
            redirect_uri: callbackUrl(provider),
            state,
        });
        res.json({ authorize_url });
    },
);

// GET /integrations/:provider/oauth/callback
integrationsRouter.get(
    "/:provider/oauth/callback",
    async (req, res) => {
        const provider = req.params.provider;
        if (!isValidProviderId(provider)) {
            return void res.status(404).send("Unknown provider");
        }
        const code = req.query.code;
        const state = req.query.state;
        const errorParam = req.query.error;
        if (typeof errorParam === "string") {
            return void redirectToFrontend(res, {
                provider,
                ok: false,
                error: errorParam,
            });
        }
        if (typeof code !== "string" || typeof state !== "string") {
            return void res.status(400).send("Missing code or state");
        }

        let claims: OAuthStateClaims;
        try {
            claims = verifyState(state);
        } catch (err) {
            console.error("[integrations] state verify failed:", err);
            return void res.status(400).send("Invalid or expired state");
        }
        if (claims.provider !== provider) {
            return void res.status(400).send("Provider mismatch in state");
        }

        const adapter = getAdapter(provider);
        if (!adapter) return void res.status(404).send("Unknown provider");

        try {
            const tokens = await adapter.exchangeCode({
                code,
                redirect_uri: callbackUrl(provider),
            });
            const info = await adapter.fetchAccountInfo(tokens.access_token);
            await upsertAccount({
                user_id: claims.sub,
                provider,
                account_email: info.email,
                account_name: info.display_name,
                tokens,
            });
            return void redirectToFrontend(res, { provider, ok: true });
        } catch (err) {
            console.error(
                `[integrations] callback failed for ${provider}:`,
                err,
            );
            return void redirectToFrontend(res, {
                provider,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    },
);

// DELETE /integrations/:provider
integrationsRouter.delete(
    "/:provider",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = req.params.provider;
        if (!isValidProviderId(provider)) {
            return void res.status(404).json({ detail: "Unknown provider" });
        }
        await deleteAccount(userId, provider);
        res.status(204).send();
    },
);

// GET /integrations/google_drive/picker_token
//
// Returns a (refreshed if needed) access_token + the GCP project number
// the frontend hands straight to Google Picker's `oauth-token` attribute.
// The token is short-lived (1h) and scoped only to drive.file, so leaking
// it is bounded — but we still avoid exposing it broader than this route.
//
// We keep this route google_drive-specific (not generic /picker_token) so
// callers can't accidentally fish other providers' tokens through it.
integrationsRouter.get(
    "/google_drive/picker_token",
    requireAuth,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const adapter = getAdapter("google_drive");
        if (!adapter || !adapter.isConfigured()) {
            return void res
                .status(503)
                .json({ detail: "Google Drive is not configured" });
        }
        try {
            const access_token = await getValidAccessToken(
                userId,
                "google_drive",
            );
            // app_id is the numeric portion of the OAuth client id
            // (== GCP project number), required by Picker for app-binding.
            const client_id = process.env.GOOGLE_DRIVE_CLIENT_ID ?? "";
            const app_id = client_id.split("-")[0] ?? "";
            const developer_key =
                process.env.GOOGLE_PICKER_API_KEY?.trim() || null;
            res.json({
                access_token,
                app_id,
                developer_key,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                "[integrations] google_drive picker_token failed:",
                msg,
            );
            res.status(502).json({ detail: msg });
        }
    },
);

// GET /integrations/:provider/files?q=&page_token=
integrationsRouter.get(
    "/:provider/files",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = req.params.provider;
        if (!isValidProviderId(provider)) {
            return void res.status(404).json({ detail: "Unknown provider" });
        }
        const adapter = getAdapter(provider);
        if (!adapter) return void res.status(404).json({ detail: "Unknown provider" });

        try {
            const accessToken = await getValidAccessToken(userId, provider);
            const out = await adapter.listFiles(accessToken, {
                query:
                    typeof req.query.q === "string" ? req.query.q : undefined,
                page_token:
                    typeof req.query.page_token === "string"
                        ? req.query.page_token
                        : undefined,
                page_size: req.query.page_size
                    ? Math.min(
                          Math.max(Number(req.query.page_size) || 25, 1),
                          200,
                      )
                    : undefined,
            });
            res.json(out);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                `[integrations] /files for ${provider} failed:`,
                msg,
            );
            res.status(502).json({ detail: msg });
        }
    },
);

// POST /integrations/:provider/import  { file_id, project_id? }
integrationsRouter.post(
    "/:provider/import",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = req.params.provider;
        if (!isValidProviderId(provider)) {
            return void res.status(404).json({ detail: "Unknown provider" });
        }
        const adapter = getAdapter(provider);
        if (!adapter) return void res.status(404).json({ detail: "Unknown provider" });

        const file_id =
            typeof req.body?.file_id === "string" ? req.body.file_id : "";
        if (!file_id) {
            return void res
                .status(400)
                .json({ detail: "file_id is required" });
        }
        const project_id =
            typeof req.body?.project_id === "string"
                ? req.body.project_id
                : null;

        try {
            const accessToken = await getValidAccessToken(userId, provider);
            const file = await adapter.downloadFile(accessToken, file_id);
            const db = createServerSupabase();
            const doc = await processDocumentBytes({
                userId,
                projectId: project_id,
                filename: file.filename,
                content: file.bytes,
                db,
                source: {
                    provider,
                    external_id: file_id,
                    revision: file.revision,
                },
            });
            res.status(201).json(doc);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
                `[integrations] /import for ${provider} failed:`,
                msg,
            );
            const status = msg.startsWith("Unsupported file type")
                ? 400
                : 502;
            res.status(status).json({ detail: msg });
        }
    },
);

function redirectToFrontend(
    res: import("express").Response,
    params: { provider: ProviderId; ok: boolean; error?: string },
): void {
    // After OAuth completes the browser still sits on our backend
    // origin — we bounce it to the frontend so the user lands somewhere
    // useful. The frontend reads ?integration=&ok=&error= and shows a
    // toast / refreshes its connector list.
    const base =
        process.env.FRONTEND_URL?.trim() ||
        "https://max.eulex.ai";
    const qs = new URLSearchParams({
        integration: params.provider,
        ok: params.ok ? "1" : "0",
    });
    if (params.error) qs.set("error", params.error);
    res.redirect(302, `${base}/account/connectors?${qs.toString()}`);
}
