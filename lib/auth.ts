import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getIronSession, webCookies, type SessionOptions } from "iron-session";
import { ApiError, botGuilds, boundedJson } from "./api-security.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

export type AuthConfig = { clientId: string; clientSecret: string; origin: string; password: string; secure: boolean };
type Flow = { state: string; verifier: string; expiresAt: number };
type Session = { accessToken: string; expiresAt: number };
export type Identity = { id: string; username: string; name: string };
export type Guild = { id: string; name: string; canModerate?: boolean };
export type Dependencies = { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: () => number; limit?: (key: string) => Promise<boolean> | boolean; discordScope?: object };
export const sessionName = "profile_session";
const flowName = "profile_oauth";
const discordTimeoutMs = 8000;
type DiscordWork<T> = { promise: Promise<T>; waiters: number; settled: boolean; cancel: (reason: unknown) => void };
type DiscordState = { pending: Map<string, DiscordWork<unknown>>; contexts: Map<string, DiscordWork<{ user: Identity; guilds: Guild[] }>>; lanes: Map<string, number>; aliases: Map<string, string>; cooldowns: Map<string, number> };
const discordStateKey = Symbol.for("profile-dashboard.discord-auth.v3");
const shared = globalThis as typeof globalThis & { [discordStateKey]?: WeakMap<object, DiscordState> };
const discordStates = shared[discordStateKey] ??= new WeakMap<object, DiscordState>();
let discordInFlight = 0;
let discordWaiters = 0;
const maxDiscordRetry = 86400;
const discordSafetyMs = 100;

function discordState(config: AuthConfig, token: string, dependencies: Dependencies) {
  const scope = dependencies.discordScope ?? globalThis;
  let state = discordStates.get(scope);
  if (!state) {
    state = { pending: new Map(), contexts: new Map(), lanes: new Map(), aliases: new Map(), cooldowns: new Map() };
    discordStates.set(scope, state);
  }
  const configKey = createHash("sha256").update(JSON.stringify([config.clientId, config.clientSecret, config.origin, config.password])).digest("hex");
  const tokenKey = createHash("sha256").update(JSON.stringify([configKey, token])).digest("hex");
  return { state, configKey, tokenKey };
}

function milliseconds(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.length > 128 || !/^\d+(\.\d+)?$/.test(value))) return;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  return Math.min(maxDiscordRetry * 1000, seconds * 1000);
}

function retrySeconds(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.length > 128 || !/^\d+(\.\d+)?$/.test(value))) return;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  return Math.min(maxDiscordRetry, Math.max(1, Math.ceil(seconds)));
}

function discordFailure(reason: NonNullable<ApiError["reason"]>, status?: number, retry?: number) {
  const error = new ApiError(503, "discord_unavailable");
  error.reason = reason;
  error.upstreamStatus = status;
  if (retry !== undefined) error.retryAfter = retrySeconds(retry);
  return error;
}

function waitForDiscord<T>(work: DiscordWork<T>, signal: AbortSignal): Promise<T> {
  work.waiters++;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", abort);
      if (--work.waiters === 0 && !work.settled) work.cancel(signal.reason);
    };
    const abort = () => {
      release();
      reject(discordFailure(signal.reason?.name === "TimeoutError" ? "timeout" : "aborted"));
    };
    work.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

async function discordRead<T>(path: string, token: string, config: AuthConfig, dependencies: Dependencies, signal: AbortSignal, parse: (value: unknown) => T, budget = discordTimeoutMs): Promise<T> {
  if (signal.aborted) throw discordFailure("aborted");
  if (budget <= 0) throw discordFailure("timeout");
  const fetcher = dependencies.fetch ?? fetch;
  const { state, configKey, tokenKey } = discordState(config, token, dependencies);
  const requests = state.pending;
  const key = `${tokenKey}:${path}`;
  const now = dependencies.now ?? Date.now;
  const time = now();
  for (const [id, until] of state.lanes) if (until <= time) state.lanes.delete(id);
  for (const [id, until] of state.cooldowns) if (until <= time) state.cooldowns.delete(id);
  const until = Math.max(state.cooldowns.get(configKey) ?? 0, state.cooldowns.get(tokenKey) ?? 0);
  if (until > time) throw discordFailure("rate_limited", 429, Math.ceil((until - time) / 1000));
  const existing = requests.get(key);
  if (existing) return waitForDiscord(existing as DiscordWork<T>, signal);
  if (discordInFlight >= 256) throw discordFailure("capacity");
  discordInFlight++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(discordFailure(controller.signal.reason?.name === "TimeoutError" ? "timeout" : "aborted"));
    controller.signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => controller.abort(new DOMException("Discord deadline exceeded", "TimeoutError")), Math.max(1, budget));
  });
  const operation = Promise.resolve().then(async () => {
    if (controller.signal.aborted) throw discordFailure("aborted");
    const lane = state.aliases.get(key) ?? key;
    const scheduled = Math.max(now(), state.lanes.get(lane) ?? 0);
    const wait = scheduled - now();
    if (wait >= budget) throw discordFailure("rate_limited", 429, Math.ceil(wait / 1000));
    if (!state.lanes.has(lane) && state.lanes.size >= 2000) throw discordFailure("capacity");
    state.lanes.set(lane, scheduled + discordSafetyMs);
    if (wait > 0) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(discordFailure("timeout")); };
        const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, wait);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (controller.signal.aborted) throw discordFailure("timeout");
    const blocked = Math.max(state.cooldowns.get(configKey) ?? 0, state.cooldowns.get(tokenKey) ?? 0);
    if (blocked > now()) throw discordFailure("rate_limited", 429, Math.ceil((blocked - now()) / 1000));
    let response: Response;
    try {
      response = await fetcher(`https://discord.com/api/v10/${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: controller.signal });
    } catch { throw discordFailure(controller.signal.aborted ? "timeout" : "network"); }
    const bucket = response.headers.get("X-RateLimit-Bucket");
    const bucketKey = bucket && bucket.length <= 256 ? `${tokenKey}:bucket:${createHash("sha256").update(bucket).digest("hex")}` : lane;
    if (bucketKey !== lane && (state.aliases.has(key) || state.aliases.size < 2000)) state.aliases.set(key, bucketKey);
    const reset = milliseconds(response.headers.get("X-RateLimit-Reset-After"));
    const rawRemaining = response.headers.get("X-RateLimit-Remaining");
    const remaining = rawRemaining && /^\d{1,9}$/.test(rawRemaining) ? Number(rawRemaining) : undefined;
    if (reset !== undefined && remaining !== undefined) {
      const spacing = remaining === 0 ? reset : reset / (remaining + 1);
      state.lanes.set(bucketKey, Math.max(state.lanes.get(bucketKey) ?? 0, now() + spacing + discordSafetyMs));
    }
    if (response.status === 429) {
      const remember = (scope: string, seconds: number) => {
        const deadline = now() + seconds * 1000;
        if (!state.cooldowns.has(scope) && state.cooldowns.size >= 1000) state.cooldowns.set(configKey, Math.max(state.cooldowns.get(configKey) ?? 0, deadline));
        else state.cooldowns.set(scope, Math.max(state.cooldowns.get(scope) ?? 0, deadline));
      };
      const headerRetry = retrySeconds(response.headers.get("Retry-After"));
      const headerGlobal = response.headers.get("X-RateLimit-Global") === "true";
      if (headerRetry !== undefined) remember(headerGlobal ? configKey : tokenKey, headerRetry);
      let body: unknown;
      try { body = await boundedJson(response); } catch {}
      finally { void response.body?.cancel().catch(() => {}); }
      const retry = Math.max(headerRetry ?? 0, object(body) ? retrySeconds(body.retry_after) ?? 0 : 0, reset !== undefined ? Math.ceil(reset / 1000) : 0) || 5;
      state.lanes.set(bucketKey, Math.max(state.lanes.get(bucketKey) ?? 0, now() + retry * 1000 + discordSafetyMs));
      const global = (object(body) && body.global === true) || response.headers.get("X-RateLimit-Global") === "true";
      remember(global ? configKey : tokenKey, retry);
      throw discordFailure("rate_limited", 429, Math.ceil((Math.max(state.cooldowns.get(configKey) ?? 0, state.cooldowns.get(tokenKey) ?? 0) - now()) / 1000));
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new ApiError(401, "unauthorized");
      throw discordFailure("upstream_status", response.status);
    }
    try { return parse(await response.json()); }
    catch { throw discordFailure("invalid_response"); }
  });
  const pending = Promise.race([operation, deadline]).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "discord_unavailable") console.warn("discord_auth_unavailable", { endpoint: path, reason: error.reason, status: error.upstreamStatus, retryAfter: error.retryAfter });
    throw error;
  }).finally(() => {
    work.settled = true;
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
    if (requests.get(key) === work) requests.delete(key);
    discordInFlight--;
  });
  const work: DiscordWork<T> = { promise: pending, waiters: 0, settled: false, cancel: reason => {
    if (requests.get(key) === work) requests.delete(key);
    controller.abort(reason);
  } };
  requests.set(key, work);
  return waitForDiscord(work, signal);
}

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig | null {
  try {
    const { DISCORD_CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: clientSecret, SESSION_PASSWORD: password, APP_URL } = env;
    if (!clientId || !/^\d{17,20}$/.test(clientId) || !clientSecret || !password || password.length < 32 || !APP_URL) return null;
    const url = new URL(APP_URL);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || (env.NODE_ENV === "production" && local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { clientId, clientSecret, password, origin: url.origin, secure: !local };
  } catch { return null; }
}

function options(config: AuthConfig, cookieName: string, ttl: number): SessionOptions {
  return { password: config.password, cookieName, ttl, cookieOptions: { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/", maxAge: ttl } };
}

export function validState(flow: Partial<Flow>, state: string | null, now: number): flow is Flow {
  if (typeof flow.state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(flow.state) || !state || !/^[A-Za-z0-9_-]{43}$/.test(state) || typeof flow.verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(flow.verifier) || typeof flow.expiresAt !== "number" || flow.expiresAt <= now || flow.expiresAt > now + 600000) return false;
  return timingSafeEqual(Buffer.from(flow.state), Buffer.from(state));
}

export function validSession(value: Partial<Session>, now: number): value is Session {
  return typeof value.accessToken === "string" && value.accessToken.length > 0 && value.accessToken.length <= 1024 && /^[\x21-\x7e]+$/.test(value.accessToken) && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && value.expiresAt > now && value.expiresAt <= now + 28800000;
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function snowflake(value: unknown): value is string { return typeof value === "string" && /^\d{17,20}$/.test(value); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }

export function parseIdentity(value: unknown): Identity {
  if (!object(value) || !snowflake(value.id) || !text(value.username, 32) || (value.global_name != null && !text(value.global_name, 32))) throw new Error("upstream");
  return { id: value.id, username: value.username, name: typeof value.global_name === "string" ? value.global_name : value.username };
}

export function parseGuilds(value: unknown): Guild[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("upstream");
  return value.map((guild: unknown) => {
    if (!object(guild) || !snowflake(guild.id) || !text(guild.name, 100)) throw new Error("upstream");
    const canModerate = guild.owner === true || (typeof guild.permissions === "string" && /^\d{1,20}$/.test(guild.permissions) && (BigInt(guild.permissions) & 8n) === 8n);
    return { id: guild.id, name: guild.name, ...(canModerate ? { canModerate: true } : {}) };
  });
}

async function discordContext(token: string, config: AuthConfig, dependencies: Dependencies, signal: AbortSignal) {
  const { state, tokenKey } = discordState(config, token, dependencies);
  if (signal.aborted) throw discordFailure("aborted");
  if (discordWaiters >= 512) throw discordFailure("capacity");
  let pending = state.contexts.get(tokenKey);
  if (!pending) {
    if (state.contexts.size >= 256) throw discordFailure("capacity");
    const started = Date.now();
    const controller = new AbortController();
    const work: DiscordWork<{ user: Identity; guilds: Guild[] }> = { promise: Promise.resolve().then(async () => {
      const user = await discordRead("users/@me", token, config, dependencies, controller.signal, parseIdentity);
      const guilds = await discordRead("users/@me/guilds?limit=200", token, config, dependencies, controller.signal, parseGuilds, discordTimeoutMs - (Date.now() - started));
      return { user, guilds };
    }).finally(() => {
      work.settled = true;
      if (state.contexts.get(tokenKey) === work) state.contexts.delete(tokenKey);
    }), waiters: 0, settled: false, cancel: reason => {
      if (state.contexts.get(tokenKey) === work) state.contexts.delete(tokenKey);
      controller.abort(reason);
    } };
    pending = work;
    state.contexts.set(tokenKey, pending);
  }
  discordWaiters++;
  try { return await waitForDiscord(pending, AbortSignal.any([signal, AbortSignal.timeout(discordTimeoutMs)])); }
  finally { discordWaiters--; }
}

export async function authenticatedMember(request: Request, config: AuthConfig, dependencies: Dependencies = {}): Promise<{ user: Identity; guilds: Guild[] }> {
  const now = dependencies.now ?? Date.now;
  const session = await getIronSession<Session>(webCookies(request, new Headers()), { password: config.password, cookieName: sessionName, ttl: 28800 });
  if (!validSession(session, now())) throw new ApiError(401, "unauthorized");
  try {
    const { user, guilds } = await discordContext(session.accessToken, config, dependencies, request.signal);
    if (!validSession(session, now())) throw new ApiError(401, "unauthorized");
    return { user, guilds };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "discord_unavailable");
  }
}

export async function handleAuth(request: Request, action: string, dependencies: Dependencies = {}): Promise<Response> {
  const config = authConfig(dependencies.env);
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const limit = dependencies.limit ?? ((key: string) => enforceRateLimit(`auth:${action}:${key}`, key === "oauth" ? 60 : 30, dependencies.env));
  const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  const clear = (name: string) => headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${config?.secure || dependencies.env?.NODE_ENV === "production" ? "; Secure" : ""}`);
  const redirect = (error?: string) => {
    headers.set("Location", config ? `${config.origin}/${error ? `?auth_error=${error}` : ""}#discord` : "/?auth_error=setup#discord");
    return new Response(null, { status: 303, headers });
  };
  if (action === "discord/callback") clear(flowName);
  if (!["discord", "discord/callback", "session", "logout"].includes(action)) return json({ error: "not_found" }, 404);
  if (request.method !== (action === "logout" ? "POST" : "GET")) { headers.set("Allow", action === "logout" ? "POST" : "GET"); return json({ error: "method_not_allowed" }, 405); }
  if (!config) return action === "discord/callback" ? redirect("setup") : json({ status: "setup_required", message: "Login belum dikonfigurasi. Isi DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, APP_URL, dan SESSION_PASSWORD (acak, minimal 32 karakter) pada environment server, lalu mulai ulang aplikasi." }, 503);
  if (action === "logout") {
    if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "csrf" }, 403);
    clear(sessionName); clear(flowName);
    return json({ status: "signed_out" });
  }
  const callback = `${config.origin}/api/auth/discord/callback`;
  async function discord(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetcher(`https://discord.com/api/${path}`, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(discordTimeoutMs) });
    if (!response.ok) throw new Error(response.status === 401 ? "expired" : "upstream");
    return response.json();
  }
  try {
    if (action === "discord") {
      if (!await limit("oauth")) return json({ error: "rate_limited" }, 429);
      const flow = await getIronSession<Flow>(webCookies(request, headers), options(config, flowName, 600));
      flow.state = randomBytes(32).toString("base64url");
      flow.verifier = randomBytes(32).toString("base64url");
      flow.expiresAt = now() + 600000;
      await flow.save();
      const url = new URL("https://discord.com/oauth2/authorize");
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, response_type: "code", scope: "identify guilds", state: flow.state, code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      headers.set("Location", url.toString());
      return new Response(null, { status: 303, headers });
    }
    if (action === "discord/callback") {
      const flow = await getIronSession<Flow>(webCookies(request, headers), options(config, flowName, 600));
      const params = new URL(request.url).searchParams;
      const valid = validState(flow, params.get("state"), now());
      const verifier = flow.verifier;
      flow.destroy();
      if (!valid || params.getAll("state").length !== 1) return redirect("state");
      if (params.has("error")) return redirect("denied");
      const code = params.get("code");
      if (!code || code.length > 2048 || params.getAll("code").length !== 1 || (params.has("iss") && params.get("iss") !== "https://discord.com")) return redirect("callback");
      if (!await limit("oauth")) return redirect("rate_limited");
      const started = now();
      const token = await discord("oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: verifier! }) });
      if (!object(token) || !text(token.access_token, 1024) || !/^[\x21-\x7e]+$/.test(token.access_token) || token.token_type !== "Bearer" || typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 60 || typeof token.scope !== "string" || !["identify", "guilds"].every((scope) => (token.scope as string).split(" ").includes(scope))) throw new Error("upstream");
      await discordRead("users/@me", token.access_token, config, dependencies, request.signal, parseIdentity);
      const ttl = Math.min(token.expires_in - 30, 28800);
      const session = await getIronSession<Session>(webCookies(request, headers), options(config, sessionName, ttl));
      session.accessToken = token.access_token;
      session.expiresAt = started + ttl * 1000;
      await session.save();
      return redirect();
    }
    const session = await getIronSession<Session>(webCookies(request, headers), options(config, sessionName, 28800));
    if (!validSession(session, now())) { session.destroy(); return json({ status: "signed_out" }, 401); }
    const key = createHash("sha256").update(session.accessToken).digest("hex");
    if (!await limit(key)) { headers.set("Retry-After", "60"); return json({ error: "rate_limited" }, 429); }
    const { user, guilds } = await discordContext(session.accessToken, config, dependencies, request.signal);
    if (session.expiresAt <= now()) { session.destroy(); return json({ status: "signed_out" }, 401); }
    let available = new Set<string>();
    try { available = botGuilds(dependencies.env); } catch {}
    return json({ status: "authenticated", user, guilds: guilds.filter((guild) => available.has(guild.id)) });
  } catch (error) {
    if (error instanceof ApiError && error.code === "rate_limit_unavailable") return action === "discord/callback" ? redirect("setup") : json({ error: error.code }, error.status);
    if (action === "discord/callback") return redirect("upstream");
    if (error instanceof ApiError && error.status === 401) { clear(sessionName); return json({ status: "signed_out" }, 401); }
    if (error instanceof ApiError && error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
    return json({ error: "discord_unavailable", ...(error instanceof ApiError && error.reason ? { reason: error.reason } : {}), message: "Discord belum dapat dihubungi. Coba lagi nanti." }, 502);
  }
}
