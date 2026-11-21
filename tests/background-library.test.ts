import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { handleBackgroundLibrary } from "../lib/background-library.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild };
const fetcher = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "tester" })) as typeof fetch;
const row = { id: "a5ca31b2-4334-403d-9234-3f4232a53442", name: "Forest", slot_number: 3, status: "ready", is_active: true, revision: 2 };
const deps = { env, fetch: fetcher, limit: () => true, getLevel: async () => ({ userId: user, guildId: guild, level: 65 }), listBackgrounds: async () => [] };
async function browser(query = `guildId=${guild}`, expiresAt = Date.now() + 60000) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/backgrounds?${query}`, { headers: { cookie } });
}
async function check(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.match(response.headers.get("vary")!, /Cookie/);
  return response.json();
}

test("stable three slots use fresh levels including drops and retain locked metadata only", async () => {
  const calls: string[][] = [];
  let level = 0;
  let levelCalls = 0;
  const options = { ...deps, getLevel: async (u: string, g: string) => { levelCalls++; assert.equal(u, user); assert.equal(g, guild); return { userId: u, guildId: g, level }; }, listBackgrounds: async (u: string, g: string) => { calls.push([u, g]); return [{ ...row, object_key: "private-secret", url: "private-media" }]; } };
  for (level of [0, 19, 20, 44, 45, 64, 65, 100, 20]) {
    const body = await check(await handleBackgroundLibrary(await browser(), options), 200);
    assert.deepEqual(body, { status: "ready", guildId: guild, level, slots: [20, 45, 65].map((requiredLevel, i) => ({ slot: i + 1, requiredLevel, unlocked: level >= requiredLevel, background: i === 2 ? { id: row.id, name: row.name, status: row.status, revision: 2, isActive: true } : null })) });
    assert.doesNotMatch(JSON.stringify(body), /object_key|private-secret|private-media|url/);
  }
  assert.equal(levelCalls, 9);
  assert.deepEqual(calls, Array.from({ length: 9 }, () => [user, guild]));
});

test("empty library and all known statuses are returned without filtering inactive metadata", async () => {
  const empty = await check(await handleBackgroundLibrary(await browser(), deps), 200);
  assert.deepEqual(empty.slots.map((slot: { background: unknown }) => slot.background), [null, null, null]);
  const rows = ["processing", "ready", "failed"].map((status, i) => ({ ...row, id: `image_${i}`, status, slot_number: i + 1, is_active: false }));
  const body = await check(await handleBackgroundLibrary(await browser(), { ...deps, listBackgrounds: async () => rows.reverse() }), 200);
  assert.deepEqual(body.slots.map((slot: { background: unknown }) => slot.background), rows.reverse().map((r) => ({ id: r.id, name: r.name, status: r.status, revision: r.revision, isActive: false })));
});

test("auth, registry, membership, rate limits and exact query deny before level or database", async () => {
  let calls = 0;
  const options = { ...deps, getLevel: async () => { calls++; throw new Error("unexpected"); }, listBackgrounds: async () => { calls++; throw new Error("unexpected"); } };
  await check(await handleBackgroundLibrary(new Request(`https://dashboard.example/api/backgrounds?guildId=${guild}`), options), 401);
  await check(await handleBackgroundLibrary(await browser(undefined, Date.now() - 1), options), 401);
  await check(await handleBackgroundLibrary(await browser(), { ...options, env: { ...env, SESSION_PASSWORD: "" } }), 503);
  await check(await handleBackgroundLibrary(await browser(), { ...options, env: { ...env, PROFILE_BOT_GUILD_IDS: other } }), 403);
  await check(await handleBackgroundLibrary(await browser(), { ...options, env: { ...env, PROFILE_BOT_GUILD_IDS: "" } }), 503);
  await check(await handleBackgroundLibrary(await browser(), { ...options, fetch: (async (url) => Response.json(String(url).includes("guilds") ? [] : { id: user, username: "tester" })) as typeof fetch }), 403);
  await check(await handleBackgroundLibrary(await browser(), { ...options, limit: () => false }), 429);
  for (const query of ["", "guildId=invalid", `guildId=${guild}&guildId=${guild}`, `guildId=${guild}&userId=${other}`, `guildId=${guild}&extra=1`]) await check(await handleBackgroundLibrary(await browser(query), options), 400);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) await check(await handleBackgroundLibrary(new Request(await browser(), { method }), options), 405);
  assert.equal(calls, 0);
});

test("Discord failures are sanitized before provider calls", async () => {
  let calls = 0;
  for (const status of [401, 429, 500]) {
    const response = await handleBackgroundLibrary(await browser(), { ...deps, fetch: (async () => new Response("private-secret", { status })) as typeof fetch, getLevel: async () => { calls++; throw new Error(); } });
    assert.doesNotMatch(JSON.stringify(await check(response, status === 401 ? 401 : 503)), /private-secret/);
  }
  assert.equal(calls, 0);
});

test("malformed rows, duplicate slots and invalid metadata fail closed", async () => {
  const invalid = [null, {}, [null], [row, row], [{ ...row, slot_number: 0 }], [{ ...row, slot_number: 4 }], [{ ...row, slot_number: "3" }], [{ ...row, id: "../private" }], [{ ...row, id: "a".repeat(101) }], [{ ...row, name: "" }], [{ ...row, name: " " }], [{ ...row, name: "a".repeat(101) }], [{ ...row, name: "bad\nname" }], [{ ...row, status: "unknown" }], [{ ...row, revision: 0 }], [{ ...row, revision: 1.5 }], [{ ...row, revision: "2" }], [{ ...row, is_active: null }], [row, { ...row, slot_number: 1 }]];
  for (const rows of invalid) await check(await handleBackgroundLibrary(await browser(), { ...deps, listBackgrounds: async () => rows }), 503);
  for (const field of ["id", "name", "slot_number", "status", "revision", "is_active"]) {
    const broken: Record<string, unknown> = { ...row };
    delete broken[field];
    await check(await handleBackgroundLibrary(await browser(), { ...deps, listBackgrounds: async () => [broken] }), 503);
  }
});

test("invalid or unavailable fresh levels block database reads and failures never expose secrets", async () => {
  let reads = 0;
  for (const snapshot of [{ userId: other, guildId: guild, level: 65 }, { userId: user, guildId: other, level: 65 }, { userId: user, guildId: guild, level: -1 }, { userId: user, guildId: guild, level: 1.5 }, { userId: user, guildId: guild, level: NaN }]) {
    await check(await handleBackgroundLibrary(await browser(), { ...deps, getLevel: async () => snapshot, listBackgrounds: async () => { reads++; return []; } }), 503);
  }
  await check(await handleBackgroundLibrary(await browser(), { ...deps, getLevel: async () => { throw new Error("private-secret"); }, listBackgrounds: async () => { reads++; return []; } }), 503);
  assert.equal(reads, 0);
  const response = await handleBackgroundLibrary(await browser(), { ...deps, listBackgrounds: async () => { throw new Error("private-secret"); } });
  assert.deepEqual(await check(response, 503), { error: "service_unavailable" });
});

test("default database query is read-only, owner-scoped, private image metadata only", async () => {
  let reads = 0;
  const dbEnv = { ...env, SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };
  for (const mode of ["ready", "error", "malformed"]) {
    const fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "database.example") return fetcher(input, init);
      reads++;
      assert.equal(init?.method, "GET");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      assert.equal(url.pathname, "/rest/v1/profile_backgrounds");
      assert.deepEqual(Object.fromEntries(url.searchParams), { select: "id,name,slot_number,status,is_active,revision", owner_user_id: `eq.${user}`, owner_guild_id: `eq.${guild}`, visibility: "eq.private", kind: "eq.image", order: "slot_number.asc" });
      if (mode === "error") return Response.json({ message: "private-secret" }, { status: 400 });
      return Response.json(mode === "ready" ? [row] : null);
    }) as typeof globalThis.fetch;
    const response = await handleBackgroundLibrary(await browser(), { env: dbEnv, fetch, limit: () => true, getLevel: deps.getLevel });
    const body = await check(response, mode === "ready" ? 200 : 503);
    assert.doesNotMatch(JSON.stringify(body), /private-secret|service-key|object_key/);
  }
  assert.equal(reads, 3);
});
