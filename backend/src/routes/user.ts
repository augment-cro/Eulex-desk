import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { from } from "../lib/dbShim";
import { getPool } from "../lib/db";
import { maskApiKey } from "../lib/crypto";
import { deleteFile } from "../lib/storage";
import { safeErrorMessage, safeErrorLog } from "../lib/safeError";
import {
    isSupabaseAdminConfigured,
    deleteSupabaseUser,
} from "../lib/supabaseAdmin";
import {
    getRateLimitSnapshot,
    resolveTierLimits,
    setRateLimitHeaders,
    SOFT_WARNING_THRESHOLD,
} from "../lib/rateLimit";
import {
    getEntitlements,
    tierKeyForLevelId,
    type Entitlements,
    type TierKey,
} from "../lib/entitlements";
import { resolveModel, DEFAULT_TABULAR_MODEL } from "../lib/llm/models";

export const userRouter = Router();

/**
 * Resolve the caller's tier + entitlements for the profile response.
 * Never throws — falls back to free defaults so a metering hiccup can't
 * break the profile load.
 */
async function resolveProfileEntitlements(res: {
    locals: Record<string, unknown>;
}): Promise<{
    tierLevelId: number;
    tierKey: TierKey;
    tierLabel: string;
    entitlements: Entitlements;
}> {
    const tierLevelId =
        typeof res.locals.tierLevelId === "number"
            ? (res.locals.tierLevelId as number)
            : 3;
    const tierSlug =
        typeof res.locals.tier === "string"
            ? (res.locals.tier as string)
            : null;
    // Authoritative display label, keyed off the resolved tier_level_id
    // (which the auth middleware sets from the UMP override). This must
    // win over the legacy user_profiles.tier string, which is never
    // updated on an out-of-band upgrade (UMP / homepage checkout) and so
    // goes stale — see the overlay at the bottom of GET /profile.
    let tierLabel = "Free";
    try {
        tierLabel = (await resolveTierLimits(tierLevelId, tierSlug))
            .display_label;
    } catch {
        // Non-fatal — keep the safe "Free" default.
    }
    try {
        return {
            tierLevelId,
            tierKey: tierKeyForLevelId(tierLevelId),
            tierLabel,
            entitlements: await getEntitlements(tierLevelId),
        };
    } catch {
        return {
            tierLevelId,
            tierKey: tierKeyForLevelId(tierLevelId),
            tierLabel,
            entitlements: {},
        };
    }
}

const API_KEY_FIELDS = ["claude_api_key", "gemini_api_key", "openai_api_key", "mistral_api_key"] as const;

/**
 * Per-provider "is a server-side fallback key available?" map. Mirrors
 * the env-var fallback order used by `userSettings.ts` so the frontend
 * can show the user "we'll use a shared key — you don't need to enter
 * your own" affordance without ever leaking the key value itself.
 */
function serverKeyAvailability() {
    return {
        claude: !!(
            process.env.ANTHROPIC_API_KEY?.trim() ||
            process.env.CLAUDE_API_KEY?.trim()
        ),
        gemini: !!process.env.GEMINI_API_KEY?.trim(),
        openai: !!(
            process.env.OPENAI_API_KEY?.trim() ||
            process.env.VLLM_API_KEY?.trim()
        ),
        mistral: !!process.env.MISTRAL_API_KEY?.trim(),
    };
}

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  // Tier + entitlements drive client-side feature gating; the backend
  // still enforces every gate server-side via requireEntitlement.
  const { tierLevelId, tierKey, tierLabel, entitlements } =
    await resolveProfileEntitlements(res);
  const { data, error } = await from("user_profiles")
    .select("*")
    .eq("user_id", userId)
    .single();

  // country + vat_number live on user_tier_state (not user_profiles)
  // because public.user_profiles is owned by the postgres role and the
  // IAM DB user can't ALTER it. Single query for both fields.
  let country: string | null = null;
  let vatNumber: string | null = null;
  try {
    const pool = await getPool();
    const r = await pool.query<{ country: string | null; vat_number: string | null }>(
      `SELECT country, vat_number FROM public.user_tier_state WHERE user_id = $1`,
      [userId],
    );
    country = r.rows[0]?.country ?? null;
    vatNumber = r.rows[0]?.vat_number ?? null;
  } catch (err) {
    console.warn(
      "[user/profile] country/VAT lookup failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  if (error || !data) {
    // Return default profile if none exists
    return res.json({
      // Internal users.id (UUID). Surfaced explicitly so the web client
      // can compare against entity.user_id columns (chats.user_id,
      // documents.user_id, …) which all store this UUID — not the
      // WordPress user_id stored as the JWT `sub`. Without this the
      // frontend's owner-check pre-conditions silently mismatch on
      // every owned-resource action (rename/delete) and the user gets
      // a misleading "owner-only action" modal.
      id: userId,
      email: userEmail ?? null,
      display_name: null,
      organisation: null,
      message_credits_used: 0,
      credits_reset_date: new Date(Date.now() + 30 * 86400000).toISOString(),
      tier: tierLabel,
      tier_key: tierKey,
      tier_level_id: tierLevelId,
      entitlements,
      tabular_model: "claude-sonnet-5",
      // Mirrors migration 113's column default. Highest-effort thinking
      // is the safest default for a legal AI tool — better to overspend
      // on a quick question than to under-think a hard one.
      reasoning_effort: "high",
      // Match frontend/src/i18n/request.ts default so a freshly-paired
      // Word add-in opens in the same language as a freshly-loaded web app.
      preferred_language: "hr",
      // country + vat_number from user_tier_state (see comment above).
      country,
      vat_number: vatNumber,
      claude_api_key: null,
      gemini_api_key: null,
      openai_api_key: null,
      mistral_api_key: null,
      server_keys: serverKeyAvailability(),
      // PII Shield defaults — match migration 120 column defaults.
      pii_default_mode: "off",
      pii_review_required: false,
      pii_disclosure_policy: "ask",
    });
  }

  // Mask API keys — never send full keys to the browser
  const safe: Record<string, unknown> = { ...data };
  for (const field of API_KEY_FIELDS) {
    safe[field] = maskApiKey(data[field]);
  }
  // Normalise retired model IDs (MODEL_ALIASES) before they reach any
  // client. A stale row like tabular_model='claude-sonnet-4-6' would
  // otherwise leak to the web app, where getModelProvider() can't
  // resolve it and the Analiza run button silently no-ops.
  safe.tabular_model = resolveModel(data.tabular_model, DEFAULT_TABULAR_MODEL);
  // Always overlay the authenticated user's internal id + email so
  // the client never has to guess the format. user_profiles.user_id
  // already stores the same value, but keeping this explicit makes
  // the contract obvious to callers.
  safe.id = userId;
  if (userEmail && safe.email == null) safe.email = userEmail;
  // Country comes from user_tier_state, not user_profiles (see top
  // comment of this handler). Overlay last so it always reflects the
  // separate-table value even if some legacy code path tried to
  // persist it on user_profiles.
  safe.country = country;
  safe.vat_number = vatNumber;
  // Boolean flags only — never the env-var values themselves. This is
  // what the Settings UI keys off to skip "please paste your key" for
  // providers the operator has wired up centrally (e.g. via Secret
  // Manager → BREVO_API_KEY style mounts).
  safe.server_keys = serverKeyAvailability();
  // Tier + resolved entitlements (authoritative tier_level_id from the
  // auth middleware, not the legacy user_profiles.tier string). We also
  // overlay the display `tier` string from the resolved tier label so
  // an out-of-band upgrade (UMP override) shows immediately — the
  // legacy user_profiles.tier column is never updated on those and so
  // would otherwise keep showing "Free".
  safe.tier = tierLabel;
  safe.tier_key = tierKey;
  safe.tier_level_id = tierLevelId;
  safe.entitlements = entitlements;
  res.json(safe);
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const allowed = [
    "display_name", "organisation", "tabular_model",
    "message_credits_used", "credits_reset_date",
    // Locale code (e.g. "en", "hr"). Validated below before persisting.
    "preferred_language",
    // Reasoning intensity for the main composer ("low" | "medium" |
    // "high"). Validated below; CHECK constraint in migration 113
    // would reject anything else but we'd rather drop early with a
    // clean log line than have pg raise a 23514.
    "reasoning_effort",
    // ISO-3166-1 alpha-2 country code (e.g. "HR", "DE"). Required to
    // pre-fill Stripe customer.address.country so automatic_tax can
    // resolve a tax location at checkout time. Lower-cased input is
    // accepted but normalised to upper-case before persistence.
    "country",
    // EU VAT registration number (e.g. "HR12345678901"). Passed to
    // Stripe customer.tax_id so invoices can show it and zero-rate
    // reverse-charge B2B sales. Empty string clears it.
    "vat_number",
    // PII Shield user defaults — see migration 120 + lib/pii/gate.ts.
    "pii_default_mode",
    "pii_review_required",
    "pii_disclosure_policy",
  ];
  const SUPPORTED_LOCALES = new Set(["en", "hr"]);
  const SUPPORTED_EFFORTS = new Set(["low", "medium", "high"]);
  const SUPPORTED_PII_MODES = new Set(["off", "standard", "strict_legal", "strict"]);
  const SUPPORTED_PII_DISCLOSURE = new Set(["allow", "deny", "ask"]);
  const updates: Record<string, any> = { updated_at: new Date().toISOString() };
  // BYOK was removed 2026-05 — Eulex Desk only ever uses server-level keys
  // (Secret Manager) so the rate limiter and cost forensics stay
  // authoritative. Any inbound api_key field is silently dropped by
  // the allowed-list above; we don't even surface a 403 because the
  // field name shouldn't exist in client code anymore.
  for (const key of allowed) {
    if (key in req.body) {
      let val = req.body[key];
      // Drop unknown locales silently — clients should never send them
      // but a typo shouldn't poison the column with a value we can't
      // load messages for.
      if (key === "preferred_language") {
        if (typeof val !== "string" || !SUPPORTED_LOCALES.has(val)) continue;
      }
      if (key === "reasoning_effort") {
        if (typeof val !== "string" || !SUPPORTED_EFFORTS.has(val)) continue;
      }
      if (key === "country") {
        // Empty string clears the field. Otherwise enforce ISO-3166-1
        // alpha-2: exactly two letters. Anything else is dropped (we
        // never want garbage in the column the Stripe checkout reads).
        if (val == null || val === "") {
          val = null;
        } else if (typeof val !== "string" || !/^[A-Za-z]{2}$/.test(val)) {
          continue;
        } else {
          val = val.toUpperCase();
        }
      }
      if (key === "pii_default_mode") {
        if (typeof val !== "string" || !SUPPORTED_PII_MODES.has(val)) continue;
      }
      if (key === "pii_disclosure_policy") {
        if (typeof val !== "string" || !SUPPORTED_PII_DISCLOSURE.has(val)) continue;
      }
      if (key === "pii_review_required") {
        // Accept boolean / "true" / "false" / 0 / 1 from forms.
        if (typeof val === "string") val = val === "true";
        if (typeof val === "number") val = val !== 0;
        if (typeof val !== "boolean") continue;
      }
      updates[key] = val;
    }
  }

  // Country lives on user_tier_state — see the matching note in the
  // GET handler. We split it out before the user_profiles update so
  // a single PATCH cleanly fans out to both tables (display name +
  // country in one round-trip from the UI). A failed country upsert
  // does *not* abort the user_profiles update — the rest of the patch
  // still gets persisted and the client sees the country attempt as a
  // 500 only if the country was the only field in the body.
  // country + vat_number live on user_tier_state, not user_profiles.
  const tierStateUpdates: { country?: string | null; vat_number?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(updates, "country")) {
    tierStateUpdates.country = updates.country as string | null;
    delete updates.country;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "vat_number")) {
    // Empty string clears the field.
    const raw = (updates.vat_number as string | null | undefined) ?? null;
    tierStateUpdates.vat_number = (typeof raw === "string" && raw.trim()) ? raw.trim() : null;
    delete updates.vat_number;
  }
  if (Object.keys(tierStateUpdates).length > 0) {
    try {
      const pool = await getPool();
      // One idempotent upsert per changed field — keeps the logic simple
      // and ensures "send null" always clears (not COALESCE-guarded).
      if ("country" in tierStateUpdates) {
        await pool.query(
          `INSERT INTO public.user_tier_state (user_id, country, active_tier_synced_at)
                VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET country = EXCLUDED.country`,
          [userId, tierStateUpdates.country ?? null],
        );
      }
      if ("vat_number" in tierStateUpdates) {
        await pool.query(
          `INSERT INTO public.user_tier_state (user_id, vat_number, active_tier_synced_at)
                VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET vat_number = EXCLUDED.vat_number`,
          [userId, tierStateUpdates.vat_number ?? null],
        );
      }
    } catch (err: any) {
      console.error("[user/profile] country/VAT upsert failed:", err.message);
      const onlyTierStateFields =
        Object.keys(updates).filter((k) => k !== "updated_at").length === 0;
      if (onlyTierStateFields) {
        return void res.status(500).json({ detail: err.message });
      }
    }
  }

  // Upsert: ensure profile row exists before update
  try {
    const pool = await getPool();
    const existing = await pool.query(
      'SELECT id FROM user_profiles WHERE user_id = $1',
      [userId],
    );
    if (existing.rows.length === 0) {
      await pool.query(
        'INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [userId],
      );
    }
  } catch (err: any) {
    return void res.status(500).json({ detail: err.message });
  }

  const { error } = await from("user_profiles")
    .update(updates)
    .eq("user_id", userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { error } = await from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id" },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// GET /user/rate-limit-status — frontend banner fallback when no
// in-flight request has populated the cached snapshot. Returns the
// rolling-24h numbers plus the user's tier and active credit balance.
// Always sets `RateLimit-*` headers so the same hook that listens to
// API replies picks this up too.
userRouter.get("/rate-limit-status", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const tierLevelId =
        typeof res.locals.tierLevelId === "number" ? res.locals.tierLevelId : 3;
    const tierSlug = (res.locals.tier as string | undefined) ?? null;
    try {
        const snap = await getRateLimitSnapshot(userId, tierLevelId, tierSlug);
        setRateLimitHeaders(res, snap);
        const percentUsed =
            snap.effectiveLimit > 0
                ? Math.min(1, snap.usedTokensWindow / snap.effectiveLimit)
                : 0;
        const state =
            snap.over
                ? "hard"
                : percentUsed >= SOFT_WARNING_THRESHOLD
                  ? "soft"
                  : "hidden";
        res.json({
            tier: { slug: snap.tier.slug, label: snap.tier.label },
            limit_tokens: snap.effectiveLimit,
            daily_tokens: snap.dailyTokens,
            bonus_tokens: snap.bonusRemaining,
            used_tokens: snap.usedTokensWindow,
            remaining_tokens: snap.remainingTokens,
            questions_in_window: snap.questionsInWindow,
            next_relief_at: snap.nextReliefAt?.toISOString() ?? null,
            percent_used: percentUsed,
            state,
            topup_available: snap.tier.slug === "eulex_plus",
        });
    } catch (err: any) {
        console.error("[user/rate-limit-status]", err);
        res.status(500).json({ detail: err?.message ?? "lookup failed" });
    }
});

// DELETE /user/account — GDPR Art. 17 erasure.
//
// Relational rows are removed by FK CASCADE on `users`, but three things the
// cascade can't do are handled first: (1) delete the user's files from GCS,
// (2) delete the Supabase auth user (identity lives in Supabase, data in Cloud
// SQL), and (3) strip the user's email from OTHER users' share lists.
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = (res.locals.userEmail as string | undefined)
    ?.trim()
    .toLowerCase();
  try {
    const pool = await getPool();

    // 1) Collect and delete storage objects (originals + converted PDFs, across
    // all document versions). Best-effort — deleteFile swallows not-found.
    const storageKeys = new Set<string>();
    const [docPaths, versionPaths] = await Promise.all([
      pool.query<{ storage_path: string | null; pdf_storage_path: string | null }>(
        `SELECT storage_path, pdf_storage_path FROM public.documents WHERE user_id = $1`,
        [userId],
      ),
      pool.query<{ storage_path: string | null; pdf_storage_path: string | null }>(
        `SELECT v.storage_path, v.pdf_storage_path
           FROM public.document_versions v
           JOIN public.documents d ON d.id = v.document_id
          WHERE d.user_id = $1`,
        [userId],
      ),
    ]);
    for (const row of [...docPaths.rows, ...versionPaths.rows]) {
      if (row.storage_path) storageKeys.add(row.storage_path);
      if (row.pdf_storage_path) storageKeys.add(row.pdf_storage_path);
    }
    await Promise.all([...storageKeys].map((key) => deleteFile(key)));

    // 2) Delete the Supabase auth user (read identity before the cascade
    // removes it). Best-effort: never block the erasure on an auth hiccup.
    if (isSupabaseAdminConfigured()) {
      const idRes = await pool.query<{ supabase_user_id: string }>(
        `SELECT supabase_user_id FROM public.user_supabase_identity WHERE user_id = $1`,
        [userId],
      );
      const supabaseUserId = idRes.rows[0]?.supabase_user_id;
      if (supabaseUserId) {
        try {
          await deleteSupabaseUser(supabaseUserId);
        } catch (authErr) {
          console.error("[user/account] supabase delete failed", safeErrorLog(authErr));
        }
      }
    }

    // 3) Remove this user's email from other users' share lists (the cascade
    // only touches rows the user OWNS).
    if (userEmail) {
      await Promise.all([
        pool.query(
          `UPDATE public.projects SET shared_with = shared_with - $1
            WHERE shared_with @> $2::jsonb`,
          [userEmail, JSON.stringify([userEmail])],
        ),
        pool.query(
          `UPDATE public.tabular_reviews SET shared_with = shared_with - $1
            WHERE shared_with @> $2::jsonb`,
          [userEmail, JSON.stringify([userEmail])],
        ),
        pool.query(
          `DELETE FROM public.workflow_shares WHERE shared_with_email = $1`,
          [userEmail],
        ),
        pool.query(
          `DELETE FROM public.chat_shares WHERE shared_with_email = $1`,
          [userEmail],
        ),
      ]);
    }

    // 4) Delete the user row — FK CASCADE clears everything they own.
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    res.status(204).send();
  } catch (err) {
    console.error("[user/account] delete failed", safeErrorLog(err));
    res.status(500).json({ detail: safeErrorMessage(err, "Account deletion failed") });
  }
});

// GET /user/export — GDPR Art. 20 portability. Returns a JSON snapshot of the
// user's own data (metadata only — no binary file contents, no PII secrets or
// encrypted mappings).
userRouter.get("/export", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  try {
    const ids = (rows: Array<{ id?: string }> | null | undefined): string[] =>
      (rows ?? []).map((r) => r.id).filter((v): v is string => typeof v === "string");

    const sel = (table: string) => from(table).select("*");

    // Top-level, owned by user_id.
    const [profile, tierState, projects, documents, chats, workflows, hiddenWorkflows, reviews, reviewChats] =
      await Promise.all([
        sel("user_profiles").eq("user_id", userId).maybeSingle(),
        sel("user_tier_state").eq("user_id", userId).maybeSingle(),
        sel("projects").eq("user_id", userId),
        sel("documents").eq("user_id", userId),
        sel("chats").eq("user_id", userId),
        sel("workflows").eq("user_id", userId),
        sel("hidden_workflows").eq("user_id", userId),
        sel("tabular_reviews").eq("user_id", userId),
        sel("tabular_review_chats").eq("user_id", userId),
      ]);

    const projectIds = ids(projects.data as any);
    const documentIds = ids(documents.data as any);
    const chatIds = ids(chats.data as any);
    const workflowIds = ids(workflows.data as any);
    const reviewIds = ids(reviews.data as any);
    const reviewChatIds = ids(reviewChats.data as any);

    // Children, fetched by parent ids (skip empty .in() lookups).
    const inOrEmpty = async (table: string, col: string, vals: string[]) =>
      vals.length ? (await sel(table).in(col, vals)).data ?? [] : [];

    const [
      subfolders,
      versions,
      edits,
      messages,
      workflowShares,
      cells,
      reviewChatMessages,
    ] = await Promise.all([
      inOrEmpty("project_subfolders", "project_id", projectIds),
      inOrEmpty("document_versions", "document_id", documentIds),
      inOrEmpty("document_edits", "document_id", documentIds),
      inOrEmpty("chat_messages", "chat_id", chatIds),
      inOrEmpty("workflow_shares", "workflow_id", workflowIds),
      inOrEmpty("tabular_cells", "review_id", reviewIds),
      inOrEmpty("tabular_review_chat_messages", "chat_id", reviewChatIds),
    ]);

    const exportedAt = new Date().toISOString();
    const payload = {
      meta: { user_id: userId, exported_at: exportedAt, format: "max-gdpr-export-v1" },
      profile: profile.data ?? null,
      tier_state: tierState.data ?? null,
      projects: projects.data ?? [],
      project_subfolders: subfolders,
      documents: documents.data ?? [],
      document_versions: versions,
      document_edits: edits,
      chats: chats.data ?? [],
      chat_messages: messages,
      workflows: workflows.data ?? [],
      hidden_workflows: hiddenWorkflows.data ?? [],
      workflow_shares: workflowShares,
      tabular_reviews: reviews.data ?? [],
      tabular_cells: cells,
      tabular_review_chats: reviewChats.data ?? [],
      tabular_review_chat_messages: reviewChatMessages,
    };

    const filename = `max-export-${userId}-${exportedAt.replace(/[:.]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[user/export] failed", safeErrorLog(err));
    res.status(500).json({ detail: safeErrorMessage(err, "Export failed") });
  }
});
