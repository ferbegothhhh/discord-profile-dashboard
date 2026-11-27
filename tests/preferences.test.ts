import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { handlePreferences, handleBotPreferences } from "../lib/preferences.ts";
import { preferenceStore, type PreferenceImage } from "../lib/supabase.ts";
import { ApiError, createProcessLimiter } from "../lib/api-security.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const key = "test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_random";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_API_KEY: key, PROFILE_BOT_GUILD_IDS: `${guild},${other}` };
const records = new Map<string, string>();
const store = {
  async get(u: string, g: string) { return records.get(`${u}:${g}`) ?? null; },
  async set(u: string, g: string, id: string) { records.set(`${u}:${g}`, id); },
  async reset(u: string, g: string) { records.delete(`${u}:${g}`); },
};
const fetcher = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }, { id: other, name: "Other" }] : { id: user, username: "tester" })) as typeof fetch;
const deps = { env, store, fetch: fetcher, limit: () => true, discordScope: {} };
test.beforeEach(() => { deps.discordScope = {}; });
async function browser(body?: unknown, query = `guildId=${guild}`, expiresAt = Date.now() + 60000) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/preferences${body === undefined ? `?${query}` : ""}`, { method: body === undefined ? "GET" : "POST", headers: { cookie, origin: env.APP_URL, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function bot(query = `guildId=${guild}&userId=${user}`, auth = `Bearer ${key}`) {
  return new Request(`https://dashboard.example/api/bot/preferences?${query}`, { headers: { authorization: auth } });
}
async function check(response: Response, status: number) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  return response.json();
}

test("browser identity cannot be supplied; saves and resets stay isolated by guild", async () => {
  records.clear();
  await check(await handlePreferences(await browser({ guildId: guild, backgroundId: "catalog-background-1", userId: other }), deps), 400);
  assert.deepEqual(await check(await handlePreferences(await browser({ guildId: guild, backgroundId: "catalog-background-1" }), deps), 200), { status: "saved", backgroundId: "catalog-background-1" });
  assert.deepEqual(await check(await handlePreferences(await browser(undefined, `guildId=${other}`), deps), 200), { status: "ready", backgroundId: null });
  await check(await handlePreferences(await browser({ guildId: guild, backgroundId: null }), deps), 200);
  assert.equal((await check(await handlePreferences(await browser(), deps), 200)).backgroundId, null);
  assert.equal(records.size, 0);
});

test("membership and operator registry independently deny guild access", async () => {
  await check(await handlePreferences(await browser(), { ...deps, env: { ...env, PROFILE_BOT_GUILD_IDS: other } }), 403);
  await check(await handlePreferences(await browser(), { ...deps, discordScope: {}, fetch: (async (url) => Response.json(String(url).includes("guilds") ? [] : { id: user, username: "tester" })) as typeof fetch }), 403);
  await check(await handlePreferences(await browser(), { ...deps, env: { ...env, PROFILE_BOT_GUILD_IDS: "" } }), 503);
});

test("CSRF, content type, oversized and malformed bodies, invalid IDs rejected", async () => {
  const request = await browser({ guildId: guild, backgroundId: null });
  request.headers.set("origin", "https://evil.example");
  await check(await handlePreferences(request, deps), 403);
  for (const body of ["{", JSON.stringify({ guildId: guild, backgroundId: "../../file" }), " ".repeat(1025)]) {
    const r = await browser({});
    await check(await handlePreferences(new Request(r, { body }), deps), 400);
  }
  const r = await browser({ guildId: guild, backgroundId: null });
  r.headers.set("content-type", "text/plain");
  await check(await handlePreferences(r, deps), 400);
  await check(await handlePreferences(await browser(undefined, `guildId=${guild}&userId=${other}`), deps), 400);
});

test("expiry, upstream 401, 429, malformed JSON and timeout are sanitized", async () => {
  await check(await handlePreferences(await browser(undefined, undefined, Date.now() - 1), deps), 401);
  for (const status of [401, 429]) {
    await check(await handlePreferences(await browser(), { ...deps, discordScope: {}, fetch: (async () => new Response("secret", { status })) as typeof fetch }), status === 401 ? 401 : 503);
  }
  for (const f of [async () => new Response("{"), async () => { throw new Error("secret timeout"); }]) {
    const response = await handlePreferences(await browser(), { ...deps, fetch: f as typeof fetch });
    assert.doesNotMatch(JSON.stringify(await check(response, 503)), /secret/);
  }
  await check(await handlePreferences(await browser(), { ...deps, limit: () => false }), 429);
});

test("Discord timeout aborts cleanly and inactive catalog save returns 400", async () => {
  let aborted = false;
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  let databaseCalls = 0;
  const fetch = (async (_input, init) => {
    calls++;
    if (calls === 1) {
      signal = init?.signal;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return Response.json({ id: user, username: "tester" });
    }
    assert.notEqual(init?.signal, signal);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private timeout")); }, { once: true });
    });
  }) as typeof globalThis.fetch;
  const started = performance.now();
  await check(await handlePreferences(await browser(), { ...deps, fetch, store: { ...store, async get() { databaseCalls++; return null; } } }), 503);
  const elapsed = performance.now() - started;
  assert.equal(aborted, true);
  assert.equal(calls, 2);
  assert.equal(databaseCalls, 0);
  assert.ok(elapsed >= 7500 && elapsed < 11000, `Shared authorization deadline took ${elapsed}ms`);
  const inactive = { ...store, async set() { throw new ApiError(400, "invalid_background"); } };
  await check(await handlePreferences(await browser({ guildId: guild, backgroundId: "sample-plum" }), { ...deps, store: inactive }), 400);
});

test("service credential, strict scope, bounded limiter and database errors", async () => {
  for (const auth of ["", "Bearer invalid", `Basic ${key}`]) await check(await handleBotPreferences(bot(undefined, auth), deps), 401);
  await check(await handleBotPreferences(bot(`guildId=423456789012345678&userId=${user}`), deps), 403);
  await check(await handleBotPreferences(bot(`guildId=${guild}&userId=${user}&guildId=${other}`), deps), 400);
  await check(await handleBotPreferences(bot(), { ...deps, limit: () => false }), 429);
  await check(await handleBotPreferences(bot(), { ...deps, env: { ...env, PROFILE_BOT_API_KEY: "x".repeat(32) } }), 503);
  assert.deepEqual(await check(await handleBotPreferences(bot(), deps), 200), { status: "ready", backgroundId: null, background: null });
  const broken = { ...store, async get() { throw new ApiError(503, "database_unavailable"); } };
  await check(await handlePreferences(await browser(), { ...deps, store: broken }), 503);
  await check(await handleBotPreferences(bot(), { ...deps, store: broken }), 503);
  let now = 0;
  const limit = createProcessLimiter(1, 1, () => now);
  assert.equal(limit("a"), true); assert.equal(limit("a"), false); assert.equal(limit("b"), false);
  now = 60000; assert.equal(limit("b"), true);
});

const imageId = "12345678-1234-4234-8234-123456789abc";
const image: PreferenceImage = { id: imageId, kind: "image", revision: 2, mime: "image/png", width: 1000, height: 560, slot: 1, userId: user, guildId: guild, objectKey: `profile-images/${"a".repeat(32)}.png`, byteSize: 128 };
const level = async (u: string, g: string) => ({ userId: u, guildId: g, level: 20 });

test("image selection checks owner, guild, slot and level before writing", async () => {
  const writes: string[] = [];
  const imageStore = { ...store, async resolveImage() { return image; }, async set(_u: string, _g: string, id: string) { writes.push(id); } };
  const request = () => browser({ guildId: guild, backgroundId: imageId });
  assert.equal((await check(await handlePreferences(await request(), { ...deps, store: imageStore, getLevel: level }), 200)).backgroundId, imageId);
  assert.deepEqual(writes, [imageId]);
  for (const candidate of [{ ...image, userId: other }, { ...image, guildId: other }, { ...image, slot: 2 as const }, { ...image, objectKey: "../private" }, null]) {
    await check(await handlePreferences(await request(), { ...deps, store: { ...imageStore, async resolveImage() { return candidate; } }, getLevel: level }), 400);
  }
  assert.deepEqual(writes, [imageId]);
  await check(await handlePreferences(await request(), { ...deps, store: imageStore, getLevel: async () => ({ userId: other, guildId: guild, level: 100 }) }), 503);
  await check(await handlePreferences(await request(), { ...deps, store: imageStore, getLevel: async () => { throw new Error("secret"); } }), 503);
  assert.deepEqual(writes, [imageId]);
});

test("image GET and bot response fail closed when locked, stale or provider fails; solids and reset remain independent", async () => {
  const imageStore = { ...store, async get() { return imageId; }, async resolveImage() { return image; } };
  assert.deepEqual(await check(await handleBotPreferences(bot(), { ...deps, store: imageStore, getLevel: level }), 200), { status: "ready", backgroundId: imageId, background: { id: imageId, kind: "image", revision: 2, mime: "image/png", width: 1000, height: 560, slot: 1 } });
  for (const getLevel of [async () => ({ userId: user, guildId: guild, level: 19 }), async () => { throw new Error("secret"); }]) {
    const status = (await getLevel().catch(() => null)) ? 200 : 503;
    if (status === 200) {
      assert.equal((await check(await handlePreferences(await browser(), { ...deps, store: imageStore, getLevel }), 200)).backgroundId, null);
      assert.equal((await check(await handleBotPreferences(bot(), { ...deps, store: imageStore, getLevel }), 200)).backgroundId, null);
    } else await check(await handleBotPreferences(bot(), { ...deps, store: imageStore, getLevel }), 503);
  }
  assert.equal((await check(await handleBotPreferences(bot(), { ...deps, store: { ...imageStore, async resolveImage() { return null; } }, getLevel: level }), 200)).backgroundId, null);
  assert.equal((await check(await handleBotPreferences(bot(), { ...deps, store: { ...store, async get() { return "sample-plum"; } }, getLevel: async () => { throw new Error(); } }), 200)).backgroundId, null);
  assert.deepEqual(await check(await handleBotPreferences(bot(), { ...deps, store: { ...store, async get() { return "catalog-background-2"; } } }), 200), { status: "ready", backgroundId: "catalog-background-2", background: { id: "catalog-background-2", kind: "catalog-image", mime: "image/jpeg", width: 736, height: 414 } });
  assert.equal((await check(await handlePreferences(await browser({ guildId: guild, backgroundId: null }), { ...deps, store: imageStore }), 200)).backgroundId, null);
});

test("database distinguishes missing/error and validates active known asset on reads and writes", async () => {
  const dbEnv = { SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };
  for (const mode of ["missing", "inactive", "unknown", "active", "error"]) {
    const calls: string[] = [];
    const db = preferenceStore(dbEnv, (async (input, init) => {
      const url = String(input); calls.push(url);
      assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
      if (mode === "error") return Response.json({ message: "private" }, { status: 500 });
      if (init?.method === "POST" || init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.includes("profile_preferences")) return Response.json(mode === "missing" ? null : { background_id: mode === "unknown" ? "external" : "sample-plum" });
      assert.match(url, /is_active=eq.true/);
      return Response.json(mode === "inactive" ? null : { id: "sample-plum", asset_key: "sample-plum", color: "#352442" });
    }) as typeof fetch);
    if (mode === "error") { await assert.rejects(db.get(user, guild), ApiError); continue; }
    assert.equal(await db.get(user, guild), mode === "active" ? "sample-plum" : null);
    if (mode === "active") await db.set(user, guild, "sample-plum");
    if (mode === "inactive") await assert.rejects(db.set(user, guild, "sample-plum"), (e: unknown) => e instanceof ApiError && e.status === 400);
    await assert.rejects(db.set(user, guild, "external"), ApiError);
    assert.ok(calls.some(url => url.includes(`user_id=eq.${user}`) && url.includes(`guild_id=eq.${guild}`)));
  }
});

test("built-in catalog selections require matching database rows with a null color", async () => {
  const env = { SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };
  for (const id of ["catalog-background-1", "catalog-background-2"]) {
    const row = { id, asset_key: id, kind: "catalog-image", color: null };
    for (const data of [row, null, { ...row, kind: "solid" }, { ...row, asset_key: "wrong" }, { ...row, color: "#202024" }]) {
      let writes = 0;
      const store = preferenceStore(env, async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/profile_backgrounds")) {
          assert.equal(url.searchParams.get("is_active"), "eq.true");
          assert.equal(url.searchParams.get("id"), `eq.${id}`);
          return Response.json(data);
        }
        if (init?.method === "POST") {
          writes++;
          assert.equal(JSON.parse(String(init.body)).background_id, id);
          return new Response(null, { status: 204 });
        }
        return Response.json({ background_id: id });
      });
      assert.equal(await store.get(user, guild), data === row ? id : null);
      if (data === row) await store.set(user, guild, id);
      else await assert.rejects(store.set(user, guild, id), (error: unknown) => error instanceof ApiError && error.status === 400);
      assert.equal(writes, data === row ? 1 : 0);
    }
  }
});
