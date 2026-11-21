import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, privateJson, type Environment } from "./api-security.ts";
import { cleanupBackgrounds, type CleanupOptions } from "./background-cleanup.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export const CRON_CLEANUP_BATCH_SIZE = 3;
type Dependencies = { env?: Environment; cleanup?: typeof cleanupBackgrounds };

export async function handleCleanupCron(request: Request, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const secret = env.CRON_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || new Set(secret).size < 16
    || secret === env.PROFILE_BOT_API_KEY || secret === env.PROFILE_LEVEL_API_KEY || secret === env.SESSION_PASSWORD) {
    return privateJson({ error: "setup_required" }, 503);
  }
  const provided = request.headers.get("authorization") ?? "";
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(provided.length <= 300 ? provided : "").digest();
  if (!timingSafeEqual(expected, actual)) return privateJson({ error: "unauthorized" }, 401);
  if (request.method !== "GET") return privateJson({ error: "method_not_allowed" }, 405);
  try {
    const options: CleanupOptions = { env, batchSize: CRON_CLEANUP_BATCH_SIZE };
    const counts = await (dependencies.cleanup ?? cleanupBackgrounds)(options);
    const summary = {
      reclaimed: counts.reclaimed, claimed: counts.claimed, deleted: counts.deleted,
      acknowledged: counts.acknowledged, rescheduled: counts.rescheduled, skipped: counts.skipped, failed: counts.failed,
    };
    if (Object.values(summary).some((value) => !Number.isInteger(value) || value < 0 || value > CRON_CLEANUP_BATCH_SIZE)) throw new ApiError(503, "cleanup_unavailable");
    const incomplete = summary.failed > 0 || summary.skipped > 0;
    return privateJson({ status: incomplete ? "incomplete" : "processed", ...summary }, incomplete ? 503 : 200);
  } catch {
    return privateJson({ error: "cleanup_unavailable" }, 503);
  }
}
