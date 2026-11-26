import { createClient } from "@supabase/supabase-js";
import { ApiError, type Environment } from "./api-security.ts";
import { findBackground } from "./catalog.ts";
import { isCustomSlot, type CustomSlot } from "./background-policy.ts";
import { IMAGE_HEIGHT, IMAGE_WIDTH, MAX_OUTPUT_BYTES } from "./image-processing.ts";

export const imageId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export type PreferenceImage = { id: string; kind: "image"; revision: number; mime: "image/png"; width: 1000; height: 560; slot: CustomSlot; userId: string; guildId: string; objectKey: string; byteSize: number };
export const imageColumns = "id,kind,visibility,owner_user_id,owner_guild_id,slot_number,revision,status,is_active,mime,width,height,byte_size,object_key";
export function validatePreferenceImage(row: unknown, userId: string, guildId: string, id: string): PreferenceImage | null {
  if (!imageId(id) || !row || typeof row !== "object" || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (value.id !== id || value.owner_user_id !== userId || value.owner_guild_id !== guildId || value.kind !== "image" || value.visibility !== "private" || value.status !== "ready" || value.is_active !== true || !isCustomSlot(value.slot_number)) return null;
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision <= 0 || value.revision > 2 ** 31 || value.mime !== "image/png" || value.width !== IMAGE_WIDTH || value.height !== IMAGE_HEIGHT || typeof value.byte_size !== "number" || !Number.isSafeInteger(value.byte_size) || value.byte_size <= 0 || value.byte_size > MAX_OUTPUT_BYTES || typeof value.object_key !== "string" || !/^profile-images\/[a-f0-9]{32}\.png$/.test(value.object_key)) return null;
  return { id, kind: "image", revision: value.revision, mime: "image/png", width: 1000, height: 560, slot: value.slot_number, userId, guildId, objectKey: value.object_key, byteSize: value.byte_size };
}
export type PreferenceStore = {
  get(userId: string, guildId: string): Promise<string | null>;
  set(userId: string, guildId: string, backgroundId: string): Promise<void>;
  reset(userId: string, guildId: string): Promise<void>;
  resolveImage?(userId: string, guildId: string, id: string): Promise<PreferenceImage | null>;
};
export function validResolvedImage(image: PreferenceImage | null, userId: string, guildId: string, id: string): image is PreferenceImage {
  return !!image && !!validatePreferenceImage({ id: image.id, kind: image.kind, visibility: "private", owner_user_id: image.userId, owner_guild_id: image.guildId, slot_number: image.slot, revision: image.revision, status: "ready", is_active: true, mime: image.mime, width: image.width, height: image.height, byte_size: image.byteSize, object_key: image.objectKey }, userId, guildId, id);
}

if (typeof window !== "undefined") throw new Error("Server-only module");

export type SupabaseConfig = { url: string; serviceRoleKey: string };
export function supabaseConfig(env: Environment = process.env): SupabaseConfig | null {
  try {
    const url = new URL(env.SUPABASE_URL ?? "");
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !key || key.length < 20) return null;
    return { url: url.origin, serviceRoleKey: key };
  } catch { return null; }
}
export function createSupabaseAdminClient(env: Environment = process.env, fetcher: typeof fetch = fetch) {
  const config = supabaseConfig(env);
  if (!config) throw new ApiError(503, "database_unavailable");
  return createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetcher(input, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000) }) },
  });
}
export const createAdminClient = createSupabaseAdminClient;

function validDatabaseTokenShape(token: string, role = "profile_dashboard"): boolean {
  if (token.length > 8192 || /[\r\n]/.test(token)) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, "base64url").toString("base64url") !== part)) return false;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = Date.now() / 1000;
    return !!header && typeof header === "object" && !Array.isArray(header) && ["HS256", "RS256", "ES256"].includes(header.alg)
      && !!claims && typeof claims === "object" && !Array.isArray(claims) && claims.role === role
      && Number.isSafeInteger(claims.exp) && claims.exp > now
      && (claims.nbf === undefined || Number.isSafeInteger(claims.nbf) && claims.nbf <= now && claims.nbf < claims.exp);
  } catch { return false; }
}

function validPublishableKeyShape(key: string): boolean {
  if (key.length > 8192 || /[\r\n]/.test(key)) return false;
  return /^sb_publishable_[A-Za-z0-9_-]{6,8177}$/.test(key) || validDatabaseTokenShape(key, "anon");
}

export function createDatabaseClient(env: Environment = process.env, fetcher: typeof fetch = fetch) {
  const mode = env.PROFILE_DATABASE_MODE ?? (env.NODE_ENV === "production" ? undefined : "legacy");
  if (mode === "legacy" && env.NODE_ENV !== "production") return createSupabaseAdminClient(env, fetcher);
  if (mode !== "restricted") throw new ApiError(503, "database_unavailable");
  const token = env.PROFILE_DATABASE_KEY;
  const apiKey = env.SUPABASE_PUBLISHABLE_KEY;
  let url: URL;
  try { url = new URL(env.SUPABASE_URL ?? ""); }
  catch { throw new ApiError(503, "database_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !apiKey || !validPublishableKeyShape(apiKey)
    || !token || !validDatabaseTokenShape(token)) throw new ApiError(503, "database_unavailable");
  return createClient(url.origin, apiKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => token,
    global: {
      fetch: (input, init) => {
        if (!validDatabaseTokenShape(token)) throw new ApiError(503, "database_unavailable");
        const headers = new Headers(init?.headers);
        headers.set("apikey", apiKey);
        headers.set("Authorization", `Bearer ${token}`);
        return fetcher(input, { ...init, headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000) });
      },
    },
  });
}

export function preferenceStore(env: Environment = process.env, fetcher: typeof fetch = fetch): PreferenceStore {
  const client = createDatabaseClient(env, fetcher);
  const active = async (id: string): Promise<boolean> => {
    const background = findBackground(id);
    if (!background) return false;
    const { data, error } = await client.from("profile_backgrounds").select("id,asset_key,color,kind").eq("id", id).eq("is_active", true).maybeSingle();
    if (error) throw new ApiError(503, "database_unavailable");
    if (!data || data.id !== id || data.asset_key !== id) return false;
    return background.image ? data.kind === "catalog-image" && data.color === null : data.color === background.color;
  };
  const resolveImage = async (userId: string, guildId: string, id: string): Promise<PreferenceImage | null> => {
    if (!imageId(id)) return null;
    const { data, error } = await client.from("profile_backgrounds").select(imageColumns)
      .eq("id", id).eq("owner_user_id", userId).eq("owner_guild_id", guildId)
      .eq("kind", "image").eq("visibility", "private").eq("status", "ready").eq("is_active", true).maybeSingle();
    if (error) throw new ApiError(503, "database_unavailable");
    return validatePreferenceImage(data, userId, guildId, id);
  };
  return {
    resolveImage,
    async get(userId: string, guildId: string): Promise<string | null> {
      const { data, error } = await client.from("profile_preferences").select("background_id").eq("user_id", userId).eq("guild_id", guildId).maybeSingle();
      if (error) throw new ApiError(503, "database_unavailable");
      if (!data || data.background_id === null) return null;
      if (typeof data.background_id !== "string") throw new ApiError(503, "database_unavailable");
      return (imageId(data.background_id) ? await resolveImage(userId, guildId, data.background_id) : await active(data.background_id)) ? data.background_id : null;
    },
    async set(userId: string, guildId: string, backgroundId: string): Promise<void> {
      if (!(imageId(backgroundId) ? await resolveImage(userId, guildId, backgroundId) : await active(backgroundId))) throw new ApiError(400, "invalid_background");
      const { error } = await client.from("profile_preferences").upsert({ user_id: userId, guild_id: guildId, background_id: backgroundId, updated_at: new Date().toISOString() }, { onConflict: "user_id,guild_id" });
      if (error) throw new ApiError(error.code === "23514" ? 400 : 503, error.code === "23514" ? "invalid_background" : "database_unavailable");
    },
    async reset(userId: string, guildId: string): Promise<void> {
      const { error } = await client.from("profile_preferences").delete().eq("user_id", userId).eq("guild_id", guildId);
      if (error) throw new ApiError(503, "database_unavailable");
    },
  };
}
