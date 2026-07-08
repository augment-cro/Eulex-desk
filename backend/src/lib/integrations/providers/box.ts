/**
 * Box connector.
 *
 * Auth: OAuth 2.0 authorization code grant.
 *   Authorize: https://account.box.com/api/oauth2/authorize
 *   Token:     https://api.box.com/oauth2/token
 *   Scopes are configured in the Box Developer Console (root_readonly
 *   suffices for our snapshot-import use case).
 *
 * Required env vars:
 *   BOX_CLIENT_ID
 *   BOX_CLIENT_SECRET
 *
 * IMPORTANT — Box rotates refresh tokens on every refresh.
 *   Each /oauth2/token response with grant_type=refresh_token returns
 *   a NEW refresh_token; the old one continues to work for a short
 *   overlap window (~60s) and then dies. The caller MUST persist the
 *   new refresh_token, otherwise the next refresh ~60 minutes later
 *   will fail with invalid_grant. Verified against developer.box.com
 *   (Context7, 2026-05).
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

const AUTHORIZE_URL = "https://account.box.com/api/oauth2/authorize";
const TOKEN_URL = "https://api.box.com/oauth2/token";
const API_BASE = "https://api.box.com/2.0";

export const boxAdapter: ProviderAdapter = {
    id: "box",
    display_name: "Box",

    isConfigured(): boolean {
        return Boolean(
            process.env.BOX_CLIENT_ID?.trim() &&
                process.env.BOX_CLIENT_SECRET?.trim(),
        );
    },

    buildAuthorizeUrl({ redirect_uri, state }) {
        const params = new URLSearchParams({
            client_id: process.env.BOX_CLIENT_ID ?? "",
            response_type: "code",
            redirect_uri,
            state,
        });
        return `${AUTHORIZE_URL}?${params.toString()}`;
    },

    async exchangeCode({ code, redirect_uri }): Promise<OAuthTokenSet> {
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: process.env.BOX_CLIENT_ID ?? "",
            client_secret: process.env.BOX_CLIENT_SECRET ?? "",
            redirect_uri,
        });
        const resp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Box token exchange failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            access_token: string;
            refresh_token?: string;
            token_type?: string;
            expires_in?: number;
            restricted_to?: unknown;
        };
        return {
            access_token: data.access_token,
            refresh_token: data.refresh_token ?? null,
            token_type: data.token_type ?? "Bearer",
            expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null,
            scopes: [],
        };
    },

    async refreshTokens(refresh_token: string): Promise<OAuthTokenSet> {
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token,
            client_id: process.env.BOX_CLIENT_ID ?? "",
            client_secret: process.env.BOX_CLIENT_SECRET ?? "",
        });
        const resp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Box token refresh failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            access_token: string;
            refresh_token?: string;
            token_type?: string;
            expires_in?: number;
        };
        return {
            access_token: data.access_token,
            // CRITICAL: Box rotates the refresh_token. The new value
            // must be persisted by the caller — old token expires in
            // ~60 seconds.
            refresh_token: data.refresh_token ?? null,
            token_type: data.token_type ?? "Bearer",
            expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null,
            scopes: [],
        };
    },

    async fetchAccountInfo(access_token: string): Promise<ConnectedAccountInfo> {
        const resp = await fetch(`${API_BASE}/users/me`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) return { email: null, display_name: null };
        const data = (await resp.json()) as {
            login?: string;
            name?: string;
        };
        return {
            email: data.login ?? null,
            display_name: data.name ?? null,
        };
    },

    async listFiles(
        access_token: string,
        input: ListFilesInput,
    ): Promise<ListFilesResponse> {
        const limit = Math.min(input.page_size ?? 25, 200);
        const offset = input.page_token ? Number(input.page_token) : 0;
        const fields =
            "id,name,size,modified_at,etag,sha1,extension,parent,shared_link";

        let url: string;
        if (input.query) {
            const params = new URLSearchParams({
                query: input.query,
                type: "file",
                limit: String(limit),
                offset: String(offset),
                fields,
            });
            url = `${API_BASE}/search?${params.toString()}`;
        } else {
            // Default to root folder children when no query.
            const params = new URLSearchParams({
                limit: String(limit),
                offset: String(offset),
                fields,
            });
            url = `${API_BASE}/folders/0/items?${params.toString()}`;
        }

        const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) {
            throw new Error(
                `Box list failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            entries?: Array<{
                type?: string;
                id: string;
                name: string;
                size?: number;
                modified_at?: string;
                etag?: string;
                extension?: string;
                parent?: { name?: string };
            }>;
            total_count?: number;
        };

        const files: ProviderFile[] = (data.entries ?? [])
            .filter((e) => e.type === "file" || e.type === undefined)
            .map((f) => ({
                id: f.id,
                name: f.name,
                // Box doesn't return MIME types in list responses; we
                // best-guess from extension and let the caller map to
                // the documents table's storage MIME on import.
                mime_type: extToMime(f.extension ?? extOf(f.name)),
                size_bytes: f.size ?? null,
                modified_at: f.modified_at ?? null,
                revision: f.etag ?? null,
                web_url: null,
                parent: f.parent?.name ?? null,
            }));

        const total = data.total_count ?? 0;
        const nextOffset = offset + files.length;
        const next_page_token =
            files.length === limit && nextOffset < total
                ? String(nextOffset)
                : null;

        return { files, next_page_token };
    },

    async downloadFile(
        access_token: string,
        file_id: string,
    ): Promise<ImportedFile> {
        // Get metadata for filename + revision first.
        const metaResp = await fetch(
            `${API_BASE}/files/${encodeURIComponent(file_id)}?fields=name,size,etag,extension`,
            { headers: { Authorization: `Bearer ${access_token}` } },
        );
        if (!metaResp.ok) {
            throw new Error(
                `Box metadata failed: ${metaResp.status} ${await metaResp.text()}`,
            );
        }
        const meta = (await metaResp.json()) as {
            name: string;
            etag?: string;
            extension?: string;
        };

        // /content returns 302 to a short-lived pre-signed URL — fetch
        // follows redirects automatically and we read the body.
        const contentResp = await fetch(
            `${API_BASE}/files/${encodeURIComponent(file_id)}/content`,
            { headers: { Authorization: `Bearer ${access_token}` } },
        );
        if (!contentResp.ok) {
            throw new Error(
                `Box download failed: ${contentResp.status} ${await contentResp.text()}`,
            );
        }
        const arrayBuf = await contentResp.arrayBuffer();
        return {
            bytes: Buffer.from(arrayBuf),
            filename: meta.name,
            mime_type: extToMime(meta.extension ?? extOf(meta.name)),
            revision: meta.etag ?? null,
        };
    },
};

function extOf(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const EXT_TO_MIME: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
};

function extToMime(ext: string): string {
    const norm = ext.toLowerCase().replace(/^\./, "");
    return EXT_TO_MIME[norm] ?? "application/octet-stream";
}
