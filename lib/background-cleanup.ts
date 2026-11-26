import { ApiError, type Environment } from "./api-security.ts";
import { BACKGROUND_BUCKET, type BackgroundStorage } from "./background-storage.ts";
import { createDatabaseClient, createAdminClient, supabaseConfig } from "./supabase.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
type Job = { object_key: string; claim_token: string };
export type CleanupOptions = {
  env?: Environment;
  fetch?: typeof fetch;
  batchSize?: number;
  client?: RpcClient;
  storage?: Pick<BackgroundStorage, "delete">;
};
const keyPattern = /^profile-images\/[a-f0-9]{32}\.(png|jpg|webp)$/;
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validJob(value: unknown): value is Job {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.object_key === "string" && keyPattern.test(row.object_key)
    && typeof row.claim_token === "string" && tokenPattern.test(row.claim_token);
}

export async function cleanupBackgrounds(options: CleanupOptions = {}) {
  const batchSize = options.batchSize ?? 20;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new ApiError(400, "invalid_batch_size");
  const env = options.env ?? process.env;
  let database: RpcClient | undefined;
  let admin: ReturnType<typeof createAdminClient> | undefined;

  const config = supabaseConfig(env);
  const client: RpcClient = options.client ?? {
    rpc(name, args) {
      database ??= createDatabaseClient(env, options.fetch);
      return database.rpc(name, args);
    },
  };
  const storage = options.storage ?? {
    async delete(key: string) {
      if (!config) throw new ApiError(503, "storage_unavailable");
      admin ??= createAdminClient(env, options.fetch);
      const { error } = await admin.storage.from(BACKGROUND_BUCKET).remove([key]);
      if (error && String(error.statusCode ?? error) !== "404") throw new ApiError(503, "storage_unavailable");
    },
  };
  const counts = { reclaimed: 0, claimed: 0, deleted: 0, acknowledged: 0, rescheduled: 0, skipped: 0, failed: 0 };
  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      const result = await client.rpc(name, args);
      if (result.error) throw new Error();
      return result.data;
    } catch { throw new ApiError(503, "cleanup_unavailable"); }
  }
  const reclaimed = await rpc("reclaim_profile_backgrounds", { p_limit: batchSize });
  if (typeof reclaimed !== "number" || !Number.isInteger(reclaimed) || reclaimed < 0 || reclaimed > batchSize) throw new ApiError(503, "cleanup_unavailable");
  counts.reclaimed = reclaimed;
  const jobs = await rpc("claim_profile_background_cleanup", { p_limit: batchSize });
  if (!Array.isArray(jobs) || jobs.length > batchSize) throw new ApiError(503, "cleanup_unavailable");
  counts.claimed = jobs.length;
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!validJob(job) || seen.has(job.object_key)) { counts.skipped++; continue; }
    seen.add(job.object_key);
    const args = { p_object_key: job.object_key, p_claim_token: job.claim_token };
    let failure = "cleanup_unavailable";
    try {
      if (await rpc("check_profile_background_cleanup", args) !== true) { counts.skipped++; continue; }
      failure = "storage_unavailable";
      await storage.delete(job.object_key);
      counts.deleted++;
      failure = "cleanup_unavailable";
      if (await rpc("ack_profile_background_cleanup", args) === true) counts.acknowledged++;
      else counts.skipped++;
    } catch {
      counts.failed++;
      try {
        if (await rpc("fail_profile_background_cleanup", { ...args, p_error: failure }) === true) counts.rescheduled++;
      } catch {}
    }
  }
  return counts;
}
