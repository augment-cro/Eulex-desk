/**
 * AdminMax API client.
 *
 * Token storage is intentionally separate from the user OAuth track
 * (`tokens` in localStorage). The admin token never leaves localStorage
 * and is only sent on /adminmax/* fetches.
 */

import { API_BASE } from "@/app/lib/apiBase";

const TOKEN_KEY = "adminmax_token";
const TOKEN_EXPIRES_KEY = "adminmax_token_expires_at";

export function getAdminToken(): string | null {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    const expiresRaw = window.localStorage.getItem(TOKEN_EXPIRES_KEY);
    const expires = expiresRaw ? parseInt(expiresRaw, 10) : 0;
    if (expires && expires < Date.now()) {
        clearAdminToken();
        return null;
    }
    return token;
}

export function setAdminToken(token: string, expiresAt: number): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(TOKEN_EXPIRES_KEY, String(expiresAt));
}

export function clearAdminToken(): void {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_EXPIRES_KEY);
}

async function adminFetch<T>(
    path: string,
    init?: RequestInit,
): Promise<T> {
    const token = getAdminToken();
    if (!token) throw new AdminUnauthorizedError("No admin token");
    const res = await fetch(`${API_BASE}/adminmax${path}`, {
        cache: "no-store",
        ...init,
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(init?.headers as Record<string, string> | undefined),
        },
    });
    if (res.status === 401) {
        clearAdminToken();
        throw new AdminUnauthorizedError("Admin token rejected");
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Admin API error: ${res.status}`);
    }
    if (res.headers.get("content-type")?.includes("application/json")) {
        return (await res.json()) as T;
    }
    return undefined as T;
}

export class AdminUnauthorizedError extends Error {}

// ── login ────────────────────────────────────────────────────────────────

export async function adminLogin(password: string): Promise<{
    token: string;
    expiresAt: number;
}> {
    const res = await fetch(`${API_BASE}/adminmax/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
    });
    if (res.status === 429) {
        throw new Error("Previše neuspjelih pokušaja. Pričekajte 5 minuta.");
    }
    if (res.status === 401) {
        throw new Error("Pogrešna lozinka.");
    }
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Admin login failed: ${res.status}`);
    }
    const body = (await res.json()) as { token: string; expiresAt: number };
    setAdminToken(body.token, body.expiresAt);
    return body;
}

// ── domain types ─────────────────────────────────────────────────────────

export interface AdminUserSummary {
    id: string;
    email: string;
    display_name: string | null;
    wp_user_id: number | null;
    created_at: string | null;
    /** Effective tier (expired override already folded to free). */
    tier_level_id: number | null;
    tier_label: string | null;
    tier_slug: string | null;
    active_tier_until: string | null;
    last_login_at: string | null;
    login_count: number;
    iterations_total: number;
    input_tokens_total: number;
    output_tokens_total: number;
    cache_creation_input_tokens_total: number;
    cache_read_input_tokens_total: number;
    cost_usd_total: number;
    request_count: number;
    error_count: number;
    last_used: string | null;
}

export type AdminUsersSortKey =
    | "cost"
    | "requests"
    | "errors"
    | "last_used"
    | "email"
    | "created"
    | "last_login"
    | "tier";

export type AdminUsersSortDir = "asc" | "desc";

export interface AdminUsersResponse {
    range: { from: string; to: string };
    pagination: { limit: number; offset: number; total: number };
    filter: {
        q: string;
        sort: AdminUsersSortKey;
        dir: AdminUsersSortDir;
        only_active: boolean;
    };
    totals: {
        cost_usd_total: number;
        request_count: number;
        input_tokens_total: number;
        output_tokens_total: number;
        cache_read_input_tokens_total: number;
        cache_creation_input_tokens_total: number;
        error_count: number;
        /** New signups since the operator's last login. */
        new_users_count: number;
        /** ISO timestamp the new_users_count is measured from. */
        new_users_since: string;
        /** All registered users, regardless of the date-range filter. */
        total_users: number;
        /** Distinct Stripe customers with an active subscription (null if Stripe unreachable). */
        paid_users_count: number | null;
        /** Active Stripe subscriptions backing paid_users_count. */
        paid_subs_count: number | null;
        /** Monthly run-rate of active Stripe subscriptions, in cents. */
        paid_mrr_cents: number | null;
    };
    users: AdminUserSummary[];
}

export interface AdminSupabaseAuthInfo {
    supabase_user_id: string;
    provider: string | null;
    providers: string[];
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    created_at: string | null;
    banned_until: string | null;
}

export interface AdminUserDetailResponse {
    user: {
        id: string;
        email: string;
        display_name: string | null;
        country: string | null;
        wp_user_id: number | null;
        created_at: string | null;
    };
    tier: {
        active_tier_level_id: number | null;
        active_tier_until: string | null;
        tier_label: string | null;
        tier_slug: string | null;
        stripe_customer_id: string | null;
    };
    login: {
        last_login_at: string | null;
        login_count: number;
    };
    supabase: {
        configured: boolean;
        supabase_user_id: string | null;
        auth: AdminSupabaseAuthInfo | null;
        error: string | null;
    };
    range: { from: string; to: string };
    totals: {
        iterations_total: number;
        input_tokens_total: number;
        output_tokens_total: number;
        cache_creation_input_tokens_total: number;
        cache_read_input_tokens_total: number;
        cost_usd_total: number;
        request_count: number;
        error_count: number;
        first_used: string | null;
        last_used: string | null;
    };
}

export interface AdminUsageRow {
    id: string;
    provider: string;
    model: string;
    chat_id: string | null;
    project_id: string | null;
    chat_message_id: string | null;
    project_chat_message_id: string | null;
    iterations: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: string | number | null;
    cost_breakdown?: { complete: boolean; knownCostUsd: number } | null;
    duration_ms: number | null;
    status: string;
    error_message: string | null;
    created_at: string;
}

export interface AdminMessageRow {
    id: string;
    role: "user" | "assistant" | string;
    content: unknown;
    files: unknown;
    annotations: unknown;
    is_flagged: boolean | null;
    created_at: string;
    chat_id: string;
    chat_title: string | null;
    project_id: string | null;
}

export interface PaginatedRows<T> {
    range: { from: string; to: string };
    limit: number;
    offset: number;
    total: number;
    rows: T[];
}

// ── data fetchers ────────────────────────────────────────────────────────

function rangeQuery(range?: { from?: string; to?: string }): string {
    const params = new URLSearchParams();
    if (range?.from) params.set("from", range.from);
    if (range?.to) params.set("to", range.to);
    const s = params.toString();
    return s ? `?${s}` : "";
}

export interface ListUsersOpts {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    q?: string;
    sort?: AdminUsersSortKey;
    dir?: AdminUsersSortDir;
    only_active?: boolean;
    /** Filter by EFFECTIVE tier_level_id (free = the free level id). */
    tier?: number;
    /** Only users registered after this ISO timestamp (new-users badge). */
    created_after?: string;
}

export function listUsers(opts?: ListUsersOpts): Promise<AdminUsersResponse> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (typeof opts?.limit === "number")
        params.set("limit", String(opts.limit));
    if (typeof opts?.offset === "number")
        params.set("offset", String(opts.offset));
    if (opts?.q) params.set("q", opts.q);
    if (opts?.sort) params.set("sort", opts.sort);
    if (opts?.dir) params.set("dir", opts.dir);
    if (opts?.only_active) params.set("only_active", "true");
    if (typeof opts?.tier === "number") params.set("tier", String(opts.tier));
    if (opts?.created_after) params.set("created_after", opts.created_after);
    const s = params.toString();
    return adminFetch<AdminUsersResponse>(`/users${s ? `?${s}` : ""}`);
}

export function getUser(
    userId: string,
    range?: { from?: string; to?: string },
): Promise<AdminUserDetailResponse> {
    return adminFetch<AdminUserDetailResponse>(
        `/users/${userId}${rangeQuery(range)}`,
    );
}

export function listUsage(
    userId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
): Promise<PaginatedRows<AdminUsageRow>> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const q = params.toString();
    return adminFetch<PaginatedRows<AdminUsageRow>>(
        `/users/${userId}/usage${q ? `?${q}` : ""}`,
    );
}

export function listMessages(
    userId: string,
    opts?: { from?: string; to?: string; limit?: number; offset?: number },
): Promise<PaginatedRows<AdminMessageRow>> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const q = params.toString();
    return adminFetch<PaginatedRows<AdminMessageRow>>(
        `/users/${userId}/messages${q ? `?${q}` : ""}`,
    );
}

// ── full chat thread ─────────────────────────────────────────────────────

/** Per-answer cost/token rollup, joined from llm_usage. Present on
 *  assistant turns that have a usage row; null otherwise (user turns,
 *  or assistant turns recorded before usage tracking). cost_usd may be
 *  null when any contributing call has unknown or incomplete usage. */
export interface AdminChatThreadUsage {
    cost_usd: number | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    iterations: number;
    model: string | null;
    duration_ms: number | null;
    had_error: boolean;
}

export interface AdminChatThreadMessage {
    id: string;
    role: string;
    content: unknown;
    files: unknown;
    annotations: unknown;
    is_flagged: boolean | null;
    created_at: string;
    usage: AdminChatThreadUsage | null;
}

/** Conversation-wide totals across every llm_usage row for the chat. */
export interface AdminChatThreadTotals {
    cost_usd_total: number;
    input_tokens_total: number;
    output_tokens_total: number;
    cache_creation_input_tokens_total: number;
    cache_read_input_tokens_total: number;
    request_count: number;
    error_count: number;
}

export interface AdminChatThreadResponse {
    chat: {
        id: string;
        title: string | null;
        user_id: string;
        project_id: string | null;
        created_at: string;
    };
    user: {
        id: string;
        email: string;
        display_name: string | null;
    } | null;
    messages: AdminChatThreadMessage[];
    totals: AdminChatThreadTotals;
}

export function getChatThread(
    chatId: string,
    userId?: string,
): Promise<AdminChatThreadResponse> {
    const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    return adminFetch<AdminChatThreadResponse>(`/chats/${chatId}/full${q}`);
}

// ── global chat list ─────────────────────────────────────────────────────

/** One row in the workspace-wide chat list (GET /adminmax/chats). */
export interface AdminChatListRow {
    id: string;
    title: string | null;
    project_id: string | null;
    created_at: string;
    user_id: string;
    email: string | null;
    display_name: string | null;
    message_count: number;
    /** Newest message timestamp; chat creation for empty chats. */
    last_activity_at: string;
    cost_usd_total: number;
    request_count: number;
    error_count: number;
}

export function listChats(opts?: {
    from?: string;
    to?: string;
    /** Matches chat title, owner email/name, or message content. */
    q?: string;
    limit?: number;
    offset?: number;
}): Promise<PaginatedRows<AdminChatListRow>> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.q) params.set("q", opts.q);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const s = params.toString();
    return adminFetch<PaginatedRows<AdminChatListRow>>(
        `/chats${s ? `?${s}` : ""}`,
    );
}

// ── admin audit trail ────────────────────────────────────────────────────

/** One row in the admin action audit trail (GET /adminmax/audit). */
export interface AdminAuditRow {
    id: string;
    actor: string;
    /** Dot-namespaced verb, e.g. "user.tier.set", "credits.grant". */
    action: string;
    target_type: string | null;
    target_id: string | null;
    payload: Record<string, unknown> | null;
    ip: string | null;
    created_at: string;
}

export function listAudit(opts?: {
    from?: string;
    to?: string;
    /** Matches action, target id/type, or actor. */
    q?: string;
    limit?: number;
    offset?: number;
}): Promise<PaginatedRows<AdminAuditRow>> {
    const params = new URLSearchParams();
    if (opts?.from) params.set("from", opts.from);
    if (opts?.to) params.set("to", opts.to);
    if (opts?.q) params.set("q", opts.q);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const s = params.toString();
    return adminFetch<PaginatedRows<AdminAuditRow>>(
        `/audit${s ? `?${s}` : ""}`,
    );
}

// ── tier_limits ──────────────────────────────────────────────────────────

/** Resolved per-tier feature flags. bool entitlements → boolean,
 *  int entitlements (e.g. maxSavedProjects) → number. */
export type TierEntitlements = Record<string, boolean | number>;

/** Bilingual marketing copy for a plan (mirrors backend planCatalog). */
export interface PlanLocaleCopy {
    name: string;
    tagline: string;
    price: string;
    period: string;
    intro?: string;
    cta: string;
    features: string[];
}
export interface PlanMarketing {
    order: number;
    popular: boolean;
    locales: { hr: PlanLocaleCopy; en: PlanLocaleCopy };
}

export interface AdminTierLimit {
    tier_level_id: number;
    tier_slug: string;
    display_label: string;
    daily_tokens: number;
    entitlements: TierEntitlements;
    /** May be `{}` before defaults are seeded; the editor normalises it. */
    marketing: PlanMarketing | Record<string, never>;
    /** Public monthly price string (hr, e.g. "€399,00"); read-only enrichment
     *  from the same source as /billing/plans. null for tiers with no plan. */
    price?: string | null;
    /** Env-driven Stripe product id for this tier; null when unset (free,
     *  enterprise, foundation, …). Read-only enrichment. */
    stripe_product_id?: string | null;
    updated_at: string;
    /** Users currently on this tier via a live override (0 = empty). */
    user_count?: number;
    /** True for the default free tier — always kept in filters. */
    is_free?: boolean;
}

/** One entitlement key as defined by the backend catalog. */
export interface EntitlementDef {
    key: string;
    type: "bool" | "int";
    group: string;
    labelHr: string;
    labelEn: string;
    defaults: Record<"free" | "plus" | "pro" | "team", boolean | number>;
    unlimitedWhenZero?: boolean;
}

export function listTiers(): Promise<{ tiers: AdminTierLimit[] }> {
    return adminFetch<{ tiers: AdminTierLimit[] }>(`/tiers`);
}

/** Code-defined catalog used to render the entitlements editor. */
export function getEntitlementCatalog(): Promise<{ catalog: EntitlementDef[] }> {
    return adminFetch<{ catalog: EntitlementDef[] }>(`/entitlement-catalog`);
}

export function updateTier(
    tierLevelId: number,
    body: Partial<
        Pick<AdminTierLimit, "daily_tokens" | "display_label" | "tier_slug">
    > & { entitlements?: TierEntitlements; marketing?: PlanMarketing },
): Promise<{ tier: AdminTierLimit }> {
    return adminFetch<{ tier: AdminTierLimit }>(`/tiers/${tierLevelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function createTier(input: {
    tier_level_id: number;
    tier_slug: string;
    display_label: string;
    daily_tokens: number;
    entitlements?: TierEntitlements;
}): Promise<{ ok: true }> {
    return adminFetch<{ ok: true }>(`/tiers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

// ── promo codes (Stripe coupons + promotion codes) ───────────────────────

export interface AdminPromoStats {
    /** Paid subscription invoices attributed to this code. */
    invoices: number;
    /** Distinct paying subscribers attributed to this code. */
    subscribers: number;
    revenue_cents: number;
}

export interface AdminPromoCode {
    id: string;
    code: string;
    active: boolean;
    coupon_id: string | null;
    coupon_valid: boolean | null;
    percent_off: number | null;
    amount_off: number | null;
    currency: string | null;
    duration: "forever" | "once" | "repeating" | null;
    duration_in_months: number | null;
    /** Tier slugs the code is restricted to; empty = all products. */
    plans: string[];
    expires_at: string | null;
    max_redemptions: number | null;
    /** Stripe's aggregate redemption counter. */
    times_redeemed: number;
    created_at: string;
    /** billing_revenue attribution (null = no attributed invoices yet). */
    stats: AdminPromoStats | null;
}

export function listPromos(): Promise<{
    configured: boolean;
    promos: AdminPromoCode[];
}> {
    return adminFetch<{ configured: boolean; promos: AdminPromoCode[] }>(
        `/promos`,
    );
}

export function createPromo(input: {
    code: string;
    percent_off: number;
    duration?: "forever" | "once" | "repeating";
    duration_in_months?: number;
    plans?: string[];
    expires_at?: string;
    max_redemptions?: number;
}): Promise<{ ok: true; id: string; code: string }> {
    return adminFetch<{ ok: true; id: string; code: string }>(`/promos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export function setPromoActive(
    id: string,
    active: boolean,
): Promise<{ ok: true; id: string; active: boolean }> {
    return adminFetch<{ ok: true; id: string; active: boolean }>(
        `/promos/${encodeURIComponent(id)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active }),
        },
    );
}

// ── user_token_credits (top-up) ──────────────────────────────────────────

export interface AdminCreditGrant {
    id: string;
    tokens_granted: string | number;
    tokens_consumed: string | number;
    payment_method: "stripe" | "bank_transfer" | "admin_manual";
    external_reference: string | null;
    stripe_event_id: string | null;
    amount_eur_cents: number | null;
    granted_by_admin_id: string | null;
    granted_at: string;
    expires_at: string | null;
    voided_at: string | null;
    voided_reason: string | null;
    notes: string | null;
}

export interface AdminCreditsResponse {
    grants: AdminCreditGrant[];
    balance: { bonus_remaining: number; pack_count: number };
}

export function listUserCredits(
    userId: string,
): Promise<AdminCreditsResponse> {
    return adminFetch<AdminCreditsResponse>(`/users/${userId}/credits`);
}

export function grantUserCredits(
    userId: string,
    body: {
        tokens_granted: number;
        payment_method: "bank_transfer" | "admin_manual";
        external_reference?: string;
        amount_eur_cents?: number;
        expires_at?: string;
        notes?: string;
    },
): Promise<{ id: string; tokens_granted: number }> {
    return adminFetch<{ id: string; tokens_granted: number }>(
        `/users/${userId}/credits`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        },
    );
}

export function voidCreditGrant(
    creditId: string,
    reason?: string,
): Promise<{ ok: true }> {
    return adminFetch<{ ok: true }>(`/credits/${creditId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reason ? { reason } : {}),
    });
}

// ── new-users badge ──────────────────────────────────────────────────────

export interface NewUsersResponse {
    since: string;
    count: number;
    recent: Array<{
        id: string;
        email: string;
        display_name: string | null;
        created_at: string;
    }>;
}

export function getNewUsers(): Promise<NewUsersResponse> {
    return adminFetch<NewUsersResponse>(`/new-users`);
}

export function markNewUsersSeen(): Promise<{
    ok: true;
    last_checked_at: string;
}> {
    return adminFetch<{ ok: true; last_checked_at: string }>(
        `/new-users/seen`,
        { method: "POST" },
    );
}

// ── tier management ──────────────────────────────────────────────────────

export interface TierHistoryRow {
    id: string;
    old_tier_level_id: number | null;
    new_tier_level_id: number | null;
    old_until: string | null;
    new_until: string | null;
    source: "stripe" | "ump_sync" | "admin";
    reason: string | null;
    created_at: string;
    old_label: string | null;
    new_label: string | null;
}

export function getTierHistory(
    userId: string,
): Promise<{ history: TierHistoryRow[] }> {
    return adminFetch<{ history: TierHistoryRow[] }>(
        `/users/${userId}/tier-history`,
    );
}

export function setUserTier(
    userId: string,
    body: {
        tier_level_id: number | null;
        until?: string | null;
        reason?: string;
    },
): Promise<{
    ok: true;
    tier: {
        active_tier_level_id: number | null;
        active_tier_until: string | null;
    };
}> {
    return adminFetch(`/users/${userId}/tier`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function updateUserProfile(
    userId: string,
    body: {
        display_name?: string | null;
        country?: string | null;
    },
): Promise<{
    ok: true;
    user: { display_name: string | null; country: string | null };
}> {
    return adminFetch(`/users/${userId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export function suspendUser(
    userId: string,
    action: "ban" | "unban",
    hours?: number,
): Promise<{ ok: true; action: "ban" | "unban" }> {
    return adminFetch(`/users/${userId}/suspend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(hours ? { hours } : {}) }),
    });
}

// ── analytics ────────────────────────────────────────────────────────────

export interface AnalyticsDaily {
    day: string;
    signups: number;
    active_users: number;
    requests: number;
    cost_usd: number;
    tokens: number;
    revenue_eur_cents: number;
}

export interface AnalyticsResponse {
    range: { from: string; to: string };
    daily: AnalyticsDaily[];
    tiers: Array<{
        tier_level_id: number;
        label: string | null;
        users: number;
    }>;
    totals: {
        new_users: number;
        active_users: number;
        requests: number;
        cost_usd: number;
        revenue_eur_cents: number;
    };
    /** NOW-anchored subscription run-rate metrics from billing_revenue. */
    revenue_metrics: {
        /** Subscription revenue collected in the last 30 days (cents). */
        mrr_cents: number;
        /** Trailing-365-day subscription revenue (cents). */
        arr_cents: number;
        /** Distinct paying users in the last 30 days. */
        active_payers: number;
        /** MRR / active payers (cents). */
        arpu_cents: number;
        /** Net revenue retention % of the prior-30d cohort; null if no base. */
        nrr_pct: number | null;
        /** 30d-vs-prior-30d MRR movement (cents). */
        bridge: {
            new_cents: number;
            expansion_cents: number;
            contraction_cents: number;
            churned_cents: number;
        };
    };
    /** Usage split by product surface (llm_usage.client), cost-desc.
     *  "unknown" = rows written before call sites tagged themselves. */
    surfaces: Array<{
        surface: string;
        requests: number;
        users: number;
        cost_usd: number;
        tokens: number;
    }>;
}

export function getAnalytics(range?: {
    from?: string;
    to?: string;
}): Promise<AnalyticsResponse> {
    return adminFetch<AnalyticsResponse>(`/analytics${rangeQuery(range)}`);
}

export function sendWeeklySummary(): Promise<{
    ok: boolean;
    sent_to: string;
    stats: Record<string, number>;
}> {
    return adminFetch(`/weekly-summary/send`, { method: "POST" });
}

// ── bugfix status ────────────────────────────────────────────────────────

/**
 * Server-derived status: merged PR > open PR > raw issue state.
 * "merged" = fix waiting for LIVE; "live" = fix promoted to stable but
 * the issue is still open (awaiting closure).
 */
export type BugfixIssueStatus =
    | "open"
    | "pr_open"
    | "merged"
    | "live"
    | "closed";

export interface BugfixLinkedPr {
    number: number;
    state: "open" | "closed";
    mergedAt: string | null;
    htmlUrl: string;
}

export interface BugfixIssue {
    number: number;
    title: string;
    state: "open" | "closed";
    labels: string[];
    createdAt: string;
    closedAt: string | null;
    htmlUrl: string;
    linkedPr: BugfixLinkedPr | null;
    status: BugfixIssueStatus;
}

/** `configured: false` = no GitHub token on the backend (private repo). */
export type BugfixStatusResponse =
    | { configured: false; repo: string }
    | {
          configured: true;
          repo: string;
          deploy: { mainAheadOfStable: number | null };
          issues: BugfixIssue[];
          fetchedAt: string;
      };

export function getBugfixStatus(): Promise<BugfixStatusResponse> {
    return adminFetch<BugfixStatusResponse>(`/bugfix/status`);
}

/**
 * Build a CSV download URL. We append `token=` so the browser-driven
 * GET (window.open) carries the admin token; the backend accepts either
 * Authorization header or `?token=` to stay friendly to <a download>.
 *
 * Note: backend currently only honors Authorization. For a click-driven
 * download we therefore fetch the CSV with auth, then trigger a blob
 * download in JS — see triggerCsvDownload below.
 */
export async function triggerCsvDownload(
    path: string,
    filename: string,
): Promise<void> {
    const token = getAdminToken();
    if (!token) throw new AdminUnauthorizedError("No admin token");
    const res = await fetch(`${API_BASE}/adminmax${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `CSV export failed: ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// ── databases inventory ───────────────────────────────────────────────────

export type DbLayerStatus = "ok" | "partial" | "empty" | "error" | "unconfigured";
export type DbStatValue = number | string | boolean | null;

export type DbLayer = {
    status: DbLayerStatus;
    source: string;
    stats: Record<string, DbStatValue>;
    notes: string[];
    error?: string;
};

export type DbJurisdiction = {
    code: string;
    flag: string;
    name: string;
    tier: number;
    sql: DbLayer;
    vector: DbLayer;
    graph: DbLayer;
    services: { api: string | null; mcp: string | null; scope: string | null };
};

export type DbSource = {
    key: string;
    kind: "postgres" | "neo4j" | "pinecone";
    label: string;
    status: "ok" | "error" | "unconfigured";
    latency_ms: number | null;
    error?: string;
    details: Record<string, DbStatValue>;
};

export type DbSnapshotMeta = {
    id: number;
    taken_at: string;
    trigger: "manual" | "cron" | "boot";
    scan_ms: number;
};

export type DatabasesOverview = {
    /** false when the backend has no external ops-inventory service configured. */
    available?: boolean;
    detail?: string;
    generated_at: string;
    cached: boolean;
    scan_ms: number;
    snapshot: DbSnapshotMeta | null;
    history: DbSnapshotMeta[];
    schedule: string;
    sources: DbSource[];
    jurisdictions: DbJurisdiction[];
    totals: {
        jurisdictions: number;
        tier3: number;
        tier2: number;
        tier1: number;
        sql_documents: number;
        vectors: number;
        graph_nodes: number;
    };
    scan: { scanning: boolean; schedule: string };
};

/** Generic proxy to the external ops-inventory service. Without `refresh`
 *  it returns that service's latest stored snapshot; with `refresh` the
 *  service scans now (can take minutes) and stores a new one. */
export async function getDatabasesOverview(
    refresh = false,
): Promise<DatabasesOverview> {
    return adminFetch<DatabasesOverview>(
        `/databases${refresh ? "?refresh=1" : ""}`,
    );
}
