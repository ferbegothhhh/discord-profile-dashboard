import { createHash } from "node:crypto";
import { ApiError, createProcessLimiter, type Environment } from "./api-security.ts";

type RateLimitClient = {
  rpc(name: "consume_profile_rate_limit", args: { p_key: string; p_limit: number }): PromiseLike<{ data: unknown; error: unknown }>;
};
type Dependencies = {
  createClient?: (env: Environment) => RateLimitClient | Promise<RateLimitClient>;
  now?: () => number;
};

export function createSharedRateLimiter({ createClient = async (env) => (await import("./supabase.ts")).createDatabaseClient(env), now = Date.now }: Dependencies = {}) {
  const local = new Map<number, ReturnType<typeof createProcessLimiter>>();
  return async (key: string, max: number, env: Environment = process.env): Promise<boolean> => {
    if (typeof key !== "string" || !key.length || key.length > 8192 || !Number.isInteger(max) || max < 1 || max > 2147483647) throw new ApiError(503, "rate_limit_unavailable");
    const backend = env.PROFILE_RATE_LIMIT_BACKEND ?? (env.NODE_ENV === "production" ? undefined : "local");
    if ((backend !== "database" && backend !== "local") || (env.NODE_ENV === "production" && backend !== "database")) throw new ApiError(503, "rate_limit_unavailable");
    const digest = createHash("sha256").update(JSON.stringify([max, key])).digest("hex");
    if (backend === "local") {
      let limiter = local.get(max);
      if (!limiter) {
        if (local.size >= 64) return false;
        limiter = createProcessLimiter(max, 2000, now);
        local.set(max, limiter);
      }
      return limiter(digest);
    }
    try {
      const client = await createClient(env);
      const { data, error } = await client.rpc("consume_profile_rate_limit", { p_key: digest, p_limit: max });
      if (error || typeof data !== "boolean") throw new Error();
      return data;
    } catch {
      throw new ApiError(503, "rate_limit_unavailable");
    }
  };
}

export const enforceRateLimit: (key: string, max: number, env?: Environment) => Promise<boolean> = createSharedRateLimiter();
