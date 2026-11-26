import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, privateJson, verifyBotGuild, snowflake } from "./api-security.ts";
import { customSlots, isCustomSlot, type CustomSlot } from "./background-policy.ts";
import { getCurrentLevel } from "./bot-level.ts";
import { createDatabaseClient } from "./supabase.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

export type BackgroundLibraryDependencies = Dependencies & {
  getLevel?: typeof getCurrentLevel;
  listBackgrounds?: (userId: string, guildId: string) => Promise<unknown>;
};
type Background = { id: string; name: string; status: "processing" | "ready" | "failed"; revision: number; isActive: boolean };

function metadata(rows: unknown): Map<CustomSlot, Background> {
  if (!Array.isArray(rows) || rows.length > 3) throw new ApiError(503, "database_unavailable");
  const slots = new Map<CustomSlot, Background>();
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new ApiError(503, "database_unavailable");
    const { id, name, slot_number: slot, status, revision, is_active: isActive } = row;
    if (!isCustomSlot(slot) || slots.has(slot) || typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ids.has(id) || typeof name !== "string" || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || !["processing", "ready", "failed"].includes(status) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0 || typeof isActive !== "boolean") throw new ApiError(503, "database_unavailable");
    ids.add(id);
    slots.set(slot, { id, name, status, revision, isActive });
  }
  return slots;
}

export async function handleBackgroundLibrary(request: Request, dependencies: BackgroundLibraryDependencies = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`background-library:${user.id}`, 60, env))) throw new ApiError(429, "rate_limited");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    if ([...params.keys()].some((key) => key !== "guildId") || params.getAll("guildId").length !== 1 || !snowflake(guildId)) throw new ApiError(400, "invalid_guild");
    verifyBotGuild(guildId, env);
    if (!guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    const snapshot = await (dependencies.getLevel ?? getCurrentLevel)(user.id, guildId, env, dependencies.fetch);
    if (!snapshot || snapshot.userId !== user.id || snapshot.guildId !== guildId || !Number.isSafeInteger(snapshot.level) || snapshot.level < 0) throw new ApiError(503, "level_unavailable");
    const list = dependencies.listBackgrounds ?? (async (userId: string, ownerGuildId: string) => {
      const { data, error } = await createDatabaseClient(env, dependencies.fetch).from("profile_backgrounds")
        .select("id,name,slot_number,status,is_active,revision")
        .eq("owner_user_id", userId).eq("owner_guild_id", ownerGuildId).eq("visibility", "private").eq("kind", "image").order("slot_number");
      if (error) throw new ApiError(503, "database_unavailable");
      return data;
    });
    const backgrounds = metadata(await list(user.id, guildId));
    return privateJson({ status: "ready", guildId, level: snapshot.level, slots: customSlots(snapshot, user.id, guildId).map((slot) => ({ ...slot, background: backgrounds.get(slot.slot) ?? null })) });
  } catch (error) { return apiFailure(error); }
}
