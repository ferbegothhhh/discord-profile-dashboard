import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { ApiError } from "../lib/api-security.ts";
import { handleBackgroundMedia, type BackgroundMediaDependencies } from "../lib/background-media.ts";
import { MAX_OUTPUT_BYTES } from "../lib/image-processing.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const id = "7fb56ce4-a820-4ce0-9af7-c15ba0ee10b4";
const key = `profile-images/${"a".repeat(32)}.png`;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild };
const fetcher = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "tester" })) as typeof fetch;
async function browser(query = `guildId=${guild}&revision=2`) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/backgrounds/${id}/media?${query}`, { headers: { cookie } });
}
function fixture() {
  const row: Record<string, unknown> = { id, kind: "image", visibility: "private", owner_user_id: user, owner_guild_id: guild, slot_number: 1, revision: 2, status: "ready", is_active: true, mime: "image/png", width: 1000, height: 560, byte_size: png.length, object_key: key };
  const events: string[] = [];
  const dependencies: BackgroundMediaDependencies = {
    env, fetch: fetcher, limit: () => true,
    getLevel: async () => { events.push("level"); return { userId: user, guildId: guild, level: 65 }; },
    store: { async get(owner) { events.push("get"); assert.deepEqual(owner, { userId: user, guildId: guild, id, revision: 2 }); return row; } },
    storage: { async download(objectKey) { events.push("download"); assert.equal(objectKey, key); return png; } },
  };
  return { row, events, dependencies };
}
async function failure(response: Response, status: number, error?: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.match(response.headers.get("vary")!, /Cookie/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.text();
  if (error) assert.equal(JSON.parse(body).error, error);
  assert.doesNotMatch(body, /object_key|profile-images|private-detail|https?:|service_role/);
}

test("authenticated PNG is private, bounded and checked against fresh level twice", async () => {
  const f = fixture();
  const response = await handleBackgroundMedia(await browser(), id, f.dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("content-length"), String(png.length));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.match(response.headers.get("vary")!, /Cookie/);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.deepEqual(f.events, ["level", "get", "download", "level"]);
});

test("session, method, registry, membership and limiter gate all data access", async () => {
  const f = fixture();
  await failure(await handleBackgroundMedia(new Request(await browser(), { headers: {} }), id, f.dependencies), 401);
  await failure(await handleBackgroundMedia(new Request(await browser(), { method: "POST" }), id, f.dependencies), 405);
  await failure(await handleBackgroundMedia(await browser(), id, { ...f.dependencies, env: { ...env, PROFILE_BOT_GUILD_IDS: other } }), 403);
  await failure(await handleBackgroundMedia(await browser(), id, { ...f.dependencies, fetch: (async (url) => Response.json(String(url).includes("guilds") ? [] : { id: user, username: "tester" })) as typeof fetch }), 403);
  await failure(await handleBackgroundMedia(await browser(), id, { ...f.dependencies, limit: () => false }), 429);
  assert.deepEqual(f.events, []);
});

test("strict UUID and exact required guildId and revision reject ambiguous input", async () => {
  const f = fixture();
  for (const path of ["", "builtin", `${id}/`, ` ${id}`, id.replace("-4ce0-", "-0ce0-"), id.replace("-9af7-", "-7af7-")]) {
    await failure(await handleBackgroundMedia(await browser(), path, f.dependencies), 400);
  }
  for (const query of ["", `guildId=${guild}`, "revision=2", "guildId=bad&revision=2", `guildId=${guild}&guildId=${guild}&revision=2`, `guildId=${guild}&revision=2&revision=2`, `guildId=${guild}&revision=2&objectKey=evil`, `guildId=${guild}&revision=2&userId=${other}`]) {
    await failure(await handleBackgroundMedia(await browser(query), id, f.dependencies), 400);
  }
  for (const revision of ["0", "-1", "01", "1.0", "1e2", "+2", "NaN", "Infinity", "2147483649", "9007199254740992", ""]) {
    await failure(await handleBackgroundMedia(await browser(`guildId=${guild}&revision=${encodeURIComponent(revision)}`), id, f.dependencies), 400);
  }
  assert.deepEqual(f.events, []);
});

test("revision upper bound is inclusive", async () => {
  const f = fixture();
  f.row.revision = 2 ** 31;
  f.dependencies.store = { async get(owner) { assert.equal(owner.revision, 2 ** 31); return f.row; } };
  assert.equal((await handleBackgroundMedia(await browser(`guildId=${guild}&revision=2147483648`), id, f.dependencies)).status, 200);
});

test("absent, foreign, public, non-image, stale and inactive rows never reach storage", async () => {
  for (const patch of [{ owner_user_id: other }, { owner_guild_id: other }, { id: "other" }, { kind: "builtin" }, { visibility: "public" }, { revision: 1 }, { revision: "2" }, { status: "processing" }, { status: "failed" }, { is_active: false }, { is_active: 1 }, { slot_number: 0 }, { slot_number: 4 }]) {
    const f = fixture();
    Object.assign(f.row, patch);
    await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 404);
    assert.deepEqual(f.events, ["level", "get"]);
  }
  for (const row of [null, [], "invalid"]) {
    const f = fixture();
    f.dependencies.store = { async get() { return row; } };
    await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 404);
    assert.deepEqual(f.events, ["level"]);
  }
});

test("slot thresholds use the owning guild's fresh level and reject locked slots", async () => {
  for (const [slot, level] of [[1, 19], [2, 44], [3, 64]]) {
    const f = fixture();
    f.row.slot_number = slot;
    f.dependencies.getLevel = async () => ({ userId: user, guildId: guild, level });
    await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 403, "slot_locked");
    assert.deepEqual(f.events, ["get"]);
    f.dependencies.getLevel = async () => ({ userId: user, guildId: guild, level: level + 1 });
    assert.equal((await handleBackgroundMedia(await browser(), id, f.dependencies)).status, 200);
  }
});

test("invalid image metadata or object key is denied before download", async () => {
  for (const patch of [{ mime: "image/jpeg" }, { width: 999 }, { height: 561 }, { byte_size: 0 }, { byte_size: -1 }, { byte_size: 1.5 }, { byte_size: "8" }, { byte_size: MAX_OUTPUT_BYTES + 1 }, { object_key: "https://other.example/private-detail" }, { object_key: "profile-images/../private-detail.png" }, { object_key: `profile-images/${"A".repeat(32)}.png` }, { object_key: null }]) {
    const f = fixture();
    Object.assign(f.row, patch);
    await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 404);
    assert.deepEqual(f.events, ["level", "get"]);
  }
});

test("unavailable or mismatched fresh level fails closed before DB and after download", async () => {
  for (const snapshot of [null, { userId: other, guildId: guild, level: 65 }, { userId: user, guildId: other, level: 65 }, { userId: user, guildId: guild, level: -1 }, { userId: user, guildId: guild, level: NaN }]) {
    for (const afterDownload of [false, true]) {
      const f = fixture();
      const original = f.dependencies.getLevel!;
      let calls = 0;
      f.dependencies.getLevel = (async (...args) => afterDownload && calls++ === 0 ? original(...args) : snapshot) as typeof original;
      await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 503, "level_unavailable");
      assert.equal(f.events.includes("download"), afterDownload);
    }
  }
  const f = fixture();
  f.dependencies.storage = { async download() { f.dependencies.getLevel = async () => ({ userId: user, guildId: guild, level: 19 }); return png; } };
  await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 403, "slot_locked");
});

test("DB, level and storage exceptions including ApiErrors never leak raw details", async () => {
  for (const error of [new Error("private-detail"), new ApiError(500, "private-detail")]) {
    for (const stage of ["store", "storage", "level", "second-level"]) {
      const f = fixture();
      if (stage === "store") f.dependencies.store = { async get() { throw error; } };
      if (stage === "storage") f.dependencies.storage = { async download() { throw error; } };
      if (stage === "level") f.dependencies.getLevel = async () => { throw error; };
      if (stage === "second-level") f.dependencies.storage = { async download() { f.dependencies.getLevel = async () => { throw error; }; return png; } };
      await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 503);
    }
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(8), Buffer.concat([png, png]), Buffer.alloc(MAX_OUTPUT_BYTES + 1)]) {
    const f = fixture();
    f.dependencies.storage = { async download() { return bytes; } };
    await failure(await handleBackgroundMedia(await browser(), id, f.dependencies), 503, "storage_unavailable");
  }
});

test("default store scopes its metadata-only select to owner, guild, ready private image and revision", async () => {
  const f = fixture();
  let dbCalls = 0;
  const dbFetch = (async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/rest/v1/")) return fetcher(input, init);
    dbCalls++;
    assert.equal(url.pathname, "/rest/v1/profile_backgrounds");
    assert.equal(url.searchParams.get("select"), "id,kind,visibility,owner_user_id,owner_guild_id,slot_number,revision,status,is_active,mime,width,height,byte_size,object_key");
    for (const [field, value] of Object.entries({ id, owner_user_id: user, owner_guild_id: guild, kind: "image", visibility: "private", status: "ready", is_active: "true", revision: "2" })) assert.equal(url.searchParams.get(field), `eq.${value}`);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return Response.json(f.row);
  }) as typeof fetch;
  const dependencies = { ...f.dependencies, store: undefined, env: { ...env, SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-only-placeholder-service-role" }, fetch: dbFetch };
  assert.equal((await handleBackgroundMedia(await browser(), id, dependencies)).status, 200);
  assert.equal(dbCalls, 1);
});
