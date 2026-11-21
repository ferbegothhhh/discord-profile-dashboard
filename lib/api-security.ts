import { createHash, timingSafeEqual } from "node:crypto";

export type Environment = Record<string, string | undefined>;
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
export function privateJson(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { ...privateHeaders, ...(status === 429 ? { "Retry-After": "60" } : {}) } });
}
export function apiFailure(error: unknown) {
  return error instanceof ApiError ? privateJson({ error: error.code }, error.status) : privateJson({ error: "service_unavailable" }, 503);
}
export function snowflake(value: unknown): value is string { return typeof value === "string" && /^[1-9]\d{16,19}$/.test(value); }
export function botGuilds(env: Environment = process.env): Set<string> {
  const raw = env.PROFILE_BOT_GUILD_IDS;
  if (!raw || raw.length > 21000) throw new ApiError(503, "setup_required");
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.length > 1000 || !ids.every(snowflake)) throw new ApiError(503, "setup_required");
  return new Set(ids);
}
export function verifyBotGuild(guildId: string, env: Environment) {
  if (!botGuilds(env).has(guildId)) throw new ApiError(403, "guild_forbidden");
}
export function botKey(env: Environment): string {
  const key = env.PROFILE_BOT_API_KEY;
  if (!key || !/^[A-Za-z0-9_-]{32,256}$/.test(key) || new Set(key).size < 16) throw new ApiError(503, "setup_required");
  return key;
}
export function verifyBearer(request: Request, env: Environment) {
  const expected = createHash("sha256").update(`Bearer ${botKey(env)}`).digest();
  const provided = request.headers.get("authorization") ?? "";
  const actual = createHash("sha256").update(provided.length <= 300 ? provided : "").digest();
  if (!timingSafeEqual(expected, actual)) throw new ApiError(401, "unauthorized");
}
export function createProcessLimiter(max = 120, capacity = 2000, now = Date.now) {
  const buckets = new Map<string, { count: number; until: number }>();
  return (key: string) => {
    const time = now();
    for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
    if (!buckets.has(key) && buckets.size >= capacity) return false;
    const bucket = buckets.get(key) ?? { count: 0, until: time + 60000 };
    buckets.set(key, bucket);
    return ++bucket.count <= max;
  };
}
export async function boundedJson(request: Request, max = 1024): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) throw new ApiError(400, "invalid_body");
  if (!request.body) throw new ApiError(400, "invalid_body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 2000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { void reader.cancel().catch(() => {}); throw new ApiError(400, "invalid_body"); }
      chunks.push(value);
    }
    if (!size || timedOut) throw new Error();
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new ApiError(400, "invalid_body"); }
  finally { clearTimeout(timer); reader.releaseLock(); }
}
