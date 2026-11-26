import { type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, privateHeaders, snowflake, verifyBearer, verifyBotGuild } from "./api-security.ts";
import { canUseCustomSlot } from "./background-policy.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { getCurrentLevel } from "./bot-level.ts";
import { preferenceLevel } from "./preferences.ts";
import { imageId, preferenceStore, validResolvedImage, type PreferenceStore } from "./supabase.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type Options = Dependencies & { store?: PreferenceStore; getLevel?: typeof getCurrentLevel; storage?: Pick<BackgroundStorage, "download"> };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function handleBotBackgroundMedia(request: Request, id: string, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed");
    verifyBearer(request, env);
    if (!await (dependencies.limit ? dependencies.limit("bot-media") : enforceRateLimit("bot-background-media:bot-media", 120, env))) throw new ApiError(429, "rate_limited");
    if (!imageId(id)) throw new ApiError(400, "invalid_id");
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId");
    const guildId = params.get("guildId");
    const rawRevision = params.get("revision");
    if (params.size !== 3 || ["userId", "guildId", "revision"].some(key => params.getAll(key).length !== 1) || !snowflake(userId) || !snowflake(guildId) || !rawRevision || !/^[1-9]\d{0,9}$/.test(rawRevision) || Number(rawRevision) > 2 ** 31) throw new ApiError(400, "invalid_query");
    verifyBotGuild(guildId, env);
    const store = dependencies.store ?? preferenceStore(env, dependencies.fetch);
    const snapshot = await preferenceLevel(userId, guildId, dependencies);
    const image = await store.resolveImage?.(userId, guildId, id) ?? null;
    if (!validResolvedImage(image, userId, guildId, id) || image.revision !== Number(rawRevision) || await store.get(userId, guildId) !== id) throw new ApiError(404, "background_not_found");
    if (!canUseCustomSlot(snapshot, userId, guildId, image.slot)) throw new ApiError(403, "slot_locked");
    let png: Buffer;
    try {
      png = await (dependencies.storage ?? backgroundStorage({ env, fetcher: dependencies.fetch })).download(image.objectKey);
      if (!Buffer.isBuffer(png) || png.length !== image.byteSize || png.length < 8 || !png.subarray(0, 8).equals(signature)) throw new Error();
    } catch { throw new ApiError(503, "storage_unavailable"); }
    if (!canUseCustomSlot(await preferenceLevel(userId, guildId, dependencies), userId, guildId, image.slot)) throw new ApiError(403, "slot_locked");
    const current = await store.resolveImage?.(userId, guildId, id) ?? null;
    if (await store.get(userId, guildId) !== id || !validResolvedImage(current, userId, guildId, id) || current.revision !== image.revision || current.objectKey !== image.objectKey || current.byteSize !== image.byteSize || current.slot !== image.slot) throw new ApiError(404, "background_not_found");
    return new Response(new Uint8Array(png), { headers: { ...privateHeaders, "Content-Type": "image/png", "Content-Length": String(png.length) } });
  } catch (error) { return apiFailure(error); }
}
