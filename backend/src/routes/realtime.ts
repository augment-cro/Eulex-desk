import { Router, type Request, type Response } from "express";

import { requireAuth } from "../middleware/auth";
import { tierKeyForLevelId } from "../lib/entitlements";
import { mintEulexPartnerToken, type EulexPartnerTier } from "../lib/mcp/partnerJwt";
import { realtimeInstructions } from "../lib/realtimePrompt";
import { callEulexTool, listEulexFunctionTools } from "../lib/live/eulexTools";
import { runLiveDelegation, type LiveDelegateEvent, type TranscriptTurn } from "../lib/live/delegation";
import { liveBackendInstructions, liveInstructions } from "../lib/live/livePrompt";
import {
    assertInstructionsFit,
    buildLiveSessionConfig,
    clientDelegation,
    createWebrtcLiveSession,
    dataChannelAllowlistEnabled,
    frontendClientEvents,
    liveBackendModel,
    liveDelegationMode,
    liveLabel,
    liveModel,
    liveTransportFor,
    liveVoice,
    responsesDelegation,
} from "../lib/live/protocol";

/**
 * Live glasovni razgovor (mobilna aplikacija) — mint ephemeral ključa za
 * OpenAI Realtime API (GA: POST /v1/realtime/client_secrets). Pravi
 * OPENAI_API_KEY nikad ne napušta server; klijent dobiva kratkotrajni
 * `value` i njime otvara WebRTC vezu na /v1/realtime/calls.
 *
 * Model je namjerno u env varijabli (REALTIME_MODEL) — prelazak na novi
 * model (npr. budući gpt-live-*) je promjena konfiguracije, bez novog
 * buildanja aplikacije.
 *
 * Sesiji se prilaže EULEX MCP server (isti partner JWT kao chat builtin
 * konektor), pa realtime model može pretraživati EUR-Lex uživo; klijent
 * iz MCP eventa na data channelu gradi transkript s izvorima.
 *
 * ── gpt-live-1 (GPT-Live, finalna verzija) ──────────────────────────────
 * Drugi ugovor, gejtan canaryjem (LIVE_ENABLED / LIVE_USERS), Realtime ostaje
 * default. Aplikacija najprije pita GET /realtime/transport; na "live" složi
 * WebRTC offer i pošalje ga na POST /realtime/live/session — backend otvori
 * sesiju projektnim ključem i vrati SDP answer (aplikacija NE dobiva nikakav
 * OpenAI kredencijal). Živi model nema alate. Dva moda (env LIVE_DELEGATION):
 *  • client (zadano, uzor "Her and Him"): na `session.delegation.created`
 *    aplikacija pošalje transkript na POST /realtime/live/delegate; backend
 *    vrti Responses model s EULEX alatima OVDJE i streama (SSE) rečenice
 *    odgovora čim su cijele, a aplikacija ih dopisuje sesiji
 *    (session.commentary.append) — razgovor teče, odgovor se u pozadini traži
 *    i onda samo nastavi. Detalji: lib/live/delegation.ts.
 *  • responses: EULEX baze idu kroz Responses delegaciju kao function
 *    definicije, a pozive izvršava aplikacija preko POST /realtime/live/tool.
 * Detalji ugovora: lib/live/protocol.ts.
 */
export const realtimeRouter = Router();

/** Tier za EULEX partner token — isti izračun kao builtin konektor u chatu. */
function eulexTierFor(res: Response): EulexPartnerTier {
    const level = res.locals.tierLevelId;
    return typeof level === "number" && tierKeyForLevelId(level) === "free" ? "free" : "plus";
}

/** Koji glasovni put vrijedi za ovog korisnika. Aplikacija ovo pita prije
 *  spajanja jer live put treba SDP offer prije ikakvog poziva sesije. */
realtimeRouter.get("/transport", requireAuth, (_req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    const transport = liveTransportFor(userId, process.env, res.locals.userEmail as string | undefined);
    res.json({
        transport,
        model: transport === "live" ? liveModel() : process.env.REALTIME_MODEL || "gpt-realtime-2.1",
        backend_model: transport === "live" ? liveBackendModel() : null,
    });
});

/**
 * gpt-live-1: razmjena SDP-a. Body: { sdp, language }. Vraća { sdp, session_id,
 * model, backend_model, label, tools }. HTTP greška NIJE session.started —
 * aplikacija tada pada natrag na Realtime put.
 */
realtimeRouter.post("/live/session", requireAuth, async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    if (liveTransportFor(userId, process.env, res.locals.userEmail as string | undefined) !== "live") {
        res.status(404).json({ detail: "gpt-live is not enabled for this user" });
        return;
    }
    const sdp = req.body?.sdp;
    if (typeof sdp !== "string" || sdp.length < 32 || sdp.length > 1_000_000) {
        res.status(400).json({ detail: "invalid_sdp_offer" });
        return;
    }
    const language = req.body?.language === "en" ? "en" : "hr";
    const tier = eulexTierFor(res);
    const mode = liveDelegationMode();

    // Alati za backend model: EULEX MCP kao function definicije. U Responses
    // modu ih izvršava aplikacija (hosted `mcp` alat delegacija odbija); u client
    // modu ih listamo tek pri delegaciji, a ovdje samo grijemo keš popisa.
    let tools: Parameters<typeof responsesDelegation>[0]["tools"] = [];
    if (mode === "responses") {
        try {
            tools = await listEulexFunctionTools(userId, tier);
        } catch (err) {
            // Fail-soft kao na Realtime putu: razgovor radi i bez pravnih alata,
            // ali to se mora vidjeti u logu jer je cijeli smisao live puta upravo
            // u EULEX bazama.
            console.error("[realtime/live/session] EULEX tools unavailable:", err);
        }
    } else {
        void listEulexFunctionTools(userId, tier).catch((err) =>
            console.error("[realtime/live/session] EULEX tool list warm-up failed:", err),
        );
    }

    const instructions = liveInstructions(language, mode);
    let instructionTokens = 0;
    try {
        instructionTokens = assertInstructionsFit(instructions);
    } catch (err) {
        console.error("[realtime/live/session]", err);
        res.status(500).json({ detail: "live instructions too long" });
        return;
    }

    const session = buildLiveSessionConfig({
        model: liveModel(),
        instructions,
        voice: liveVoice(),
        // Telefon je nepouzdan frontend: smije slati samo ono što aplikacija stvarno
        // koristi (dopisi, mute, close; u responses modu i function rezultate).
        allowedClientEvents: dataChannelAllowlistEnabled() ? frontendClientEvents(mode) : undefined,
        delegation: mode === "client"
            ? clientDelegation()
            : responsesDelegation({
                  model: liveBackendModel(),
                  instructions: liveBackendInstructions(language, "responses"),
                  tools,
                  toolChoice: "auto",
                  parallelToolCalls: true,
                  reasoningEffort: process.env.LIVE_BACKEND_REASONING_EFFORT || undefined,
              }),
    });

    try {
        const created = await createWebrtcLiveSession({ session, sdp });
        console.log(
            JSON.stringify({
                metric: "live_session_started",
                user: userId,
                session: created.sessionId,
                model: session.model,
                backend_model: liveBackendModel(),
                delegation: mode,
                voice: typeof session.audio?.output.voice === "string" ? session.audio.output.voice : "custom",
                tools: tools.length,
                instruction_tokens: instructionTokens,
                request_id: created.requestId,
            }),
        );
        res.json({
            transport: "live",
            sdp: created.answerSdp,
            session_id: created.sessionId,
            model: session.model,
            backend_model: liveBackendModel(),
            delegation: mode,
            label: liveLabel(),
            tools: tools.length,
        });
    } catch (err) {
        const status = (err as { status?: number }).status;
        console.error("[realtime/live/session] failed:", err);
        res.status(status && status < 500 ? status : 502).json({ detail: "Live session failed" });
    }
});

const TRANSCRIPT_MAX_TURNS = 40;
const TRANSCRIPT_MAX_CHARS = 4_000;

function readTranscript(raw: unknown): TranscriptTurn[] {
    if (!Array.isArray(raw)) return [];
    const out: TranscriptTurn[] = [];
    for (const item of raw.slice(-TRANSCRIPT_MAX_TURNS)) {
        const role = (item as { role?: unknown })?.role;
        const text = (item as { text?: unknown })?.text;
        if ((role !== "user" && role !== "assistant") || typeof text !== "string") continue;
        const trimmed = text.trim().slice(0, TRANSCRIPT_MAX_CHARS);
        if (trimmed) out.push({ role, text: trimmed });
    }
    return out;
}

/**
 * gpt-live-1, client delegacija: aplikacija je dirigent. Na
 * `session.delegation.created` pošalje transkript ovamo; backend u pozadini
 * traži odgovor (Responses model + EULEX alati, izvršeni ovdje) i STREAMA ga
 * kao SSE: `progress`, `evidence`, `spoken` (cijela rečenica čim je gotova),
 * `silent`, `done` | `error`, pa `[DONE]`. Aplikacija svaki događaj samo
 * prevede u dopis sesiji (commentary/thinking.append s delegation_id).
 * Body: { delegation_id?, request_id?, language, utterance?, transcript:[{role,text}] }.
 * Prekid veze (korisnik ispravio pitanje) prekida i posao.
 */
realtimeRouter.post("/live/delegate", requireAuth, async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    if (liveTransportFor(userId, process.env, res.locals.userEmail as string | undefined) !== "live") {
        res.status(404).json({ detail: "gpt-live is not enabled for this user" });
        return;
    }
    const transcript = readTranscript(req.body?.transcript);
    const utterance = typeof req.body?.utterance === "string" ? req.body.utterance.slice(0, TRANSCRIPT_MAX_CHARS) : "";
    if (transcript.length === 0 && !utterance.trim()) {
        res.status(400).json({ detail: "transcript or utterance required" });
        return;
    }
    const delegationId = typeof req.body?.delegation_id === "string" ? req.body.delegation_id.slice(0, 240) : null;
    const requestId = typeof req.body?.request_id === "string" ? req.body.request_id.slice(0, 120) : null;
    const language = req.body?.language === "en" ? "en" : "hr";

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const controller = new AbortController();
    res.on("close", () => controller.abort());
    const emit = (event: LiveDelegateEvent) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
        await runLiveDelegation({
            userId, tier: eulexTierFor(res), language, transcript, utterance,
            delegationId, requestId, signal: controller.signal, emit,
        });
    } catch (err) {
        if (!controller.signal.aborted) {
            console.error("[realtime/live/delegate] failed:", err);
            emit({ type: "error", message: "legal research failed" });
        }
    } finally {
        if (!res.writableEnded && !res.destroyed) {
            res.write("data: [DONE]\n\n");
            res.end();
        }
    }
});

/**
 * gpt-live-1: izvršavanje jednog function poziva iz Responses delegacije.
 * Body: { name, arguments } (arguments = JSON string kako ga model šalje).
 * Vraća { output, sources[] } — output ide natrag u sesiju kao
 * function_call_output, sources u transkript aplikacije.
 */
realtimeRouter.post("/live/tool", requireAuth, async (req: Request, res: Response) => {
    const userId = res.locals.userId as string;
    if (liveTransportFor(userId, process.env, res.locals.userEmail as string | undefined) !== "live") {
        res.status(404).json({ detail: "gpt-live is not enabled for this user" });
        return;
    }
    const name = req.body?.name;
    if (typeof name !== "string" || !name || name.length > 128) {
        res.status(400).json({ detail: "tool name required" });
        return;
    }
    const startedAt = Date.now();
    try {
        const result = await callEulexTool(userId, eulexTierFor(res), name, req.body?.arguments);
        console.log(
            JSON.stringify({
                metric: "live_tool_call",
                user: userId,
                tool: result.tool,
                ms: Date.now() - startedAt,
                output_chars: result.output.length,
                sources: result.sources.length,
            }),
        );
        res.json({ output: result.output, sources: result.sources, tool: result.tool, progress: result.progress });
    } catch (err) {
        console.error("[realtime/live/tool] failed:", err);
        // Greška ide modelu kao tekst — sesija ne smije stati na jednom alatu.
        res.json({ output: JSON.stringify({ error: "legal database lookup failed" }), sources: [], tool: name, progress: null });
    }
});

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const EULEX_MCP_URL = "https://mcp.eulex.ai/mcp";

realtimeRouter.post("/session", requireAuth, async (req: Request, res: Response) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        res.status(503).json({ detail: "Realtime is not configured (OPENAI_API_KEY missing)" });
        return;
    }

    const userId = res.locals.userId as string;
    const language = req.body?.language === "en" ? "en" : "hr";
    const model = process.env.REALTIME_MODEL || "gpt-realtime-2.1";

    // EULEX MCP kao realtime tool — fail-soft: bez tokena sesija ide bez alata.
    const tools: unknown[] = [];
    try {
        const token = mintEulexPartnerToken(userId);
        if (token) {
            tools.push({
                type: "mcp",
                server_label: "eulex",
                server_url: EULEX_MCP_URL,
                authorization: token,
                require_approval: "never",
            });
        }
    } catch {
        /* bez MCP alata — razgovor i dalje radi */
    }

    const session = {
        type: "realtime",
        model,
        instructions: realtimeInstructions(language),
        // Preporuka za produkcijske voice agente (Realtime 2.x): nizak
        // reasoning effort — manje skrivenih tokena prije prvog izgovora.
        reasoning: {
            effort: process.env.REALTIME_REASONING_EFFORT || "medium",
        },
        audio: {
            input: {
                transcription: {
                    model: process.env.REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
                },
            },
            output: { voice: process.env.REALTIME_VOICE || "marin" },
        },
        ...(tools.length > 0 ? { tools } : {}),
    };

    try {
        const upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ session }),
        });
        if (!upstream.ok) {
            const detail = await upstream.text();
            console.error("[realtime/session] client_secrets failed:", upstream.status, detail);
            res.status(502).json({ detail: "Realtime session mint failed" });
            return;
        }
        const data = (await upstream.json()) as { value?: string; expires_at?: number };
        res.json({ value: data.value, expires_at: data.expires_at ?? null, model });
    } catch (err) {
        console.error("[realtime/session] error:", err);
        res.status(502).json({ detail: "Realtime session mint failed" });
    }
});
