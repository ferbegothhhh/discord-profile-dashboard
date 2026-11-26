import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, privateHeaders, snowflake, verifyBotGuild } from "./api-security.ts";
import { canUseCustomSlot, isCustomSlot } from "./background-policy.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { getCurrentLevel } from "./bot-level.ts";
import { IMAGE_HEIGHT, IMAGE_WIDTH, MAX_OUTPUT_BYTES } from "./image-processing.ts";
import { createDatabaseClient } from "./supabase.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type Owner = { userId: string; guildId: string; id: string; revision: number };
export type BackgroundMediaStore = { get(owner: Owner): Promise<unknown> };
export type BackgroundMediaDependencies = Dependencies & {
  store?: BackgroundMediaStore;
  getLevel?: typeof getCurrentLevel;
  storage?: Pick<BackgroundStorage, "download">;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function mediaStore(env: NonNullable<Dependencies["env"]>, fetcher?: typeof fetch): BackgroundMediaStore {
  return {
    async get(owner) {
      const { data, error } = await createDatabaseClient(env, fetcher).from("profile_backgrounds")
        .select("id,kind,visibility,owner_user_id,owner_guild_id,slot_number,revision,status,is_active,mime,width,height,byte_size,object_key")
        .eq("id", owner.id).eq("owner_user_id", owner.userId).eq("owner_guild_id", owner.guildId)
        .eq("kind", "image").eq("visibility", "private").eq("status", "ready").eq("is_active", true).eq("revision", owner.revision).maybeSingle();
      if (error) throw new Error();
      return data;
    },
  };
}

export async function handleBackgroundMedia(request: Request, id: string, dependencies: BackgroundMediaDependencies = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`background-media:${user.id}`, 60, env))) throw new ApiError(429, "rate_limited");
    if (!uuid.test(id)) throw new ApiError(400, "invalid_id");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    const rawRevision = params.get("revision");
    if ([...params.keys()].some((key) => key !== "guildId" && key !== "revision") || params.getAll("guildId").length !== 1 || params.getAll("revision").length !== 1 || !snowflake(guildId) || !rawRevision || !/^[1-9]\d{0,9}$/.test(rawRevision)) throw new ApiError(400, "invalid_query");
    const revision = Number(rawRevision);
    if (!Number.isSafeInteger(revision) || revision > 2 ** 31) throw new ApiError(400, "invalid_query");
    verifyBotGuild(guildId, env);
    if (!snowflake(user.id) || !guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    const level = async () => {
      try {
        const snapshot = await (dependencies.getLevel ?? getCurrentLevel)(user.id, guildId, env, dependencies.fetch);
        if (!snapshot || snapshot.userId !== user.id || snapshot.guildId !== guildId || !Number.isSafeInteger(snapshot.level) || snapshot.level < 0) throw new Error();
        return snapshot;
      } catch { throw new ApiError(503, "level_unavailable"); }
    };
    const snapshot = await level();
    let row: unknown;
    try { row = await (dependencies.store ?? mediaStore(env, dependencies.fetch)).get({ userId: user.id, guildId, id, revision }); }
    catch { throw new ApiError(503, "database_unavailable"); }
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiError(404, "background_not_found");
    const value = row as Record<string, unknown>;
    if (value.id !== id || value.owner_user_id !== user.id || value.owner_guild_id !== guildId || value.kind !== "image" || value.visibility !== "private" || value.status !== "ready" || value.is_active !== true || value.revision !== revision || !isCustomSlot(value.slot_number)) throw new ApiError(404, "background_not_found");
    if (!canUseCustomSlot(snapshot, user.id, guildId, value.slot_number)) throw new ApiError(403, "slot_locked");
    if (value.mime !== "image/png" || value.width !== IMAGE_WIDTH || value.height !== IMAGE_HEIGHT || typeof value.byte_size !== "number" || !Number.isSafeInteger(value.byte_size) || value.byte_size <= 0 || value.byte_size > MAX_OUTPUT_BYTES || typeof value.object_key !== "string" || !/^profile-images\/[a-f0-9]{32}\.png$/.test(value.object_key)) throw new ApiError(404, "background_not_found");
    let png: Buffer;
    try {
      png = await (dependencies.storage ?? backgroundStorage({ env, fetcher: dependencies.fetch })).download(value.object_key);
      if (!Buffer.isBuffer(png) || png.length !== value.byte_size || png.length > MAX_OUTPUT_BYTES || png.length < 8 || !png.subarray(0, 8).equals(pngSignature)) throw new Error();
    } catch { throw new ApiError(503, "storage_unavailable"); }
    if (!canUseCustomSlot(await level(), user.id, guildId, value.slot_number)) throw new ApiError(403, "slot_locked");
    return new Response(new Uint8Array(png), { headers: { ...privateHeaders, "Content-Type": "image/png", "Content-Length": String(png.length) } });
  } catch (error) { return apiFailure(error); }
}
