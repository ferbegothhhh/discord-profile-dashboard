import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, privateHeaders, privateJson, snowflake, verifyBotGuild } from "./api-security.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { createDatabaseClient } from "./supabase.ts";
import { MAX_OUTPUT_BYTES } from "./image-processing.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export type ReviewRow = { id: string; owner_guild_id: string; owner_user_id: string; slot_number: number; is_active: boolean; status: string; kind: string; visibility: string; object_key?: string; byte_size?: number; mime?: string };
export type ModerationStore = {
  list(guildId: string, after: string): Promise<ReviewRow[]>;
  get(guildId: string, id: string): Promise<ReviewRow | null>;
  disable(actorId: string, guildId: string, id: string): Promise<boolean>;
};
export type ModerationDependencies = Dependencies & { store?: ModerationStore; storage?: Pick<BackgroundStorage, "download"> };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fields = "id,owner_guild_id,owner_user_id,slot_number,is_active,status,kind,visibility";

function store(env: NonNullable<Dependencies["env"]>, fetcher?: typeof fetch): ModerationStore {
  const client = createDatabaseClient(env, fetcher);
  const query = (guildId: string, media = false) => client.from("profile_backgrounds").select(media ? `${fields},object_key,byte_size,mime` : fields).eq("owner_guild_id", guildId).eq("kind", "image").eq("visibility", "private").eq("status", "ready");
  return {
    async list(guildId, after) {
      let q = query(guildId).order("id").limit(21);
      if (after) q = q.gt("id", after);
      const { data, error } = await q;
      if (error) throw new Error();
      return data as unknown as ReviewRow[];
    },
    async get(guildId, id) {
      const { data, error } = await query(guildId, true).eq("id", id).maybeSingle();
      if (error) throw new Error();
      return data as unknown as ReviewRow | null;
    },
    async disable(actorId, guildId, id) {
      const { data, error } = await client.rpc("disable_guild_background", { p_actor_id: actorId, p_guild_id: guildId, p_id: id });
      if (error || typeof data !== "boolean") throw new Error();
      return data;
    },
  };
}
function validRow(row: ReviewRow, guildId: string) {
  return row && uuid.test(row.id) && row.owner_guild_id === guildId && snowflake(row.owner_user_id) && [1, 2, 3].includes(row.slot_number) && typeof row.is_active === "boolean" && row.status === "ready" && row.kind === "image" && row.visibility === "private";
}

export async function handleModeration(request: Request, id?: string, dependencies: ModerationDependencies = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    const mutation = request.method === "POST";
    if (request.method !== "GET" && !mutation || mutation && !id) throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (mutation && (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ApiError(403, "csrf");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`background-moderation:${user.id}`, 30, env))) throw new ApiError(429, "rate_limited");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    const after = params.get("after") ?? "";
    if (!snowflake(guildId) || params.getAll("guildId").length !== 1 || [...params.keys()].some((key) => key !== "guildId" && (id || key !== "after")) || params.getAll("after").length > 1 || after && !uuid.test(after) || id !== undefined && !uuid.test(id)) throw new ApiError(400, "invalid_query");
    verifyBotGuild(guildId, env);
    if (!guilds.some((guild) => guild.id === guildId && guild.canModerate === true)) throw new ApiError(403, "guild_forbidden");
    const db = dependencies.store ?? store(env, dependencies.fetch);
    if (mutation) {
      if (!await db.disable(user.id, guildId, id!)) throw new ApiError(404, "background_not_found");
      return privateJson({ status: "disabled", guildId, id });
    }
    if (!id) {
      const rows = await db.list(guildId, after);
      if (!Array.isArray(rows) || rows.length > 21 || !rows.every((row, index) => validRow(row, guildId) && row.id > (index ? rows[index - 1].id : after))) throw new ApiError(503, "database_unavailable");
      return privateJson({ guildId, items: rows.slice(0, 20).map((row) => ({ id: row.id, ownerUserId: row.owner_user_id, slot: row.slot_number, active: row.is_active })), next: rows.length > 20 ? rows[19].id : null });
    }
    const row = await db.get(guildId, id);
    if (!row || !validRow(row, guildId) || row.id !== id) throw new ApiError(404, "background_not_found");
    if (row.mime !== "image/png" || typeof row.object_key !== "string" || !/^profile-images\/[a-f0-9]{32}\.png$/.test(row.object_key) || !Number.isSafeInteger(row.byte_size) || row.byte_size! < 8 || row.byte_size! > MAX_OUTPUT_BYTES) throw new ApiError(404, "background_not_found");
    const png = await (dependencies.storage ?? backgroundStorage({ env, fetcher: dependencies.fetch })).download(row.object_key);
    if (!Buffer.isBuffer(png) || png.length !== row.byte_size || png.length > MAX_OUTPUT_BYTES || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ApiError(503, "storage_unavailable");
    return new Response(new Uint8Array(png), { headers: { ...privateHeaders, "Content-Type": "image/png", "Content-Length": String(png.length), "Referrer-Policy": "no-referrer" } });
  } catch (error) { return apiFailure(error); }
}
