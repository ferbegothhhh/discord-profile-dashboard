import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError } from "../lib/api-security.ts";
import { createSharedRateLimiter, enforceRateLimit } from "../lib/shared-rate-limit.ts";

const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "rate_limit_unavailable";
const database = { NODE_ENV: "production", PROFILE_RATE_LIMIT_BACKEND: "database" };

test("local limiter caches buckets, isolates limits and expires without a database", async () => {
  let time = 0;
  const limit = createSharedRateLimiter({ now: () => time, createClient: () => { throw new Error("Database must not be used"); } });
  assert.equal(await limit("route:user", 1, {}), true);
  assert.equal(await limit("route:user", 1, {}), false);
  assert.equal(await limit("route:user", 2, {}), true);
  assert.equal(await limit("other:user", 1, {}), true);
  time = 60000;
  assert.equal(await limit("route:user", 1, {}), true);
  assert.equal(await enforceRateLimit("export:test", 1, { NODE_ENV: "test" }), true);
});

test("backend selection fails closed in production and on invalid configuration", async () => {
  const limit = createSharedRateLimiter({ createClient: () => { throw new Error(); } });
  for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", PROFILE_RATE_LIMIT_BACKEND: "local" }, { PROFILE_RATE_LIMIT_BACKEND: "redis" }, { PROFILE_RATE_LIMIT_BACKEND: "" }, database]) {
    await assert.rejects(limit("key", 1, env), unavailable);
  }
  for (const max of [0, -1, 1.5, NaN, Infinity, 2147483648]) await assert.rejects(limit("key", max, {}), unavailable);
  for (const key of ["", "a".repeat(8193)]) await assert.rejects(limit(key, 1, {}), unavailable);
});

test("database RPC hashes identifying keys, namespaces limits and preserves boolean decisions", async () => {
  const calls: { p_key: string; p_limit: number }[] = [];
  const limit = createSharedRateLimiter({ createClient: (env) => {
    assert.equal(env, database);
    return { rpc: async (name, args) => {
      assert.equal(name, "consume_profile_rate_limit");
      calls.push(args);
      return { data: calls.length === 1, error: null };
    } };
  } });
  assert.equal(await limit("route:private-user", 2, database), true);
  assert.equal(await limit("route:private-user", 2, database), false);
  assert.equal(await limit("route:private-user", 3, database), false);
  assert.deepEqual(calls[0], { p_key: createHash("sha256").update(JSON.stringify([2, "route:private-user"])).digest("hex"), p_limit: 2 });
  assert.equal(calls[0].p_key, calls[1].p_key);
  assert.notEqual(calls[0].p_key, calls[2].p_key);
  assert.ok(!JSON.stringify(calls).includes("private-user"));
});

test("database failures and malformed results never fall back to local", async () => {
  for (const data of [null, undefined, "true", 1, [], { allowed: true }]) {
    const limit = createSharedRateLimiter({ createClient: () => ({ rpc: async () => ({ data, error: null }) }) });
    await assert.rejects(limit("key", 1, database), unavailable);
  }
  for (const rpc of [async () => ({ data: true, error: { message: "secret" } }), async () => { throw new Error("secret"); }]) {
    const limit = createSharedRateLimiter({ createClient: () => ({ rpc }) });
    await assert.rejects(limit("key", 1, database), unavailable);
  }
});

test("separate limiter instances share database decisions instead of resetting counters", async () => {
  const counts = new Map<string, number>();
  const createClient = () => ({ rpc: async (_name: string, { p_key, p_limit }: { p_key: string; p_limit: number }) => {
    const count = (counts.get(p_key) ?? 0) + 1;
    counts.set(p_key, count);
    return { data: count <= p_limit, error: null };
  } });
  const first = createSharedRateLimiter({ createClient });
  const second = createSharedRateLimiter({ createClient });
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second)("shared", 3, database))), [true, true, true, ...Array(17).fill(false)]);
});

test("local storage rejects new keys and limit variants at capacity", async () => {
  const limit = createSharedRateLimiter();
  for (let i = 0; i < 2000; i++) assert.equal(await limit(`key:${i}`, 1, {}), true);
  assert.equal(await limit("overflow", 1, {}), false);
  for (let max = 2; max <= 64; max++) assert.equal(await limit("key", max, {}), true);
  assert.equal(await limit("key", 65, {}), false);
});

test("migration statically enforces atomic admission, bounded cleanup, fixed windows and restricted access", () => {
  const sql = readFileSync(new URL("../supabase/migrations/202611220002_shared_rate_limit.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /update public\.profile_rate_limit_state set entries = entries where id = true\s+returning entries into strict v_entries/i);
  assert.match(sql, /date_trunc\('minute', pg_catalog\.clock_timestamp\(\)\)/);
  assert.match(sql, /create index profile_rate_limits_expiry_idx .*\(window_start\)/);
  assert.match(sql, /window_start < v_window - interval '2 minutes'\s+order by window_start limit 100/);
  assert.match(sql, /v_entries >= 100000 then\s+return false/);
  assert.match(sql, /v_hits >= p_limit then\s+return false/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.profile_rate_limit_state, public\.profile_rate_limits from public, anon, authenticated, service_role/);
  assert.match(sql, /revoke all on function .* from public, anon, authenticated/);
  assert.match(sql, /grant execute on function .* to service_role/);
  assert.match(sql, /if exists .*rolname = 'profile_dashboard'/);
  assert.match(sql, /revoke all on public\.profile_rate_limit_state, public\.profile_rate_limits from profile_dashboard/);
  assert.match(sql, /grant execute on function .* to profile_dashboard/);
});
