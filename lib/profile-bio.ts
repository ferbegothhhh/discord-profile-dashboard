import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, boundedJson, privateJson, snowflake, verifyBearer } from "./api-security.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";
import { bioStore, validBio, type BioStore } from "./profile-bio-store.ts";

type Options = Dependencies & { store?: BioStore };

export async function handleProfileBio(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (!["GET", "POST", "DELETE"].includes(request.method)) throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (request.method !== "GET" && (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ApiError(403, "csrf");
    const { user } = await authenticatedMember(request, config, { ...dependencies, freshDiscord: request.method !== "GET" });
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`profile-bio:${user.id}`, 60, env))) throw new ApiError(429, "rate_limited");
    if (new URL(request.url).searchParams.size) throw new ApiError(400, "invalid_input");
    const store = dependencies.store ?? bioStore(env, dependencies.fetch);
    if (request.method === "GET") return privateJson({ status: "ready", bio: await store.get(user.id) });
    if (request.method === "DELETE") {
      await store.delete(user.id);
      return privateJson({ status: "deleted", bio: null });
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "invalid_body");
    const body = await boundedJson(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("bio" in body) || !validBio(body.bio)) throw new ApiError(400, "invalid_bio");
    await store.set(user.id, body.bio);
    return privateJson({ status: "saved", bio: body.bio });
  } catch (error) { return apiFailure(error); }
}

export async function handleBotProfileBio(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (request.method !== "GET") throw new ApiError(405, "method_not_allowed");
    verifyBearer(request, env);
    if (!await (dependencies.limit ? dependencies.limit("bot") : enforceRateLimit("bot-profile-bio:bot", 120, env))) throw new ApiError(429, "rate_limited");
    const params = new URL(request.url).searchParams;
    const userId = params.get("userId");
    if (params.size !== 1 || params.getAll("userId").length !== 1 || !snowflake(userId)) throw new ApiError(400, "invalid_user");
    return privateJson({ status: "ready", userId, bio: await (dependencies.store ?? bioStore(env, dependencies.fetch)).get(userId) });
  } catch (error) { return apiFailure(error); }
}
