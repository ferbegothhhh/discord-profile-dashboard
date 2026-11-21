import { randomBytes, randomUUID } from "node:crypto";
import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, createProcessLimiter, privateJson, snowflake, verifyBotGuild } from "./api-security.ts";
import { canUseCustomSlot, isCustomSlot } from "./background-policy.ts";
import { getCurrentLevel } from "./bot-level.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { IMAGE_HEIGHT, IMAGE_WIDTH, ImageProcessingError, MAX_IMAGE_BYTES, MAX_OUTPUT_BYTES, processImage, readImageStream } from "./image-processing.ts";
import { createSupabaseAdminClient } from "./supabase.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type Reservation = { id: string; object_key: string; revision: number };
type Owner = { userId: string; guildId: string; slot: number };
export type BackgroundUploadStore = {
  reserve(owner: Owner, reservation: Reservation): Promise<Reservation>;
  finalize(owner: Owner, reservation: Reservation, bytes: number, level: number): Promise<void>;
  abort(owner: Owner, reservation: Reservation): Promise<string>;
};
export type BackgroundUploadDependencies = Dependencies & {
  getLevel?: typeof getCurrentLevel;
  store?: BackgroundUploadStore;
  storage?: Pick<BackgroundStorage, "upload" | "delete">;
};
const uploadLimit = createProcessLimiter(6);

function uploadStore(env: NonNullable<Dependencies["env"]>, fetcher?: typeof fetch): BackgroundUploadStore {
  const client = createSupabaseAdminClient(env, fetcher);
  const args = (owner: Owner, reservation: Reservation) => ({ p_user_id: owner.userId, p_guild_id: owner.guildId, p_slot: owner.slot, p_id: reservation.id, p_object_key: reservation.object_key, p_revision: reservation.revision });
  return {
    async reserve(owner, reservation) {
      const { data, error } = await client.rpc("reserve_profile_background", args(owner, reservation));
      if (error) throw new ApiError(error.code === "23505" ? 409 : 503, error.code === "23505" ? "slot_occupied" : "database_unavailable");
      if (!Array.isArray(data) || data.length !== 1) throw new ApiError(503, "database_unavailable");
      return data[0] as Reservation;
    },
    async finalize(owner, reservation, bytes, level) {
      const { error } = await client.rpc("finalize_profile_background", { ...args(owner, reservation), p_mime: "image/png", p_width: IMAGE_WIDTH, p_height: IMAGE_HEIGHT, p_byte_size: bytes, p_level: level });
      if (error) throw new ApiError(503, "database_unavailable");
    },
    async abort(owner, reservation) {
      const { data, error } = await client.rpc("abort_profile_background", args(owner, reservation));
      if (error || data !== reservation.object_key) throw new ApiError(503, "database_unavailable");
      return data;
    },
  };
}

export async function handleBackgroundUpload(request: Request, slotPath: string, dependencies: BackgroundUploadDependencies = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  let pending: { owner: Owner; reservation: Reservation; store: BackgroundUploadStore; storage: Pick<BackgroundStorage, "upload" | "delete"> } | undefined;
  try {
    if (request.method !== "PUT") throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "csrf");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!(dependencies.limit ?? uploadLimit)(user.id)) throw new ApiError(429, "rate_limited");
    if (!/^[123]$/.test(slotPath)) throw new ApiError(400, "invalid_slot");
    const slot = Number(slotPath);
    if (!isCustomSlot(slot)) throw new ApiError(400, "invalid_slot");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guildId");
    if ([...params.keys()].some((key) => key !== "guildId") || params.getAll("guildId").length !== 1 || !snowflake(guildId)) throw new ApiError(400, "invalid_guild");
    verifyBotGuild(guildId, env);
    if (!snowflake(user.id) || !guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    const level = async () => {
      const snapshot = await (dependencies.getLevel ?? getCurrentLevel)(user.id, guildId, env, dependencies.fetch);
      if (!snapshot || snapshot.userId !== user.id || snapshot.guildId !== guildId || !Number.isSafeInteger(snapshot.level) || snapshot.level < 0) throw new ApiError(503, "level_unavailable");
      if (!canUseCustomSlot(snapshot, user.id, guildId, slot)) throw new ApiError(403, "slot_locked");
      return snapshot.level;
    };
    await level();
    const contentType = request.headers.get("content-type") ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new ApiError(415, "unsupported_image");
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) throw new ApiError(413, "image_too_large");
    if (!request.body) throw new ApiError(400, "invalid_image");
    const store = dependencies.store ?? uploadStore(env, dependencies.fetch);
    const storage = dependencies.storage ?? backgroundStorage({ env, fetcher: dependencies.fetch });
    const owner = { userId: user.id, guildId, slot };
    const reservation = { id: randomUUID(), object_key: `profile-images/${randomBytes(16).toString("hex")}.png`, revision: 1 };
    pending = { owner, reservation, store, storage };
    const reserved = await store.reserve(owner, reservation);
    if (reserved.id !== reservation.id || reserved.object_key !== reservation.object_key || reserved.revision !== 1) throw new ApiError(503, "database_unavailable");
    const png = await processImage(await readImageStream(request.body), contentType);
    if (png.length > MAX_OUTPUT_BYTES) throw new ApiError(503, "invalid_image_output");
    const uploaded = await storage.upload(png, reservation.object_key);
    if (uploaded.object_key !== reservation.object_key) throw new ApiError(503, "storage_unavailable");
    const currentLevel = await level();
    await store.finalize(owner, reservation, png.length, currentLevel);
    pending = undefined;
    return privateJson({ status: "ready", guildId, slot, background: { id: reservation.id, name: `Background pribadi ${slot}`, status: "ready", revision: reservation.revision + 1, isActive: true } }, 201);
  } catch (error) {
    if (pending) {
      try {
        const key = await pending.store.abort(pending.owner, pending.reservation);
        if (key === pending.reservation.object_key) await pending.storage.delete(key);
      } catch {}
    }
    if (error instanceof ImageProcessingError) {
      const status = error.code === "image_too_large" ? 413 : error.code === "image_busy" ? 503 : error.code === "unsupported_image" ? 415 : 400;
      return apiFailure(new ApiError(status, error.code));
    }
    return apiFailure(error);
  }
}
