/**
 * Microsoft OneDrive connector via Microsoft Graph.
 *
 * Auth: OAuth 2.0 v2 endpoint (login.microsoftonline.com).
 *   Scopes: Files.Read.All offline_access User.Read
 *   tenant: ONEDRIVE_TENANT_ID env var or 'common' (work + personal).
 *
 * Required env vars:
 *   ONEDRIVE_CLIENT_ID
 *   ONEDRIVE_CLIENT_SECRET
 *   ONEDRIVE_TENANT_ID  (optional, defaults to 'common')
 *
 * Notes verified against Microsoft Graph docs (Context7, 2026-05):
 *   - /me/drive/items/{id}/content returns 307 to a short-lived
 *     pre-authenticated download URL — fetch follows redirects by
 *     default in Node 20+ so we get the bytes back transparently.
 *   - eTag changes whenever the file content changes — use it for
 *     drift detection on re-import.
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

const SCOPES = [
    "Files.Read.All",
    "offline_access",
    "User.Read",
    "openid",
    "email",
    "profile",
];

function tenant(): string {
    return process.env.ONEDRIVE_TENANT_ID?.trim() || "common";
}

function authorityUrl(path: string): string {
    return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/${path}`;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export const oneDriveAdapter: ProviderAdapter = {
    id: "onedrive",
    // Display label uses Microsoft's umbrella brand "Microsoft 365" since
    // the underlying Microsoft Graph token can reach OneDrive (personal),
    // OneDrive for Business and SharePoint document libraries through the
    // same Files.Read.All scope. The provider id stays `onedrive` to keep
    // the integration_accounts.provider CHECK constraint stable.
    display_name: "Microsoft 365",

    isConfigured(): boolean {
        return Boolean(
            process.env.ONEDRIVE_CLIENT_ID?.trim() &&
                process.env.ONEDRIVE_CLIENT_SECRET?.trim(),
        );
    },

    buildAuthorizeUrl({ redirect_uri, state }) {
        const params = new URLSearchParams({
            client_id: process.env.ONEDRIVE_CLIENT_ID ?? "",
            response_type: "code",
            redirect_uri,
            response_mode: "query",
            scope: SCOPES.join(" "),
            state,
            // prompt=consent ensures the user re-confirms scopes after
            // we add new ones; harmless on first connect.
            prompt: "consent",
        });
        return `${authorityUrl("authorize")}?${params.toString()}`;
    },

    async exchangeCode({ code, redirect_uri }): Promise<OAuthTokenSet> {
        const body = new URLSearchParams({
            client_id: process.env.ONEDRIVE_CLIENT_ID ?? "",
            client_secret: process.env.ONEDRIVE_CLIENT_SECRET ?? "",
            code,
            redirect_uri,
            grant_type: "authorization_code",
            scope: SCOPES.join(" "),
        });
        const resp = await fetch(authorityUrl("token"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Microsoft token exchange failed: ${resp.status} ${await resp.text()}`,
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
            client_id: process.env.ONEDRIVE_CLIENT_ID ?? "",
            client_secret: process.env.ONEDRIVE_CLIENT_SECRET ?? "",
            refresh_token,
            grant_type: "refresh_token",
            scope: SCOPES.join(" "),
        });
        const resp = await fetch(authorityUrl("token"), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (!resp.ok) {
            throw new Error(
                `Microsoft token refresh failed: ${resp.status} ${await resp.text()}`,
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
            // Microsoft DOES return a new refresh_token on refresh; the
            // caller MUST persist it (the old one keeps working for a
            // short overlap window but rotation is the documented path).
            refresh_token: data.refresh_token ?? null,
            token_type: data.token_type ?? "Bearer",
            expires_at: data.expires_in
                ? new Date(Date.now() + data.expires_in * 1000)
                : null,
            scopes: data.scope?.split(" ") ?? SCOPES,
        };
    },

    async fetchAccountInfo(access_token: string): Promise<ConnectedAccountInfo> {
        const resp = await fetch(`${GRAPH_BASE}/me`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) return { email: null, display_name: null };
        const data = (await resp.json()) as {
            mail?: string;
            userPrincipalName?: string;
            displayName?: string;
        };
        return {
            email: data.mail ?? data.userPrincipalName ?? null,
            display_name: data.displayName ?? null,
        };
    },

    async listFiles(
        access_token: string,
        input: ListFilesInput,
    ): Promise<ListFilesResponse> {
        // Two endpoints exist:
        //   /me/drive/root/children     — first page of root folder
        //   /me/drive/root/search(q='') — name + content search across drive
        // We pick by whether the caller supplied a query.
        const select =
            "id,name,size,file,folder,lastModifiedDateTime,eTag,webUrl,parentReference";
        const top = String(Math.min(input.page_size ?? 25, 200));

        const url = input.query
            ? `${GRAPH_BASE}/me/drive/root/search(q='${encodeURIComponent(
                  input.query.replace(/'/g, "''"),
              )}')?$select=${select}&$top=${top}`
            : `${GRAPH_BASE}/me/drive/root/children?$select=${select}&$top=${top}&$orderby=lastModifiedDateTime%20desc`;

        // OneDrive paginates via @odata.nextLink (a full URL, not a token).
        // We surface it as page_token verbatim and re-request it directly
        // when present.
        const requestUrl = input.page_token ?? url;

        const resp = await fetch(requestUrl, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!resp.ok) {
            throw new Error(
                `OneDrive list failed: ${resp.status} ${await resp.text()}`,
            );
        }
        const data = (await resp.json()) as {
            value?: Array<{
                id: string;
                name: string;
                size?: number;
                file?: { mimeType?: string };
                folder?: { childCount?: number };
                lastModifiedDateTime?: string;
                eTag?: string;
                webUrl?: string;
                parentReference?: { name?: string; path?: string };
            }>;
            "@odata.nextLink"?: string;
        };

        const files: ProviderFile[] = (data.value ?? [])
            // Skip folders for now — file picker gives the user a
            // browseable tree on the frontend, but the import action
            // only ever targets a leaf file.
            .filter((item) => !item.folder)
            .map((item) => ({
                id: item.id,
                name: item.name,
                mime_type: item.file?.mimeType ?? "application/octet-stream",
                size_bytes: item.size ?? null,
                modified_at: item.lastModifiedDateTime ?? null,
                revision: item.eTag ?? null,
                web_url: item.webUrl ?? null,
                parent: item.parentReference?.name ?? null,
            }));

        return {
            files,
            next_page_token: data["@odata.nextLink"] ?? null,
        };
    },

    async downloadFile(
        access_token: string,
        file_id: string,
    ): Promise<ImportedFile> {
        // Need metadata for filename + revision.
        const metaResp = await fetch(
            `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(file_id)}?$select=name,file,eTag,size`,
            { headers: { Authorization: `Bearer ${access_token}` } },
        );
        if (!metaResp.ok) {
            throw new Error(
                `OneDrive metadata failed: ${metaResp.status} ${await metaResp.text()}`,
            );
        }
        const meta = (await metaResp.json()) as {
            name: string;
            file?: { mimeType?: string };
            eTag?: string;
        };

        // /content returns 307 to a pre-authenticated download URL.
        // Node fetch follows redirects automatically; we end up with
        // the bytes in a single round-trip.
        const contentResp = await fetch(
            `${GRAPH_BASE}/me/drive/items/${encodeURIComponent(file_id)}/content`,
            { headers: { Authorization: `Bearer ${access_token}` } },
        );
        if (!contentResp.ok) {
            throw new Error(
                `OneDrive download failed: ${contentResp.status} ${await contentResp.text()}`,
            );
        }
        const arrayBuf = await contentResp.arrayBuffer();
        return {
            bytes: Buffer.from(arrayBuf),
            filename: meta.name,
            mime_type: meta.file?.mimeType ?? "application/octet-stream",
            revision: meta.eTag ?? null,
        };
    },
};
