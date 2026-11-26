import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, boundedJson, privateJson, snowflake, verifyBearer, verifyBotGuild } from "./api-security.ts";
import { catalogMedia, findBackground } from "./catalog.ts";
import { imageId, preferenceStore, validResolvedImage, type PreferenceStore, type PreferenceImage } from "./supabase.ts";
import { getCurrentLevel } from "./bot-level.ts";
import { canUseCustomSlot, type LevelSnapshot } from "./background-policy.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

type Options = Dependencies & { store?: PreferenceStore; getLevel?: typeof getCurrentLevel };

export async function preferenceLevel(userId: string, guildId: string, dependencies: Options): Promise<LevelSnapshot> {
  try {
    const snapshot = await (dependencies.getLevel ?? getCurrentLevel)(userId, guildId, dependencies.env ?? process.env, dependencies.fetch);
    if (!snapshot || snapshot.userId !== userId || snapshot.guildId !== guildId || !Number.isSafeInteger(snapshot.level) || snapshot.level < 0) throw new Error();
    return snapshot;
  } catch { throw new ApiError(503, "level_unavailable"); }
}
async function resolveSelection(store: PreferenceStore, userId: string, guildId: string, id: string, dependencies: Options): Promise<PreferenceImage | null> {
  const image = await store.resolveImage?.(userId, guildId, id) ?? null;
  if (!validResolvedImage(image, userId, guildId, id)) return null;
  return canUseCustomSlot(await preferenceLevel(userId, guildId, dependencies), userId, guildId, image.slot) ? image : null;
}

export async function handlePreferences(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (!["GET", "POST"].includes(request.method)) throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (request.method === "POST" && (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ApiError(403, "csrf");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`preferences:${user.id}`, 60, env))) throw new ApiError(429, "rate_limited");
    let guildId: unknown;
    let backgroundId: unknown;
    const params = new URL(request.url).searchParams;
    if (request.method === "GET") {
      if ([...params.keys()].some((key) => key !== "guildId") || params.getAll("guildId").length !== 1) throw new ApiError(400, "invalid_guild");
      guildId = params.get("guildId");
    } else {
      if (params.size || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "invalid_body");
      const body = await boundedJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 2 || !("guildId" in body) || !("backgroundId" in body)) throw new ApiError(400, "invalid_body");
      ({ guildId, backgroundId } = body);
      if (backgroundId !== null && !(findBackground(backgroundId)?.image) && !imageId(backgroundId)) throw new ApiError(400, "invalid_background");
    }
    if (!snowflake(guildId)) throw new ApiError(400, "invalid_guild");
    verifyBotGuild(guildId, env);
    if (!guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    const store = dependencies.store ?? preferenceStore(env, dependencies.fetch);
    if (request.method === "GET") {
      const id = await store.get(user.id, guildId);
      const effective = findBackground(id)?.image ? id : imageId(id) && await resolveSelection(store, user.id, guildId, id, dependencies) ? id : null;
      return privateJson({ status: "ready", backgroundId: effective });
    }
    if (backgroundId === null) {
      await store.reset(user.id, guildId);
      return privateJson({ status: "reset", backgroundId: null });
    }
    if (imageId(backgroundId) && !await resolveSelection(store, user.id, guildId, backgroundId, dependencies)) throw new ApiError(400, "invalid_background");
    await store.set(user.id, guildId, backgroundId as string);
    return privateJson({ status: "saved", backgroundId });
  } catch (error) { return apiFailure(error); }
}

export async function handleBotPreferences(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed");
    verifyBearer(request, env);
    if (!await (dependencies.limit ? dependencies.limit("bot") : enforceRateLimit("bot-preferences:bot", 120, env))) throw new ApiError(429, "rate_limited");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    const userId = params.get("userId");
    if (params.size !== 2 || params.getAll("guildId").length !== 1 || params.getAll("userId").length !== 1 || !snowflake(guildId) || !snowflake(userId)) throw new ApiError(400, "invalid_input");
    verifyBotGuild(guildId, env);
    const store = dependencies.store ?? preferenceStore(env, dependencies.fetch);
    const id = await store.get(userId, guildId);
    if (imageId(id)) {
      const image = await resolveSelection(store, userId, guildId, id, dependencies);
      return privateJson({ status: "ready", backgroundId: image ? id : null, background: image ? { id, kind: image.kind, revision: image.revision, mime: image.mime, width: image.width, height: image.height, slot: image.slot } : null });
    }
    const background = findBackground(id);
    const media = background ? catalogMedia[background.id] : undefined;
    return privateJson({ status: "ready", backgroundId: background && media ? background.id : null, background: background && media ? { id: background.id, kind: "catalog-image", mime: media.mime, width: media.width, height: media.height } : null });
  } catch (error) { return apiFailure(error); }
}
