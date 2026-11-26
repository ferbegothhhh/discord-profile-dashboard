import assert from "node:assert/strict";
import test from "node:test";
import { supabaseConfig, preferenceStore, validatePreferenceImage, createDatabaseClient, createAdminClient } from "../lib/supabase.ts";
import { cleanupBackgrounds } from "../lib/background-cleanup.ts";
import { readFileSync } from "node:fs";

const user = "123456789012345678";
const guild = "223456789012345678";
const id = "12345678-1234-4234-8234-123456789abc";
const row = { id, kind: "image", visibility: "private", owner_user_id: user, owner_guild_id: guild, slot_number: 1, revision: 1, status: "ready", is_active: true, mime: "image/png", width: 1000, height: 560, byte_size: 8, object_key: `profile-images/${"a".repeat(32)}.png` };

test("image metadata fails closed on ownership, activation and malformed media", () => {
  assert.ok(validatePreferenceImage(row, user, guild, id));
  for (const change of [{ owner_user_id: guild }, { owner_guild_id: user }, { visibility: "catalog" }, { status: "processing" }, { is_active: false }, { slot_number: 0 }, { slot_number: 4 }, { revision: 0 }, { byte_size: 0 }, { width: 999 }, { object_key: "https://external.example/a.png" }]) assert.equal(validatePreferenceImage({ ...row, ...change }, user, guild, id), null);
});

test("image preference database reads and writes filter private owner and validate rows", async () => {
  for (const valid of [true, false]) {
    let writes = 0;
    const store = preferenceStore({ SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" }, (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") { writes++; return new Response(null, { status: 204 }); }
      if (url.pathname.includes("profile_preferences")) return Response.json({ background_id: id });
      for (const [key, value] of Object.entries({ id, owner_user_id: user, owner_guild_id: guild, kind: "image", visibility: "private", status: "ready", is_active: "true" })) assert.equal(url.searchParams.get(key), `eq.${value}`);
      return Response.json(valid ? row : { ...row, owner_user_id: guild });
    }) as typeof fetch);
    assert.equal(await store.get(user, guild), valid ? id : null);
    if (valid) await store.set(user, guild, id);
    else await assert.rejects(store.set(user, guild, id));
    assert.equal(writes, valid ? 1 : 0);
  }
});

const tokenShape = (claims: Record<string, unknown> = {}, alg = "HS256") => [
  { alg, typ: "JWT" }, { role: "profile_dashboard", exp: Math.floor(Date.now() / 1000) + 3600, ...claims },
].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).concat(Buffer.from("unverified-test-signature").toString("base64url")).join(".");
const restricted = () => ({ NODE_ENV: "production", PROFILE_DATABASE_MODE: "restricted", SUPABASE_URL: "https://database.example", PROFILE_DATABASE_KEY: tokenShape(), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-not-real-12345", SUPABASE_SERVICE_ROLE_KEY: "storage-service-key-not-real-12345" });

test("unverified token shape config uses separate fixed headers for tables and RPCs", async () => {
  const env = restricted();
  const paths: string[] = [];
  const client = createDatabaseClient(env, (async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${env.PROFILE_DATABASE_KEY}`);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    return Response.json([]);
  }) as typeof fetch);
  await client.from("profile_backgrounds").select("id");
  await client.rpc("reclaim_profile_backgrounds", { p_limit: 1 });
  assert.deepEqual(paths, ["/rest/v1/profile_backgrounds", "/rest/v1/rpc/reclaim_profile_backgrounds"]);
});

test("restricted config never falls back to service credentials", () => {
  for (const patch of [
    { PROFILE_DATABASE_KEY: "" }, { SUPABASE_PUBLISHABLE_KEY: "" }, { SUPABASE_URL: "http://database.example" },
    { PROFILE_DATABASE_KEY: tokenShape({ role: "service_role" }) }, { PROFILE_DATABASE_KEY: tokenShape({ role: "anon" }) },
    { PROFILE_DATABASE_KEY: tokenShape({ exp: 0 }) }, { PROFILE_DATABASE_KEY: tokenShape({ exp: "9999999999" }) },
    { PROFILE_DATABASE_KEY: tokenShape({ nbf: Math.floor(Date.now() / 1000) + 600 }) },
    { PROFILE_DATABASE_KEY: tokenShape({ nbf: "0" }) }, { PROFILE_DATABASE_KEY: tokenShape({}, "none") },
    { PROFILE_DATABASE_KEY: "malformed" }, { PROFILE_DATABASE_MODE: "other" }, { PROFILE_DATABASE_MODE: "legacy" },
  ]) assert.throws(() => createDatabaseClient({ ...restricted(), ...patch }), /database_unavailable/);
  assert.throws(() => createDatabaseClient({ ...restricted(), PROFILE_DATABASE_MODE: undefined }), /database_unavailable/);
  assert.doesNotThrow(() => createDatabaseClient({ SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "local-service-key-not-real" }));
  assert.doesNotThrow(() => createDatabaseClient({ ...restricted(), PROFILE_DATABASE_KEY: tokenShape({ nbf: 0 }) }));
});

test("publishable key shape accepts only bounded publishable keys or unverified anon JWTs", async () => {
  for (const key of ["sb_publishable_test-not-real-12345", tokenShape({ role: "anon" }), `sb_publishable_${"a".repeat(8177)}`]) {
    const env = { ...restricted(), SUPABASE_PUBLISHABLE_KEY: key };
    let calls = 0;
    const client = createDatabaseClient(env, (async (_input, init) => {
      calls++;
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("apikey"), key);
      assert.equal(headers.get("authorization"), `Bearer ${env.PROFILE_DATABASE_KEY}`);
      return Response.json([]);
    }) as typeof fetch);
    await client.from("profile_backgrounds").select("id");
    assert.equal(calls, 1);
  }
  for (const key of [
    "sb_secret_test-not-real-12345", "storage-service-key-not-real-12345",
    tokenShape({ role: "service_role" }), tokenShape(), tokenShape({ role: "authenticated" }),
    tokenShape({ role: "custom" }), tokenShape({ role: "anon" }, "none"),
    "sb_publishable_", "sb_publishable_invalid+characters", "sb_publishable_invalid characters",
    "sb_publishable_test-not-real-12345\n", "sb_publishable_test\rnot-real-12345",
    `sb_publishable_${"a".repeat(8178)}`, tokenShape({ role: "anon", padding: "a".repeat(8192) }),
  ]) assert.throws(() => createDatabaseClient({ ...restricted(), SUPABASE_PUBLISHABLE_KEY: key }), /database_unavailable/);
});

test("database JWT shape rejects oversized encoded JSON and line breaks before transport", () => {
  for (const token of [
    tokenShape({ padding: "a".repeat(8192) }),
    `${Buffer.from(JSON.stringify({ alg: "HS256", padding: "a".repeat(8192) })).toString("base64url")}.${tokenShape().split(".").slice(1).join(".")}`,
    `${tokenShape()}\n`, tokenShape().replace(".", "\r."),
    `${tokenShape()}.${"a".repeat(8192)}`,
  ]) assert.throws(() => createDatabaseClient({ ...restricted(), PROFILE_DATABASE_KEY: token }), /database_unavailable/);
});

test("database token expiry is checked again before transport", async () => {
  const original = Date.now;
  let calls = 0;
  const env = restricted();
  const client = createDatabaseClient(env, (async () => { calls++; return Response.json([]); }) as typeof fetch);
  try {
    Date.now = () => original() + 7200000;
    const result = await client.from("profile_backgrounds").select("id");
    assert.ok(result.error);
    assert.equal(calls, 0);
  } finally { Date.now = original; }
});

test("storage admin keeps service credentials even in restricted mode", async () => {
  const env = restricted();
  const client = createAdminClient(env, (async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    return Response.json([]);
  }) as typeof fetch);
  await client.storage.from("profile-backgrounds").remove(["profile-images/test.png"]);
});

test("cleanup with an injected database never constructs unused storage credentials", async () => {
  const names: string[] = [];
  const result = await cleanupBackgrounds({ env: {}, client: { async rpc(name) {
    names.push(name);
    return { data: name === "reclaim_profile_backgrounds" ? 0 : [], error: null };
  } } });
  assert.equal(result.claimed, 0);
  assert.deepEqual(names, ["reclaim_profile_backgrounds", "claim_profile_background_cleanup"]);
});

test("cleanup separates restricted RPC transport from service-role storage transport", async () => {
  const env = restricted();
  const job = { object_key: `profile-images/${"a".repeat(32)}.png`, claim_token: "12345678-1234-4234-8234-123456789abc" };
  const paths: string[] = [];
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const storage = path.startsWith("/storage/");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), storage ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(headers.get("authorization"), `Bearer ${storage ? env.SUPABASE_SERVICE_ROLE_KEY : env.PROFILE_DATABASE_KEY}`);
    if (storage) return Response.json([]);
    if (path.endsWith("reclaim_profile_backgrounds")) return Response.json(0);
    if (path.endsWith("claim_profile_background_cleanup")) return Response.json([job]);
    return Response.json(true);
  }) as typeof fetch;
  const result = await cleanupBackgrounds({ env, fetch: fetcher });
  assert.equal(result.acknowledged, 1);
  assert.equal(paths.filter((path) => path.startsWith("/storage/")).length, 1);
  let deleted = 0;
  const partial = await cleanupBackgrounds({ env: { ...env, SUPABASE_SERVICE_ROLE_KEY: undefined }, fetch: fetcher, storage: { async delete() { deleted++; } } });
  assert.equal(partial.acknowledged, 1);
  assert.equal(deleted, 1);
});

test("restricted role migration scopes grants and checks inherited PUBLIC execution", () => {
  const sql = readFileSync(new URL("../supabase/migrations/202611220001_profile_database_role.sql", import.meta.url), "utf8");
  assert.match(sql, /NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/);
  assert.match(sql, /GRANT profile_dashboard TO authenticator/);
  assert.match(sql, /WHERE n\.nspname = 'public'\s+AND p\.prokind = 'f'\s+AND p\.prorettype NOT IN \('pg_catalog\.trigger'::regtype, 'pg_catalog\.event_trigger'::regtype\)\s+AND EXISTS/);
  assert.doesNotMatch(sql, /pg_depend|deptype|prosecdef\s*=/);
  assert.match(sql, /acl\.grantee = 0 AND acl\.privilege_type = 'EXECUTE'/);
  assert.match(sql, /RAISE EXCEPTION 'Restricted role would inherit PUBLIC EXECUTE/);
  assert.doesNotMatch(sql, /GRANT ALL|ALL FUNCTIONS|ALL TABLES|REVOKE/);
  const grants = sql.split("GRANT EXECUTE ON FUNCTION")[1].split("TO profile_dashboard")[0];
  assert.equal((grants.match(/public\./g) ?? []).length, 10);
  assert.equal((sql.match(/CREATE POLICY/g) ?? []).length, 5);
});

test("supabase config requires https url and a key", () => {
  assert.equal(supabaseConfig({}), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "https://example.supabase.co" }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "http://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "short" }), null);
  assert.deepEqual(
    supabaseConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }),
    { url: "https://example.supabase.co", serviceRoleKey: "x".repeat(32) },
  );
});
