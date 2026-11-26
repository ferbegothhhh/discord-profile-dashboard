import { authConfig, authenticatedMember, type Dependencies } from "./auth.ts";
import { ApiError, apiFailure, boundedJson, privateJson, snowflake, verifyBotGuild } from "./api-security.ts";
import { enforceRateLimit } from "./shared-rate-limit.ts";
import { achievementId, getAchievements, selectTitle } from "./profile-achievements-bot.ts";

type Options = Dependencies & { get?: typeof getAchievements; select?: typeof selectTitle };

export async function handleProfileAchievements(request: Request, dependencies: Options = {}): Promise<Response> {
  const env = dependencies.env ?? process.env;
  try {
    if (!["GET", "POST"].includes(request.method)) throw new ApiError(405, "method_not_allowed");
    const config = authConfig(env);
    if (!config) throw new ApiError(503, "setup_required");
    if (request.method === "POST" && (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site")) throw new ApiError(403, "csrf");
    const { user, guilds } = await authenticatedMember(request, config, dependencies);
    if (!await (dependencies.limit ? dependencies.limit(user.id) : enforceRateLimit(`profile-achievements:${user.id}`, 60, env))) throw new ApiError(429, "rate_limited");
    const params = new URL(request.url).searchParams;
    let guildId: unknown;
    let id: unknown;
    if (request.method === "GET") {
      if (params.size !== 1 || params.getAll("guildId").length !== 1) throw new ApiError(400, "invalid_guild");
      guildId = params.get("guildId");
    } else {
      if (params.size || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) throw new ApiError(400, "invalid_body");
      const body = await boundedJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || !("guildId" in body) || !("achievementId" in body)) throw new ApiError(400, "invalid_body");
      guildId = body.guildId;
      id = body.achievementId;
      if (!achievementId(id)) throw new ApiError(400, "invalid_achievement");
    }
    if (!snowflake(guildId)) throw new ApiError(400, "invalid_guild");
    verifyBotGuild(guildId, env);
    if (!guilds.some((guild) => guild.id === guildId)) throw new ApiError(403, "guild_forbidden");
    return privateJson(request.method === "GET" ? await (dependencies.get ?? getAchievements)(user.id, guildId, env, dependencies.fetch) : await (dependencies.select ?? selectTitle)(user.id, guildId, id as string, env, dependencies.fetch));
  } catch (error) { return apiFailure(error); }
}
