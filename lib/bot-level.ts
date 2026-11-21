import { isIP } from "node:net";
import { ApiError, snowflake, type Environment } from "./api-security.ts";
import type { LevelSnapshot } from "./background-policy.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export type BotLevelConfig = { origin: string; apiKey: string };

export function botLevelConfig(env: Environment = process.env): BotLevelConfig | null {
  try {
    const raw = env.PROFILE_LEVEL_API_URL;
    const apiKey = env.PROFILE_LEVEL_API_KEY;
    if (!raw || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(raw)) return null;
    const url = new URL(raw);
    const local = env.NODE_ENV === "development" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (env.NODE_ENV === "production") {
      const hosts = (env.PROFILE_LEVEL_API_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase());
      const host = url.hostname.toLowerCase();
      if (!hosts.length || hosts.length > 10 || hosts.some((value) => !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value))
        || !hosts.includes(host) || isIP(host.replace(/^\[|\]$/g, "")) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) return null;
    }
    if (!apiKey || !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey) || new Set(apiKey).size < 16 || apiKey === env.PROFILE_BOT_API_KEY) return null;
    return { origin: url.origin, apiKey };
  } catch { return null; }
}

export async function getCurrentLevel(userId: string, guildId: string, env: Environment = process.env, fetcher: typeof fetch = fetch): Promise<LevelSnapshot> {
  if (!snowflake(userId)) throw new ApiError(400, "invalid_user");
  if (!snowflake(guildId)) throw new ApiError(400, "invalid_guild");
  const config = botLevelConfig(env);
  if (!config) throw new ApiError(503, "level_unavailable");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); };
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error()); cancel(); }, 2000);
    });
    const operation = async (): Promise<LevelSnapshot> => {
      const url = new URL("/api/profile-level", config.origin);
      url.search = new URLSearchParams({ userId, guildId }).toString();
      const response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" }, redirect: "error", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      reader = response.body?.getReader();
      if (!response.ok || response.redirected || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") || !reader) throw new Error();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096)) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw new Error();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw new Error();
          chunks.push(value);
        }
        const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
        const value = data as Record<string, unknown>;
        if (Object.keys(value).length !== 4 || value.status !== "ready" || value.userId !== userId || value.guildId !== guildId || typeof value.level !== "number" || !Number.isSafeInteger(value.level) || value.level < 0) throw new Error();
        return { userId, guildId, level: value.level };
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    return await Promise.race([operation(), deadline]);
  } catch {
    cancel();
    throw new ApiError(503, "level_unavailable");
  } finally { clearTimeout(timer); }
}
