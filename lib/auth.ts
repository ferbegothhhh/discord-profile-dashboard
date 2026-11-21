import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getIronSession, webCookies, type SessionOptions } from "iron-session";
import { ApiError, botGuilds } from "./api-security.ts";

export type AuthConfig = { clientId: string; clientSecret: string; origin: string; password: string; secure: boolean };
type Flow = { state: string; verifier: string; expiresAt: number };
type Session = { accessToken: string; expiresAt: number };
export type Identity = { id: string; username: string; name: string };
export type Guild = { id: string; name: string; canModerate?: boolean };
export type Dependencies = { env?: Record<string, string | undefined>; fetch?: typeof fetch; now?: () => number; limit?: (key: string) => boolean };
export const sessionName = "profile_session";
const flowName = "profile_oauth";
const discordTimeoutMs = 8000;
const buckets = new Map<string, { count: number; until: number }>();

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

function localLimit(key: string) {
  const now = Date.now();
  for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
  const bucket = buckets.get(key) ?? { count: 0, until: now + 60000 };
  if (buckets.size >= 1000 && !buckets.has(key)) return false;
  buckets.set(key, bucket);
  return ++bucket.count <= (key === "oauth" ? 60 : 30);
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

export async function authenticatedMember(request: Request, config: AuthConfig, dependencies: Dependencies = {}): Promise<{ user: Identity; guilds: Guild[] }> {
  const now = dependencies.now ?? Date.now;
  const session = await getIronSession<Session>(webCookies(request, new Headers()), { password: config.password, cookieName: sessionName, ttl: 28800 });
  if (!validSession(session, now())) throw new ApiError(401, "unauthorized");
  const signal = AbortSignal.timeout(discordTimeoutMs);
  const discord = async (path: string) => {
    const response = await (dependencies.fetch ?? fetch)(`https://discord.com/api/v10/${path}`, { headers: { Authorization: `Bearer ${session.accessToken}` }, cache: "no-store", redirect: "error", signal });
    if (!response.ok) throw new ApiError(response.status === 401 ? 401 : 503, response.status === 401 ? "unauthorized" : "discord_unavailable");
    return response.json();
  };
  try {
    const user = parseIdentity(await discord("users/@me"));
    const guilds = parseGuilds(await discord("users/@me/guilds?limit=200"));
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
  const limit = dependencies.limit ?? localLimit;
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
      if (!limit("oauth")) return json({ error: "rate_limited" }, 429);
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
      if (!limit("oauth")) return redirect("rate_limited");
      const started = now();
      const token = await discord("oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: "authorization_code", code, redirect_uri: callback, code_verifier: verifier! }) });
      if (!object(token) || !text(token.access_token, 1024) || !/^[\x21-\x7e]+$/.test(token.access_token) || token.token_type !== "Bearer" || typeof token.expires_in !== "number" || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 60 || typeof token.scope !== "string" || !["identify", "guilds"].every((scope) => (token.scope as string).split(" ").includes(scope))) throw new Error("upstream");
      parseIdentity(await discord("v10/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } }));
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
    if (!limit(key)) { headers.set("Retry-After", "60"); return json({ error: "rate_limited" }, 429); }
    const authHeaders = { Authorization: `Bearer ${session.accessToken}` };
    const user = parseIdentity(await discord("v10/users/@me", { headers: authHeaders }));
    const guilds = parseGuilds(await discord("v10/users/@me/guilds?limit=200", { headers: authHeaders }));
    if (session.expiresAt <= now()) { session.destroy(); return json({ status: "signed_out" }, 401); }
    let available = new Set<string>();
    try { available = botGuilds(dependencies.env); } catch {}
    return json({ status: "authenticated", user, guilds: guilds.filter((guild) => available.has(guild.id)) });
  } catch (error) {
    if (action === "discord/callback") return redirect("upstream");
    if (error instanceof Error && error.message === "expired") { clear(sessionName); return json({ status: "signed_out" }, 401); }
    return json({ error: "discord_unavailable", message: "Discord belum dapat dihubungi. Coba lagi nanti." }, 502);
  }
}
