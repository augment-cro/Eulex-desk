/**
 * Google Drive connector.
 *
 * Auth: OAuth 2.0 web flow (authorization code + refresh token).
 *   Scopes (minimal): drive.file (only files the user picks via the
 *   Google Picker iframe become visible — far smaller blast radius
 *   than full drive scope).
 *
 * Required env vars:
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   (GOOGLE_PICKER_API_KEY is read by the frontend, not here.)
 */

import type {
    ConnectedAccountInfo,
    ImportedFile,
    ListFilesInput,
    ListFilesResponse,
    OAuthTokenSet,
    ProviderAdapter,
    ProviderFile,
} from "../types";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Native Google formats need an export step — direct ?alt=media on a
// Google Doc returns 403. Map Google MIME → export MIME we'll persist.
const GOOGLE_EXPORT_MAP: Record<string, { mime: string; ext: string }> = {
    "application/vnd.google-apps.document": {
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ext: "docx",
    },
    "application/vnd.google-apps.spreadsheet": {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: "xlsx",
    },
    "application/vnd.google-apps.presentation": {
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ext: "pptx",
    },
};

const SCOPES = [
    "https://www.googleapis.com/auth/drive.file",
    "openid",
    "email",
    "profile",
];

export const googleDriveAdapter: ProviderAdapter = {
    id: "google_drive",
    display_name: "Google Drive",

    isConfigured(): boolean {
        return Boolean(
            process.env.GOOGLE_DRIVE_CLIENT_ID?.trim() &&
                process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim(),
        );
    },

    buildAuthorizeUrl({ redirect_uri, state }) {
        const params = new URLSearchParams({
            client_id: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "",
            redirect_uri,
            response_type: "code",
            scope: SCOPES.join(" "),
            // offline → return refresh_token; consent → force consent
            // screen so refresh_token is *guaranteed* on first connect
            // (Google omits it on subsequent silent re-auths).
            access_type: "offline",
            prompt: "consent",
            state,
            include_granted_scopes: "true",
        });
        return `${AUTHORIZE_URL}?${params.toString()}`;
    },

    async exchangeCode({ code, redirect_uri }): Promise<OAuthTokenSet> {
        const body = new URLSearchParams({
            code,
            client_id: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "",
            client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "",
            redirect_uri,
            grant_type: "authorization_code",
        });
        const resp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Google token exchange failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            access_token: string;
            refresh_token?: string;
            token_type?: string;
            expires_in?: number;
            scope?: string;
        };
        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token ?? null,
            token_type: data.token_type ?? "Bearer",
            expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null,
            scopes: data.scope?.split(" ") ?? SCOPES,
        };
    },

    async refreshTokens(refresh_token: string): Promise<OAuthTokenSet> {
        const body = new URLSearchParams({
            client_id: process.env.GOOGLE_DRIVE_CLIENT_ID ?? "",
            client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? "",
            refresh_token,
            grant_type: "refresh_token",
        });
        const resp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Google token refresh failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            access_token: string;
            token_type?: string;
            expires_in?: number;
            scope?: string;
        };
        return {
            access_token: data.access_token,
            // Google does NOT return a new refresh_token on refresh; the
            // caller keeps the original.
            refresh_token: null,
            token_type: data.token_type ?? "Bearer",
            expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null,
            scopes: data.scope?.split(" ") ?? SCOPES,
        };
    },

    async fetchAccountInfo(access_token: string): Promise<ConnectedAccountInfo> {
        const resp = await fetch(USERINFO_URL, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) {
            return { email: null, display_name: null };
        }
        const data = (await resp.json()) as {
            email?: string;
            name?: string;
        };
        return {
            email: data.email ?? null,
            display_name: data.name ?? null,
        };
    },

    async listFiles(
        access_token: string,
        input: ListFilesInput,
    ): Promise<ListFilesResponse> {
        const params = new URLSearchParams({
            // Drive's `q` syntax — when the caller passes plain text we
            // search names/full-text contents.
            q: input.query
                ? `name contains '${input.query.replace(/'/g, "\\'")}' and trashed = false`
                : "trashed = false",
            pageSize: String(Math.min(input.page_size ?? 25, 100)),
            fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,headRevisionId,webViewLink,parents)",
            orderBy: "modifiedTime desc",
        });
        if (input.page_token) params.set("pageToken", input.page_token);

        const resp = await fetch(`${FILES_URL}?${params.toString()}`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) {
            throw new Error(
                `Google Drive list failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            nextPageToken?: string;
            files?: Array<{
                id: string;
                name: string;
                mimeType: string;
                size?: string;
                modifiedTime?: string;
                headRevisionId?: string;
                webViewLink?: string;
                parents?: string[];
            }>;
        };
        const files: ProviderFile[] = (data.files ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            mime_type: f.mimeType,
            size_bytes: f.size ? Number(f.size) : null,
            modified_at: f.modifiedTime ?? null,
            revision: f.headRevisionId ?? null,
            web_url: f.webViewLink ?? null,
            parent: f.parents?.[0] ?? null,
        }));
        return { files, next_page_token: data.nextPageToken ?? null };
    },

    async downloadFile(
        access_token: string,
        file_id: string,
    ): Promise<ImportedFile> {
        // First fetch metadata so we know whether to download or export.
        const metaParams = new URLSearchParams({
            fields: "name,mimeType,headRevisionId",
        });
        const metaResp = await fetch(
            `${FILES_URL}/${encodeURIComponent(file_id)}?${metaParams.toString()}`,
            { headers: { Authorization: `Bearer ${access_token}` } },
        );
        if (!metaResp.ok) {
            throw new Error(
                `Google Drive metadata failed: ${metaResp.status} ${await metaResp.text()}`,
            );
        }
        const meta = (await metaResp.json()) as {
            name: string;
            mimeType: string;
            headRevisionId?: string;
        };

        const exportInfo = GOOGLE_EXPORT_MAP[meta.mimeType];
        let url: string;
        let finalMime: string;
        let finalName: string;
        if (exportInfo) {
            // Native Google format → use export endpoint.
            const params = new URLSearchParams({ mimeType: exportInfo.mime });
            url = `${FILES_URL}/${encodeURIComponent(file_id)}/export?${params.toString()}`;
            finalMime = exportInfo.mime;
            finalName = `${meta.name}.${exportInfo.ext}`;
        } else {
            url = `${FILES_URL}/${encodeURIComponent(file_id)}?alt=media`;
            finalMime = meta.mimeType;
            finalName = meta.name;
        }

        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) {
            throw new Error(
                `Google Drive download failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const arrayBuf = await resp.arrayBuffer();
        return {
            bytes: Buffer.from(arrayBuf),
            filename: finalName,
            mime_type: finalMime,
            revision: meta.headRevisionId ?? null,
        };
    },
};
