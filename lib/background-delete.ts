import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, createProcessLimiter, privateJson, snowflake, verifyBotGuild } from "./api-security.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { createSupabaseAdminClient } from "./supabase.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type Owner = { userId: string; guildId: string; slot: number };
type DeletedSlot = { removed: boolean; object_key: string | null };
export type BackgroundDeleteStore = { deleteSlot(owner: Owner): Promise<DeletedSlot> };
export type BackgroundDeleteDependencies = Dependencies & {
  store?: BackgroundDeleteStore;
  storage?: Pick<BackgroundStorage, "delete">;
};
const deleteLimit = createProcessLimiter(6);

function validResult(value: unknown): value is DeletedSlot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && (row.removed === false && row.object_key === null
    || row.removed === true && typeof row.object_key === "string" && /^profile-images\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(row.object_key));
}

function deleteStore(env: NonNullable<Dependencies["env"]>, fetcher?: typeof fetch): BackgroundDeleteStore {
  const client = createSupabaseAdminClient(env, fetcher);
  return {
    async deleteSlot(owner) {
      const { data, error } = await client.rpc("delete_profile_background_slot", { p_user_id: owner.userId, p_guild_id: owner.guildId, p_slot: owner.slot });
      if (error) throw new ApiError(error.code === "55000" ? 409 : 503, error.code === "55000" ? "slot_processing" : "database_unavailable");
      if (!validResult(data)) throw new ApiError(503, "database_unavailable");
      return data;
    },
  };
}

export async function handleBackgroundDelete(request: Request, slotPath: string, dependencies: BackgroundDeleteDependencies = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "DELETE") throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "csrf");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!(dependencies.limit ?? deleteLimit)(user.id)) throw new ApiError(429, "rate_limited");
    if (!/^[123]$/.test(slotPath)) throw new ApiError(400, "invalid_slot");
    const slot = Number(slotPath);
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    if ([...params.keys()].some((key) => key !== "guildId") || params.getAll("guildId").length !== 1 || !snowflake(guildId)) throw new ApiError(400, "invalid_guild");
    verifyBotGuild(guildId, env);
    if (!snowflake(user.id) || !guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    const result = await (dependencies.store ?? deleteStore(env, dependencies.fetch)).deleteSlot({ userId: user.id, guildId, slot });
    if (!validResult(result)) throw new ApiError(503, "database_unavailable");
    if (!result.removed) return privateJson({ status: "deleted", guildId, slot, cleanupPending: false });
    let cleanupPending = false;
    try {
      await (dependencies.storage ?? backgroundStorage({ env, fetcher: dependencies.fetch })).delete(result.object_key!);
    } catch { cleanupPending = true; }
    return privateJson({ status: "deleted", guildId, slot, removed: true, cleanupPending });
  } catch (error) {
    return apiFailure(error);
  }
}
