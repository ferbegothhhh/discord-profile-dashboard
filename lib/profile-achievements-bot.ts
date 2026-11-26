import { ApiError, snowflake, type Environment } from "./api-security.ts";
import { botLevelConfig } from "./bot-level.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export function achievementId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

export type Achievement = { id: string; name: string; unlocked: boolean };
export type AchievementSnapshot = { status: "ready"; userId: string; guildId: string; achievements: Achievement[]; selectedTitleId: string | null };
export type TitleSnapshot = { status: "saved"; userId: string; guildId: string; achievementId: string };

async function botRequest<T>(path: string, userId: string, guildId: string, body: object | undefined, parse: (data: unknown) => T | null, env: Environment, fetcher: typeof fetch): Promise<T> {
  if (!snowflake(userId) || !snowflake(guildId)) throw new ApiError(400, "invalid_input");
  const config = botLevelConfig(env);
  if (!config) throw new ApiError(503, "achievements_unavailable");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error()); }, 2000); });
    const operation = async () => {
      const url = new URL(path, config.origin);
      if (!body) url.search = new URLSearchParams({ userId, guildId }).toString();
      const response = await fetcher(url, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted || !response.ok || response.redirected || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768) || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error(); }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw new Error();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) throw new Error();
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      const parsed = parse(data);
      if (parsed === null) throw new Error();
      return parsed;
    };
    return await Promise.race([operation(), deadline]);
  } catch {
    controller.abort();
    throw new ApiError(503, "achievements_unavailable");
  } finally { clearTimeout(timer); }
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

function botSnapshot(value: unknown) {
  if (!record(value) || value.status !== "ready" || !record(value.snapshot)) return null;
  const snapshot = value.snapshot;
  if (!snowflake(snapshot.userId) || !snowflake(snapshot.guildId) || !Array.isArray(snapshot.achievements) || snapshot.achievements.length === 0 || snapshot.achievements.length > 100) return null;
  if (snapshot.selectedTitleId !== null && !achievementId(snapshot.selectedTitleId)) return null;
  const ids = new Set<string>();
  const achievements: Achievement[] = [];
  for (const item of snapshot.achievements) {
    if (!record(item) || !achievementId(item.id) || typeof item.name !== "string" || !item.name || item.name.length > 100 || typeof item.unlocked !== "boolean" || ids.has(item.id)) return null;
    ids.add(item.id);
    achievements.push({ id: item.id, name: item.name, unlocked: item.unlocked });
  }
  if (snapshot.selectedTitleId !== null && !achievements.some((item) => item.id === snapshot.selectedTitleId && item.unlocked)) return null;
  return { userId: snapshot.userId, guildId: snapshot.guildId, achievements, selectedTitleId: snapshot.selectedTitleId };
}

export function getAchievements(userId: string, guildId: string, env: Environment = process.env, fetcher: typeof fetch = fetch) {
  return botRequest<AchievementSnapshot>("/api/profile-achievements", userId, guildId, undefined, (data) => {
    const snapshot = botSnapshot(data);
    return snapshot && snapshot.userId === userId && snapshot.guildId === guildId
      ? { status: "ready", userId, guildId, achievements: snapshot.achievements, selectedTitleId: snapshot.selectedTitleId }
      : null;
  }, env, fetcher);
}

export async function selectTitle(userId: string, guildId: string, id: string, env: Environment = process.env, fetcher: typeof fetch = fetch) {
  if (!achievementId(id)) throw new ApiError(400, "invalid_achievement");
  return botRequest<TitleSnapshot>("/api/profile-achievements/title", userId, guildId, { userId, guildId, achievementId: id }, (data) => {
    const snapshot = botSnapshot(data);
    return snapshot && snapshot.userId === userId && snapshot.guildId === guildId && snapshot.selectedTitleId === id
      ? { status: "saved", userId, guildId, achievementId: id }
      : null;
  }, env, fetcher);
}
