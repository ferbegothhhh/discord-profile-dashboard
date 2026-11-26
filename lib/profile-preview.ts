import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, boundedJson, privateHeaders, snowflake, verifyBotGuild } from "./api-security.ts";
import { botLevelConfig, getCurrentLevel } from "./bot-level.ts";
import { findBackground } from "./catalog.ts";
import { preferenceStore, imageId, validResolvedImage, type PreferenceStore } from "./supabase.ts";
import { backgroundStorage, type BackgroundStorage } from "./background-storage.ts";
import { canUseCustomSlot } from "./background-policy.ts";
import { MAX_OUTPUT_BYTES, IMAGE_WIDTH, IMAGE_HEIGHT } from "./image-processing.ts";
import sharp from "sharp";
import { enforceRateLimit } from "./shared-rate-limit.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type Options = Dependencies & { store?: Pick<PreferenceStore, "resolveImage">; storage?: Pick<BackgroundStorage, "download">; getLevel?: typeof getCurrentLevel };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function validPreviewPng(png: Buffer): Promise<boolean> {
  if (png.length < 33 || png.length > MAX_OUTPUT_BYTES || !png.subarray(0, 8).equals(signature)
      || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR"
      || png.readUInt32BE(16) !== IMAGE_WIDTH || png.readUInt32BE(20) !== IMAGE_HEIGHT) return false;
  try {
    const result = await sharp(png, { limitInputPixels: IMAGE_WIDTH * IMAGE_HEIGHT, failOn: "warning" }).raw().toBuffer({ resolveWithObject: true });
    return result.info.width === IMAGE_WIDTH && result.info.height === IMAGE_HEIGHT;
  } catch { return false; }
}

export async function handleProfilePreview(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, request.signal]);
  const originalFetch = dependencies.fetch ?? fetch;
  const fetcher: typeof fetch = (input, init) => originalFetch(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = async () => {
      if (request.method !== "POST") throw new ApiError(405, "method_not_allowed");
      const config = authConfig(env);
      if (!config) throw new ApiError(503, "setup_required");
      if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "csrf");
      const { user, guilds } = await authenticatedMember(request, config, { ...dependencies, fetch: fetcher });
      if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`profile-preview:${user.id}`, 6, env))) throw new ApiError(429, "rate_limited");
      if (new URL(request.url).search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "invalid_body");
      const body = await boundedJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "backgroundId,guildId,revision") throw new ApiError(400, "invalid_body");
      const { guildId, backgroundId, revision } = body as Record<string, unknown>;
      if (!snowflake(guildId)) throw new ApiError(400, "invalid_guild");
      verifyBotGuild(guildId, env);
      if (!guilds.some(guild => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
      const bot = botLevelConfig(env);
      if (!bot) throw new ApiError(503, "preview_unavailable");
      let background: unknown = null;
      if (imageId(backgroundId)) {
        const image = await (dependencies.store ?? preferenceStore(env, fetcher)).resolveImage?.(user.id, guildId, backgroundId) ?? null;
        if (!validResolvedImage(image, user.id, guildId, backgroundId) || image.revision !== revision) throw new ApiError(400, "invalid_background");
        const snapshot = await (dependencies.getLevel ?? getCurrentLevel)(user.id, guildId, env, fetcher);
        if (!canUseCustomSlot(snapshot, user.id, guildId, image.slot)) throw new ApiError(403, "slot_locked");
        const png = await (dependencies.storage ?? backgroundStorage({ env, fetcher })).download(image.objectKey);
        if (!Buffer.isBuffer(png) || png.length !== image.byteSize || !await validPreviewPng(png)) throw new ApiError(503, "storage_unavailable");
        background = { id: image.id, kind: "image", revision: image.revision, slot: image.slot, base64: png.toString("base64") };
      } else {
        if (revision !== null) throw new ApiError(400, "invalid_background");
        if (backgroundId !== null) {
          const catalog = findBackground(backgroundId);
          if (!catalog?.image) throw new ApiError(400, "invalid_background");
          background = { id: catalog.id, kind: "catalog-image" };
        }
      }
      signal.throwIfAborted();
      const response = await fetcher(new URL("/api/profile-preview", bot.origin), {
        method: "POST", headers: { Authorization: `Bearer ${bot.apiKey}`, "Content-Type": "application/json", Accept: "image/png" },
        body: JSON.stringify({ userId: user.id, guildId, background }), redirect: "error", cache: "no-store", signal,
      });
      reader = response.body?.getReader();
      if (!response.ok || response.redirected || response.headers.get("content-type") !== "image/png" || !reader) throw new ApiError(response.status === 403 ? 403 : 503, "preview_unavailable");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_OUTPUT_BYTES)) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_OUTPUT_BYTES) throw new Error();
        chunks.push(value);
      }
      const png = Buffer.concat(chunks);
      if (!await validPreviewPng(png)) throw new Error();
      signal.throwIfAborted();
      return new Response(new Uint8Array(png), { headers: { ...privateHeaders, "Content-Type": "image/png", "Content-Length": String(png.length) } });
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new ApiError(503, "preview_unavailable")); }, 20000);
    })]);
  } catch (error) { return apiFailure(error); }
  finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
}
