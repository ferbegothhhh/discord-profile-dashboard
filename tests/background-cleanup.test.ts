import assert from "node:assert/strict";
import test from "node:test";
import { cleanupBackgrounds } from "../lib/background-cleanup.ts";

const key = `profile-images/${"ab".repeat(16)}.png`;
const token = "12345678-1234-4123-8123-123456789abc";
const job = { object_key: key, claim_token: token };
function fixture(overrides: Record<string, unknown> = {}, jobs: unknown[] = [job]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const results: Record<string, unknown> = {
    reclaim_profile_backgrounds: 0,
    claim_profile_background_cleanup: jobs,
    check_profile_background_cleanup: true,
    ack_profile_background_cleanup: true,
    fail_profile_background_cleanup: true,
    ...overrides,
  };
  const client = { async rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args });
    if (results[name] instanceof Error) throw results[name];
    return { data: results[name], error: null };
  } };
  const storage = { async delete(value: string) { deleted.push(value); } };
  return { client, storage, calls, deleted };
}

test("cleanup defaults to twenty, deletes before token-bound acknowledgement", async () => {
  const f = fixture({ reclaim_profile_backgrounds: 2 });
  const counts = await cleanupBackgrounds(f);
  assert.deepEqual(counts, { reclaimed: 2, claimed: 1, deleted: 1, acknowledged: 1, rescheduled: 0, skipped: 0, failed: 0 });
  assert.deepEqual(f.deleted, [key]);
  assert.deepEqual(f.calls.map((c) => c.name), ["reclaim_profile_backgrounds", "claim_profile_background_cleanup", "check_profile_background_cleanup", "ack_profile_background_cleanup"]);
  assert.deepEqual(f.calls[0].args, { p_limit: 20 });
  assert.deepEqual(f.calls[1].args, { p_limit: 20 });
  assert.deepEqual(f.calls[3].args, { p_object_key: key, p_claim_token: token });
});

test("invalid rows and tokens never reach storage or acknowledgement", async () => {
  for (const invalid of [null, {}, { ...job, object_key: "../secret" }, { ...job, claim_token: "invalid" }, { ...job, extra: true }]) {
    const f = fixture({}, [invalid]);
    const counts = await cleanupBackgrounds(f);
    assert.equal(counts.skipped, 1);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.calls.length, 2);
  }
});

test("live, expired or replaced claims are skipped before storage", async () => {
  for (const result of [false, null, "true"]) {
    const f = fixture({ check_profile_background_cleanup: result });
    assert.equal((await cleanupBackgrounds(f)).skipped, 1);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.calls.length, 3);
  }
});

test("storage failure releases only the matching lease using a safe error code", async () => {
  const f = fixture();
  f.storage.delete = async () => { throw new Error("credentials and object path must not escape"); };
  const counts = await cleanupBackgrounds(f);
  assert.equal(counts.failed, 1);
  assert.equal(counts.rescheduled, 1);
  assert.equal(counts.acknowledged, 0);
  assert.deepEqual(f.calls.at(-1), { name: "fail_profile_background_cleanup", args: { p_object_key: key, p_claim_token: token, p_error: "storage_unavailable" } });
});

test("ack refusal preserves queue ownership and is not retried with another token", async () => {
  const f = fixture({ ack_profile_background_cleanup: false });
  const counts = await cleanupBackgrounds(f);
  assert.equal(counts.deleted, 1);
  assert.equal(counts.acknowledged, 0);
  assert.equal(counts.skipped, 1);
  assert.equal(f.calls.length, 4);
});

test("ack transport failure reschedules for idempotent storage deletion", async () => {
  const f = fixture({ ack_profile_background_cleanup: new Error("network") });
  const counts = await cleanupBackgrounds(f);
  assert.equal(counts.deleted, 1);
  assert.equal(counts.rescheduled, 1);
  assert.equal(f.calls.at(-1)?.args.p_error, "cleanup_unavailable");
});

test("claim failure never reaches storage and exposes only a safe error", async () => {
  const f = fixture({ claim_profile_background_cleanup: new Error("secret") });
  await assert.rejects(cleanupBackgrounds(f), (error: unknown) => error instanceof Error && !error.message.includes("secret"));
  assert.deepEqual(f.deleted, []);
});

test("failed release leaves the lease for recovery and processing continues", async () => {
  const f = fixture({ fail_profile_background_cleanup: new Error("offline") }, [job, { object_key: key.replace("ab", "cd"), claim_token: token }]);
  f.storage.delete = async () => { throw new Error(); };
  const counts = await cleanupBackgrounds(f);
  assert.equal(counts.failed, 2);
  assert.equal(counts.rescheduled, 0);
});

test("batch limits and malformed RPC responses fail closed", async () => {
  for (const batchSize of [0, 21, 1.5, NaN]) {
    const f = fixture();
    await assert.rejects(cleanupBackgrounds({ ...f, batchSize }));
    assert.equal(f.calls.length, 0);
  }
  for (const overrides of [{ reclaim_profile_backgrounds: -1 }, { claim_profile_background_cleanup: null }, { claim_profile_background_cleanup: Array(21).fill(job) }]) {
    const f = fixture(overrides);
    await assert.rejects(cleanupBackgrounds(f));
    assert.deepEqual(f.deleted, []);
  }
});

test("default storage adapter deletes only the claimed key and treats missing objects idempotently", async (t) => {
  for (const status of [200, 404, 503]) {
    const requests: { url: string; body: unknown }[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/reclaim_profile_backgrounds")) return Response.json(0);
      if (url.endsWith("/claim_profile_background_cleanup")) return Response.json([job]);
      if (url.includes("/rest/v1/rpc/")) return Response.json(true);
      return status === 200 ? Response.json([]) : Response.json({ statusCode: String(status), error: "failure", message: "private details" }, { status });
    });
    const counts = await cleanupBackgrounds({ env: { SUPABASE_URL: "https://storage.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-real" } });
    const deletion = requests.find((r) => r.url.includes("/storage/v1/object/"));
    assert.deepEqual(deletion, { url: "https://storage.example.test/storage/v1/object/profile-backgrounds", body: { prefixes: [key] } });
    assert.equal(counts.acknowledged, status === 503 ? 0 : 1);
    assert.equal(counts.rescheduled, status === 503 ? 1 : 0);
    t.mock.restoreAll();
  }
});

test("duplicate jobs are not deleted twice and legacy queued keys are supported", async () => {
  const f = fixture({}, [job, job, { object_key: key.replace(".png", ".webp"), claim_token: token }]);
  const counts = await cleanupBackgrounds({ ...f, batchSize: 3 });
  assert.equal(counts.deleted, 2);
  assert.equal(counts.skipped, 1);
  assert.equal(f.calls[1].args.p_limit, 3);
});
