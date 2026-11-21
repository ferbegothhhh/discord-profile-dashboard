import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ApiError } from "../lib/api-security.ts";
import { cleanupBackgrounds } from "../lib/background-cleanup.ts";
import { handleCleanupCron, CRON_CLEANUP_BATCH_SIZE } from "../lib/cleanup-cron.ts";

const secret = "abcdefghijklmnopqrstuvwxyz0123456789_-";
const env = { CRON_SECRET: secret };
const request = (authorization?: string, method = "GET") => new Request("https://dashboard.invalid/api/cron/background-cleanup", { method, headers: { ...(authorization ? { authorization } : {}), cookie: "profile_session=browser-session" } });
const authorized = () => request(`Bearer ${secret}`);
const empty = { reclaimed: 0, claimed: 0, deleted: 0, acknowledged: 0, rescheduled: 0, skipped: 0, failed: 0 };

function privateResponse(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
  assert.match(response.headers.get("vary") ?? "", /Authorization/);
}

test("cron rejects missing, malformed and browser credentials before all I/O", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { assert.fail("network must not be contacted"); });
  for (const header of [undefined, "Bearer", "Basic abc", secret, `bearer ${secret}`, `Bearer ${secret}x`, `Bearer ${"x".repeat(1000)}`]) {
    const response = await handleCleanupCron(request(header), { env });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    privateResponse(response);
  }
  for (const config of [{}, { CRON_SECRET: "" }, { CRON_SECRET: "x".repeat(32) }, { ...env, PROFILE_BOT_API_KEY: secret }, { ...env, PROFILE_LEVEL_API_KEY: secret }, { ...env, SESSION_PASSWORD: secret }]) {
    const response = await handleCleanupCron(authorized(), { env: config });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "setup_required" });
    privateResponse(response);
  }
});

test("cron allows only GET and fixes workload independently of query input", async () => {
  const cleanup = async (options: Parameters<typeof cleanupBackgrounds>[0]) => {
    assert.deepEqual(options, { env, batchSize: CRON_CLEANUP_BATCH_SIZE });
    return empty;
  };
  const response = await handleCleanupCron(new Request(`${authorized().url}?batchSize=999`, { headers: authorized().headers }), { env, cleanup });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "processed", ...empty });
  privateResponse(response);
  const rejected = await handleCleanupCron(request(`Bearer ${secret}`, "POST"), { env, cleanup: async () => { assert.fail("unexpected worker"); } });
  assert.equal(rejected.status, 405);
});

test("worker exceptions and partial failures expose no upstream details", async () => {
  for (const error of [new Error(secret), new ApiError(400, secret)]) {
    const response = await handleCleanupCron(authorized(), { env, cleanup: async () => { throw error; } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "cleanup_unavailable" });
    privateResponse(response);
  }
  const response = await handleCleanupCron(authorized(), { env, cleanup: async () => ({ ...empty, failed: 1, rescheduled: 1, object_key: secret }) });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "incomplete", ...empty, failed: 1, rescheduled: 1 });
});

test("cron integrates existing leases, deletion, ack and safe failure retry without looping", async () => {
  const key = `profile-images/${"ab".repeat(16)}.png`;
  const token = "12345678-1234-4123-8123-123456789abc";
  for (const failStorage of [false, true]) {
    const calls: string[] = [];
    const cleanup: typeof cleanupBackgrounds = (options) => cleanupBackgrounds({ ...options,
      client: { async rpc(name, args) {
        calls.push(name);
        if (name === "reclaim_profile_backgrounds" || name === "claim_profile_background_cleanup") assert.equal(args.p_limit, 3);
        if (name === "fail_profile_background_cleanup") assert.equal(args.p_error, "storage_unavailable");
        return { data: name === "reclaim_profile_backgrounds" ? 0 : name === "claim_profile_background_cleanup" ? [{ object_key: key, claim_token: token }] : true, error: null };
      } },
      storage: { async delete(value) { assert.equal(value, key); if (failStorage) throw new Error(`${secret} ${key}`); } },
    });
    const response = await handleCleanupCron(authorized(), { env, cleanup });
    assert.equal(response.status, failStorage ? 503 : 200);
    const body = await response.text();
    assert.ok(!body.includes(key) && !body.includes(token) && !body.includes(secret));
    assert.deepEqual(calls, ["reclaim_profile_backgrounds", "claim_profile_background_cleanup", "check_profile_background_cleanup", failStorage ? "fail_profile_background_cleanup" : "ack_profile_background_cleanup"]);
  }
});

test("Vercel daily route configuration matches bounded Node handler", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(config.crons, [{ path: "/api/cron/background-cleanup", schedule: "0 3 * * *" }]);
  const route = await readFile(new URL("../app/api/cron/background-cleanup/route.ts", import.meta.url), "utf8");
  assert.match(route, /maxDuration = 60/);
  assert.match(route, /runtime = "nodejs"/);
  assert.match(route, /dynamic = "force-dynamic"/);
  assert.match(route, /return handleCleanupCron\(request\)/);
});
