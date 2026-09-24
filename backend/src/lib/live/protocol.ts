/**
 * GPT-Live (gpt-live-1) — žični protokol. Finalna verzija (rujan 2026).
 *
 * Namjerno odvojeno od Realtime puta (routes/realtime.ts, POST /realtime/session):
 * GPT-Live NIJE nova verzija Realtime API-ja nego drugi ugovor.
 *
 *  1. NEMA ephemeral client_secreta. Sesiju otvara backend razmjenom SDP-a
 *     (POST /v1/live/sessions {session, transport:{type:'webrtc', sdp}} →
 *     {session:{id}, transport:{sdp}}). Aplikacija ne drži NIKAKAV OpenAI kredencijal.
 *  2. Živi model NEMA alate. Rad ide kroz delegaciju: `client` (naš backend,
 *     lib/live/delegation.ts) ili `responses` (OpenAI vrti backend model; function
 *     pozive izvršava aplikacija preko POST /realtime/live/tool).
 *  3. `instructions` su nepromjenjive (≤ 16 384 tokena); `session.update` prima samo
 *     `delegation.responses`. Dopisi (instructions/thinking/commentary.append) ≤ 500 tokena.
 *  4. Nema `turn_detection` ni `response.create` za govor — full-duplex. Kontekst se
 *     komprimira automatski (128k prozor, zamjena engine-a iznad 90 %) — nema
 *     konfiguracije za to; polje `context_management` iz alphe je UKLONJENO i GA ga
 *     odbija kao nepoznato.
 *
 * Promjene prema alphi (v3 "quicksilver"): model `gpt-live-1` umjesto
 * `gpt-live-1-diamond-alpha`; header `OpenAI-Alpha` više ne treba; 22 ugrađena glasa
 * (BUILT_IN_VOICES) + vlastiti glas kao `{id}`; novi startup blok `client.data_channel`
 * kojim se NEPOUZDANOM frontendu (telefon) ograničava koje događaje smije slati;
 * sideband `GET /v1/live/sessions/{id}/attach` je GA; naplata po sekundi govora.
 * Izvor istine: openai SDK 7.15 `resources/live/live.d.ts` + docs/guides/live*.
 */

const DEFAULT_LIVE_MODEL = "gpt-live-1";
// Terra je preporučeni backend; Luna (gpt-5.6-luna) za cjenovno osjetljive puteve.
const DEFAULT_BACKEND_MODEL = "gpt-5.6-terra";
/** Alpha je tražila `OpenAI-Alpha: quicksilver=v3`; GA ga ne treba. Ostaje kao
 *  opt-in (LIVE_ALPHA_HEADER=quicksilver=v3) samo za projekt koji je još na alphi. */
export const liveAlphaHeader = (env: NodeJS.ProcessEnv = process.env): string | null =>
    (env.LIVE_ALPHA_HEADER ?? "").trim() || null;
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/live/sessions";

export const liveModel = (): string => process.env.LIVE_MODEL || DEFAULT_LIVE_MODEL;
export const liveBackendModel = (): string =>
    process.env.LIVE_BACKEND_MODEL || DEFAULT_BACKEND_MODEL;
export const liveEndpoint = (): string => process.env.LIVE_ENDPOINT || DEFAULT_ENDPOINT;

/** Kratka oznaka za ekran aplikacije (prikazuje se umjesto statičnog taga). */
export const liveLabel = (): string => `${liveModel().replace(/-diamond-alpha$/, "")} · eulex`;

// ── Voices ───────────────────────────────────────────────────────────────────
/** Ugrađeni glasovi GPT-Live (SDK 7.15 `BuiltInVoice`). Zadano `marin`; nepromjenjivo
 *  nakon starta. Vlastiti (kloniran) glas ide kao objekt `{ id: "voice_…" }`. */
export const BUILT_IN_VOICES = [
    "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo",
    "gleam", "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo",
    "verse", "vesper", "willow",
] as const;
export type LiveVoice = string | { id: string };

/** Env → vrijednost za `audio.output.voice`. `voice_…` = vlastiti glas (objekt);
 *  ugrađeno ime prolazi kao string; nepoznato ime se logira i pada na `marin`
 *  (GA odbija nepoznat glas i time OTVARANJE sesije, ne samo glas). */
export function liveVoice(env: NodeJS.ProcessEnv = process.env): LiveVoice {
    const raw = (env.LIVE_VOICE || env.REALTIME_VOICE || "marin").trim();
    if (/^voice_[A-Za-z0-9_-]+$/.test(raw)) return { id: raw };
    if ((BUILT_IN_VOICES as readonly string[]).includes(raw)) return raw;
    console.warn(`[live] unknown voice "${raw}", falling back to marin`);
    return "marin";
}

// ── Frontend data-channel permissions ────────────────────────────────────────
// GA: `client.data_channel.allowed_client_events` ograničava što NEPOUZDANI frontend
// (telefon) smije poslati sesiji. Sideband/backend nije ograničen. Aplikacija u
// client modu šalje samo dopise, mute/unmute i close; u responses modu još i
// function rezultate. Sve ostalo (session.update, session.start, audio append)
// telefon nikad ne treba, pa se ni ne dopušta. LIVE_DATA_CHANNEL_ALLOWLIST=false gasi.
export function frontendClientEvents(mode: LiveDelegationMode): string[] {
    const base = [
        "session.instructions.append", "session.thinking.append", "session.commentary.append",
        "session.input_audio.mute", "session.input_audio.unmute", "session.close",
    ];
    return mode === "responses" ? [...base, "response.item.create", "response.create"] : base;
}
export const dataChannelAllowlistEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
    !/^(false|0)$/i.test((env.LIVE_DATA_CHANNEL_ALLOWLIST ?? "").trim());

export type LiveTransport = "live" | "realtime";

/**
 * Tko je backend agent (uzor: "Her and Him", backend/src/live/start.js):
 *  • `client` (zadano) — MI smo agent. Živi model emitira samo metapodatak
 *    delegacije; aplikacija nam pošalje transkript, mi vrtimo Responses model
 *    s EULEX alatima OVDJE i streamamo rečenice natrag (session.commentary.append)
 *    dok razgovor teče. Nema skoka natrag u aplikaciju po svaki poziv alata.
 *  • `responses` — OpenAI vrti backend model; function pozive izvršava
 *    aplikacija preko POST /realtime/live/tool (stariji put, ostaje kao rezerva).
 * Mod se bira pri otvaranju sesije i ne mijenja se tijekom nje.
 */
export type LiveDelegationMode = "client" | "responses";
export const liveDelegationMode = (env: NodeJS.ProcessEnv = process.env): LiveDelegationMode =>
    (env.LIVE_DELEGATION ?? "").trim().toLowerCase() === "responses" ? "responses" : "client";

export const clientDelegation = (): { type: "client" } => ({ type: "client" });

/**
 * Canary: `LIVE_ENABLED=true` uključuje gpt-live za sve, `LIVE_USERS=<a,b>`
 * samo za navedene korisnike — svaka stavka je interni user id ILI e-mail
 * (case-insensitive). Bez OPENAI_API_KEY nema ni jednog ni drugog.
 */
export function liveTransportFor(
    userId: string,
    env: NodeJS.ProcessEnv = process.env,
    email?: string | null,
): LiveTransport {
    if (!env.OPENAI_API_KEY) return "realtime";
    if (/^(true|1)$/i.test((env.LIVE_ENABLED ?? "").trim())) return "live";
    const users = (env.LIVE_USERS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    if (users.includes(userId.toLowerCase())) return "live";
    const mail = (email ?? "").trim().toLowerCase();
    return mail && users.includes(mail) ? "live" : "realtime";
}

// ── Session configuration ────────────────────────────────────────────────────
// Konfiguracija je STROGI objekt: nepoznata polja se odbijaju, pa se ništa ne
// prosljeđuje "za svaki slučaj". `audio.format` se NE šalje za WebRTC (format
// se dogovara kroz SDP).

/** Responses function tool — ravni oblik Responses API-ja (ne Chat Completions). */
export type LiveFunctionTool = {
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: false;
};

/** Jedini hosted alat koji delegacija prihvaća (uz `function`). */
export type LiveHostedTool = { type: "web_search" };

export type ResponsesDelegation = {
    type: "responses";
    responses: {
        model: string;
        instructions?: string;
        tools: Array<LiveFunctionTool | LiveHostedTool>;
        tool_choice: "auto" | "required" | "none";
        parallel_tool_calls?: boolean;
        reasoning?: { effort: string };
        max_output_tokens?: number;
    };
};

/** Strogi objekt (GA `MediaSessionConfig`): model, instructions, audio, delegation,
 *  input, store, client. Ništa drugo — nepoznato polje ruši otvaranje sesije. */
export type LiveSessionConfig = {
    model: string;
    instructions?: string;
    audio?: { output: { voice: LiveVoice } };
    delegation: ResponsesDelegation | { type: "client" };
    client?: { data_channel: { allowed_client_events: "all" | string[] } };
};

export function responsesDelegation(opts: {
    model?: string;
    instructions?: string;
    tools?: Array<LiveFunctionTool | LiveHostedTool>;
    toolChoice?: "auto" | "required" | "none";
    parallelToolCalls?: boolean;
    reasoningEffort?: string | null;
    maxOutputTokens?: number;
}): ResponsesDelegation {
    const responses: ResponsesDelegation["responses"] = {
        model: opts.model ?? liveBackendModel(),
        tools: opts.tools ?? [],
        tool_choice: opts.toolChoice ?? "auto",
    };
    if (opts.instructions) responses.instructions = opts.instructions;
    if (typeof opts.parallelToolCalls === "boolean") {
        responses.parallel_tool_calls = opts.parallelToolCalls;
    }
    // Zadano "low": glasovni razgovor čeka; env LIVE_BACKEND_REASONING_EFFORT
    // preklapa (npr. "medium"), "none" izostavlja polje.
    const effort = opts.reasoningEffort === undefined ? "low" : opts.reasoningEffort;
    if (effort && effort !== "none") responses.reasoning = { effort };
    if (Number.isInteger(opts.maxOutputTokens) && (opts.maxOutputTokens as number) >= 16) {
        responses.max_output_tokens = opts.maxOutputTokens;
    }
    return { type: "responses", responses };
}

export function buildLiveSessionConfig(opts: {
    model?: string;
    instructions?: string;
    voice?: LiveVoice;
    delegation?: LiveSessionConfig["delegation"];
    /** Dopušteni klijentski događaji za frontend data channel; izostavljeno = sve. */
    allowedClientEvents?: string[];
}): LiveSessionConfig {
    const session: LiveSessionConfig = {
        model: opts.model ?? liveModel(),
        delegation: opts.delegation ?? { type: "client" },
    };
    if (opts.instructions) session.instructions = opts.instructions;
    if (opts.voice) session.audio = { output: { voice: opts.voice } };
    if (opts.allowedClientEvents) {
        session.client = { data_channel: { allowed_client_events: opts.allowedClientEvents } };
    }
    return session;
}

/** Startup instructions imaju tvrdi cap (16 384 tokena); gruba procjena chars/4. */
export const INSTRUCTIONS_TOKEN_CAP = 16_384;
export function assertInstructionsFit(instructions: string): number {
    const tokens = Math.ceil(instructions.length / 4);
    if (tokens > INSTRUCTIONS_TOKEN_CAP) {
        throw new Error(`live_instructions_too_long:${tokens}`);
    }
    return tokens;
}

// ── Tool helpers (čisti, testabilni) ─────────────────────────────────────────

/** OpenAI function name: ^[a-zA-Z0-9_-]{1,64}$ — MCP imena mogu odstupati. */
export function functionName(mcpName: string): string {
    const safe = mcpName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return safe || "tool";
}

export function toFunctionTool(t: {
    name: string;
    description?: string;
    inputSchema?: unknown;
}): LiveFunctionTool {
    return {
        type: "function",
        name: functionName(t.name),
        description: (t.description ?? "").trim().slice(0, 1024),
        parameters: (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
        },
        strict: false,
    };
}

/**
 * Puferirani function outputi i zadržani backend input dijele limit od
 * 32 768 bajtova serijaliziranog JSON-a. Jedan EUR-Lex rezultat lako to
 * prijeđe, pa se output reže — po mogućnosti na granici JSON stavke/rečenice.
 */
export const TOOL_OUTPUT_MAX_CHARS = Number(process.env.LIVE_TOOL_OUTPUT_MAX_CHARS ?? 6_000);

export function boundToolOutput(text: string, limit = TOOL_OUTPUT_MAX_CHARS): string {
    const value = String(text ?? "");
    if (value.length <= limit) return value;
    const head = value.slice(0, limit);
    const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "), head.lastIndexOf("},"));
    const kept = cut > limit * 0.5 ? head.slice(0, cut + 1) : head;
    return `${kept}\n…[truncated: ${value.length - kept.length} more characters; refine the query for detail]`;
}

export type LiveSourceLabel = {
    label: string;
    title: string;
    citation: string | null;
    url: string | null;
    article: string | null;
    /** Kratki isječak odredbe (≤ 300 znakova) — dokaz za tiho znanje živog modela. */
    snippet?: string | null;
};

/** Izvori za transkript u aplikaciji — kratka oznaka + detalji za kasniji link. */
export function sourceLabels(
    sources: Array<{
        title?: string | null;
        citation?: string | null;
        externalUrl?: string | null;
        articleLabel?: string | null;
        snippet?: string | null;
    }>,
    max = 5,
): LiveSourceLabel[] {
    const out: LiveSourceLabel[] = [];
    const seen = new Set<string>();
    for (const s of sources) {
        const title = (s.title ?? "").trim();
        if (!title) continue;
        // EULEX naslovi već nose "…, čl. 34 — Naslov članka"; articleLabel zna
        // biti "Članak 34." — normaliziramo na broj i ne dupliramo ga u oznaci.
        const article = s.articleLabel?.trim().replace(/^(članak|article|čl\.?|art\.?)\s*/i, "").replace(/\.$/, "") || null;
        const shortTitle = title.split(/\s+[—–-]\s+/)[0].trim();
        const hasArticle = article !== null && new RegExp(`(čl\\.|članak|art\\.|article)\\s*${article.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "i").test(shortTitle);
        const label = (article && !hasArticle ? `${shortTitle}, čl. ${article}` : shortTitle).slice(0, 80);
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({
            label,
            title,
            citation: s.citation?.trim() || null,
            url: s.externalUrl?.trim() || null,
            article,
            snippet: s.snippet ? s.snippet.replace(/\s+/g, " ").trim().slice(0, 300) || null : null,
        });
        if (out.length >= max) break;
    }
    return out;
}

// ── Session creation (WebRTC) ────────────────────────────────────────────────

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,240}$/;

export type CreatedLiveSession = {
    sessionId: string;
    answerSdp: string;
    requestId: string | null;
};

/**
 * Razmjena SDP-a: klijentov offer ide kroz nas OpenAI-u, answer natrag klijentu.
 * ID sesije je NEPROZIRAN (prefiks live_/rtc_ se mijenja tijekom rolloauta).
 * HTTP greška NIJE `session.started` — pozivatelj je mora tretirati zasebno.
 */
export async function createWebrtcLiveSession(opts: {
    session: LiveSessionConfig;
    sdp: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
}): Promise<CreatedLiveSession> {
    const { session, sdp } = opts;
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for a live session");
    if (typeof sdp !== "string" || sdp.length < 32 || sdp.length > 1_000_000) {
        const err = new Error("invalid_sdp_offer") as Error & { status?: number };
        err.status = 400;
        throw err;
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const resp = await doFetch(liveEndpoint(), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(liveAlphaHeader() ? { "OpenAI-Alpha": liveAlphaHeader() as string } : {}),
        },
        body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
        signal: AbortSignal.timeout(20_000),
    });
    const body = await resp.text();
    if (resp.status !== 201 && resp.status !== 200) {
        const err = new Error(`live sessions ${resp.status}: ${body.slice(0, 400)}`) as Error & {
            status?: number;
        };
        err.status = resp.status;
        throw err;
    }
    let created: { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    try {
        created = JSON.parse(body);
    } catch {
        throw new Error("live sessions returned invalid JSON");
    }
    const sessionId = created?.session?.id;
    const answerSdp = created?.transport?.sdp;
    if (
        typeof sessionId !== "string" ||
        !OPAQUE_ID.test(sessionId) ||
        created?.transport?.type !== "webrtc" ||
        typeof answerSdp !== "string" ||
        !answerSdp
    ) {
        throw new Error("live sessions returned no WebRTC session id or SDP answer");
    }
    return { sessionId, answerSdp, requestId: resp.headers.get("x-request-id") };
}

// ── Context appends ──────────────────────────────────────────────────────────
// Dopisi (instructions/thinking/commentary.append) smiju imati najviše 500 tokena.
// Hrvatski se tokenizira na ~2.6–3 znaka po tokenu (ne 4 kao engleski) — Her je
// 5.9. dobila "Context append text must not exceed 500 tokens" na 1700 znakova.
// Zato 2.6 znaka/token bez rezerve: 1300 znakova; dulje ide kroz splitAppendContent.

export const APPEND_TOKEN_LIMIT = 500;
export const APPEND_CHAR_LIMIT = Math.floor(APPEND_TOKEN_LIMIT * 2.6);

/** Jedan dopis ≤ limit; reže se na granici rečenice kad je moguće — odsječena
 *  polovica rečenice u rezoniranju je gore od kraćeg dopisa. */
export function boundAppendContent(text: string, limit = APPEND_CHAR_LIMIT): string {
    const value = String(text ?? "").replace(/\s+\n/g, "\n").trim();
    if (value.length <= limit) return value;
    const head = value.slice(0, limit);
    const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf("; "));
    return (cut > limit * 0.5 ? head.slice(0, cut + 1) : head).trim();
}

/** Dulji tekst → više dopisa; redoslijed se čuva, svaki dio je samostalno ≤ limit. */
export function splitAppendContent(text: string, limit = APPEND_CHAR_LIMIT): string[] {
    const value = String(text ?? "").trim();
    if (!value) return [];
    const parts: string[] = [];
    let rest = value;
    while (rest.length > limit) {
        const head = rest.slice(0, limit);
        const cut = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
        const at = cut > limit * 0.5 ? cut + 1 : limit;
        parts.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
    }
    if (rest) parts.push(rest);
    return parts.filter(Boolean);
}

// ── Progress narration ───────────────────────────────────────────────────────
// Živi model šuti dok backend model radi; jedino što aplikacija zna prije
// konačnog odgovora su pozivi alata i njihovi rezultati. Iz njih se složi kratka
// napomena koju aplikacija pošalje kao `session.commentary.append`
// (delegation_id: null — provjereno da radi i u Responses delegaciji) pa model
// naglas kaže koji propis gleda. Bez pravnih zaključaka — odgovor tek dolazi.

const SEARCH_TOOLS = new Set(["search", "case_law_search", "find_publication", "resolve", "eu_transposition"]);

export type ProgressHint = {
    /** Uputa za naglas (session.commentary.append): koji se propis gleda. */
    text: string;
    key: string;
    /** Gola činjenica za tiho znanje (session.thinking.append) u client delegaciji. */
    silent: string;
};

/** Naziv propisa iz EULEX oznake ("Zakon o radu, čl. 7" → "Zakon o radu"). */
export function lawName(label: string): string {
    return label.split(/,\s*čl\./)[0].split(/\s+[—–]\s+/)[0].trim();
}

export function progressHint(opts: {
    tool: string;
    args: Record<string, unknown>;
    sources: Array<{ label: string }>;
}): ProgressHint | null {
    const laws: string[] = [];
    for (const s of opts.sources) {
        const name = lawName(s.label);
        if (name && !laws.includes(name)) laws.push(name);
        if (laws.length >= 3) break;
    }
    const isSearch = SEARCH_TOOLS.has(opts.tool);
    if (laws.length === 0 && !isSearch) return null;
    const query = typeof opts.args.query === "string" ? opts.args.query.trim().slice(0, 120) : "";
    const lawList = laws.length > 0 ? laws.join("; ") : "the EU and Croatian legal databases";
    const text = isSearch
        ? `Progress from the legal research, still in progress: it is looking into ${lawList}`
          + (query ? ` regarding "${query}"` : "")
          + ". In one short sentence, in your own words, tell the user which law or regulation you are checking and that you are now reading the exact provision. Do not state any deadline, article number, amount or legal conclusion yet — the verified answer is still coming."
        : `Progress from the legal research, still in progress: it is now reading ${lawList}. Only if you have not already said so, mention in a few words which regulation you are reading; otherwise say nothing. No deadline, article number, amount or legal conclusion yet — the verified answer is still coming.`;
    const silent = `Still working: ${isSearch ? "searching" : "reading"} ${lawList}`
        + (query ? ` regarding "${query}"` : "")
        + ". No verified result yet; do not state an article number, deadline, amount or conclusion from this.";
    return {
        text: boundAppendContentForLive(text),
        key: laws.length > 0 ? laws.join("|") : `search:${query}`,
        silent: boundAppendContentForLive(silent),
    };
}

/** Dopisi su ograničeni na 500 tokena (~1800 znakova s rezervom). */
export function boundAppendContentForLive(text: string, limit = 1_800): string {
    const value = text.replace(/\s+/g, " ").trim();
    return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
