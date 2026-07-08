/**
 * Shared types for native file-source connectors.
 *
 * A connector wraps a third-party storage provider (Google Drive,
 * OneDrive, Box) behind a uniform interface. The OAuth router and
 * import handler talk to providers exclusively through this surface so
 * adding a new provider only means dropping a new file under
 * lib/integrations/providers/ and registering it.
 */

export type ProviderId = "google_drive" | "onedrive" | "box";

export interface OAuthTokenSet {
    access_token: string;
    refresh_token?: string | null;
    token_type?: string;
    /** Absolute timestamp; not seconds-from-now. */
    expires_at?: Date | null;
    scopes?: string[];
}

export interface ConnectedAccountInfo {
    email: string | null;
    display_name: string | null;
}

export interface ProviderFile {
    /** Provider-native ID (Drive fileId / driveItem.id / Box file id). */
    id: string;
    name: string;
    /** MIME-type we'll store in the documents table. */
    mime_type: string;
    /** Bytes; null when the provider doesn't expose it (Google Docs). */
    size_bytes: number | null;
    /** Provider-side modification timestamp, ISO-8601. */
    modified_at: string | null;
    /** ETag / revisionId — used to detect "newer version available". */
    revision: string | null;
    /** Web URL, useful to surface "Open in Drive" links. */
    web_url: string | null;
    /** Folder path or parent name when known; pure UX nicety. */
    parent: string | null;
}

export interface ListFilesInput {
    /** Free-text search; provider decides interpretation. */
    query?: string;
    /** Pagination cursor returned by a previous call. */
    page_token?: string;
    /** Max items to return (provider may cap lower). */
    page_size?: number;
}

export interface ListFilesResponse {
    files: ProviderFile[];
    next_page_token: string | null;
}

export interface ImportedFile {
    /** Raw bytes of the file the user picked. */
    bytes: Buffer;
    /** Filename to persist in our documents store. */
    filename: string;
    /** Final MIME-type after any provider-side conversion (Google export). */
    mime_type: string;
    /** Provider revision/etag at import time for drift detection later. */
    revision: string | null;
}

/**
 * Provider implementation surface. Each provider in
 * lib/integrations/providers/ exports an object matching this shape.
 */
export interface ProviderAdapter {
    id: ProviderId;
    /** Human-readable name surfaced in the UI. */
    display_name: string;

    /**
     * True when the operator has configured the env vars / secrets the
     * provider needs (client_id, client_secret, etc.). When false, the
     * REST routes return 503 — keeps the surface visible but inactive.
     */
    isConfigured(): boolean;

    /**
     * Build the URL the user is redirected to for consent. `state` is
     * an opaque CSRF token stored in a short-lived signed cookie.
     */
    buildAuthorizeUrl(params: {
        redirect_uri: string;
        state: string;
    }): string;

    /** Exchange the authorization code returned to /callback for tokens. */
    exchangeCode(params: {
        code: string;
        redirect_uri: string;
    }): Promise<OAuthTokenSet>;

    /** Use the refresh_token to obtain a new access_token. */
    refreshTokens(refresh_token: string): Promise<OAuthTokenSet>;

    /** Fetch the email + display name for the connected account. */
    fetchAccountInfo(access_token: string): Promise<ConnectedAccountInfo>;

    /** List/search files visible to the connected account. */
    listFiles(
        access_token: string,
        input: ListFilesInput,
    ): Promise<ListFilesResponse>;

    /**
     * Download a single file by its provider-native ID. Implementations
     * pick the right export MIME-type for non-binary native formats
     * (Google Docs → .docx, Sheets → .xlsx, etc.).
     */
    downloadFile(
        access_token: string,
        file_id: string,
    ): Promise<ImportedFile>;
}
