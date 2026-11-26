import assert from "node:assert/strict";
import test from "node:test";
import { handleBotBackgroundMedia } from "../lib/bot-background-media.ts";
import { handleBotPreferences } from "../lib/preferences.ts";
import { type PreferenceImage } from "../lib/supabase.ts";

const userId = "123456789012345678";
const guildId = "223456789012345678";
const id = "12345678-1234-4234-8234-123456789abc";
const key = "test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_random";
const env = { PROFILE_BOT_API_KEY: key, PROFILE_BOT_GUILD_IDS: guildId };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image: PreferenceImage = { id, userId, guildId, kind: "image", slot: 1, revision: 1, mime: "image/png", width: 1000, height: 560, byteSize: png.length, objectKey: `profile-images/${"a".repeat(32)}.png` };
function request(query = `userId=${userId}&guildId=${guildId}&revision=1`, authorization = `Bearer ${key}`) {
  return new Request(`https://dashboard.example/api/bot/backgrounds/${id}/media?${query}`, { headers: { authorization } });
}
function setup() {
  const calls = { levels: 0, downloads: 0 };
  const store = { async get() { return id; }, async resolveImage() { return image; }, async set() {}, async reset() {} };
  return { calls, deps: { env, limit: () => true, store, async getLevel() { calls.levels++; return { userId, guildId, level: 20 }; }, storage: { async download() { calls.downloads++; return png; } } } };
}

test("bot callers await async denial before database, level or storage", async () => {
  const { calls, deps } = setup();
  let reads = 0;
  deps.store.get = async () => { reads++; return id; };
  deps.store.resolveImage = async () => { reads++; return image; };
  const dependencies = { ...deps, limit: async () => { await Promise.resolve(); return false; } };
  for (const response of [await handleBotBackgroundMedia(request(), id, dependencies), await handleBotPreferences(request(), dependencies)]) {
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "rate_limited" });
  }
  assert.equal(reads, 0);
  assert.deepEqual(calls, { levels: 0, downloads: 0 });
});

test("bot media returns private PNG after two fresh level checks and never returns object keys", async () => {
  const { calls, deps } = setup();
  const response = await handleBotBackgroundMedia(request(), id, deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.deepEqual(calls, { levels: 2, downloads: 1 });
});

for (const [name, change] of [
  ["foreign owner", { userId: "323456789012345678" }],
  ["foreign guild", { guildId: "323456789012345678" }],
  ["wrong revision", { revision: 2 }],
  ["invalid slot", { slot: 4 }],
  ["invalid MIME", { mime: "image/jpeg" }],
  ["invalid dimensions", { width: 999 }],
  ["invalid key", { objectKey: "../private" }],
] as const) {
  test(`bot media denies ${name} without downloading`, async () => {
    const { calls, deps } = setup();
    deps.store.resolveImage = async () => ({ ...image, ...change }) as PreferenceImage;
    assert.equal((await handleBotBackgroundMedia(request(), id, deps)).status, 404);
    assert.equal(calls.downloads, 0);
  });
}

test("bot media enforces strict bearer, UUID, registry, query and rate limit", async () => {
  const { deps } = setup();
  assert.equal((await handleBotBackgroundMedia(request(undefined, "Bearer wrong"), id, deps)).status, 401);
  assert.equal((await handleBotBackgroundMedia(request(), "sample-plum", deps)).status, 400);
  for (const query of [`userId=${userId}&guildId=${guildId}&revision=01`, `userId=${userId}&guildId=${guildId}&revision=1&revision=1`, `userId=${userId}&guildId=${guildId}&revision=2147483649`, `userId=${userId}&guildId=${guildId}&revision=1&x=1`]) assert.equal((await handleBotBackgroundMedia(request(query), id, deps)).status, 400);
  assert.equal((await handleBotBackgroundMedia(request(), id, { ...deps, env: { ...env, PROFILE_BOT_GUILD_IDS: "323456789012345678" } })).status, 403);
  assert.equal((await handleBotBackgroundMedia(request(), id, { ...deps, limit: () => false })).status, 429);
});

test("bot media denies locked slot before download and level reset after download", async () => {
  for (const resetAfterRead of [false, true]) {
    const { deps, calls } = setup();
    deps.getLevel = async () => ({ userId, guildId, level: resetAfterRead && ++calls.levels === 1 ? 20 : 19 });
    assert.equal((await handleBotBackgroundMedia(request(), id, deps)).status, 403);
    assert.equal(calls.downloads, resetAfterRead ? 1 : 0);
  }
});

test("bot media denies preference reset during download", async () => {
  const { deps } = setup();
  let selected = true;
  deps.store.get = async () => selected ? id : "sample-plum";
  deps.storage.download = async () => { selected = false; return png; };
  assert.equal((await handleBotBackgroundMedia(request(), id, deps)).status, 404);
});

test("bot media denies replacement during download", async () => {
  const { deps } = setup();
  let revision = 1;
  deps.store.resolveImage = async () => ({ ...image, revision });
  deps.storage.download = async () => { revision++; return png; };
  assert.equal((await handleBotBackgroundMedia(request(), id, deps)).status, 404);
});

test("bot media sanitizes level, database and storage failures", async () => {
  for (const source of ["level", "database", "storage", "bytes", "identity"]) {
    const { deps } = setup();
    if (source === "level") deps.getLevel = async () => { throw new Error("private secret"); };
    if (source === "identity") deps.getLevel = async () => ({ userId: guildId, guildId, level: 100 });
    if (source === "database") deps.store.resolveImage = async () => { throw new Error("private secret"); };
    if (source === "storage") deps.storage.download = async () => { throw new Error("private secret"); };
    if (source === "bytes") deps.storage.download = async () => Buffer.from("not PNG!");
    const response = await handleBotBackgroundMedia(request(), id, deps);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private secret|profile-images/);
  }
});
