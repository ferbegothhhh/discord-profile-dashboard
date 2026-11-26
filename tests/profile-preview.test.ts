import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import sharp from "sharp";
import { handleProfilePreview } from "../lib/profile-preview.ts";
import type { PreferenceImage } from "../lib/supabase.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const imageId = "12345678-1234-4234-8234-123456789abc";
const key = "test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_random";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild, PROFILE_LEVEL_API_URL: "https://bot.example", PROFILE_LEVEL_API_KEY: key };
async function request(body: unknown = { guildId: guild, backgroundId: null, revision: null }) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request("https://dashboard.example/api/profile-preview", { method: "POST", headers: { cookie, origin: env.APP_URL, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const png = await sharp({ create: { width: 1000, height: 560, channels: 4, background: "#352442" } }).png().toBuffer();
const image: PreferenceImage = { id: imageId, kind: "image", revision: 2, slot: 1, userId: user, guildId: guild, mime: "image/png", width: 1000, height: 560, objectKey: `profile-images/${"a".repeat(32)}.png`, byteSize: png.length };
function setup() {
  const sent: Record<string, unknown>[] = [];
  let downloads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).startsWith(env.PROFILE_LEVEL_API_URL)) {
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
      sent.push(JSON.parse(init?.body as string));
      return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
    }
    assert.ok(!init?.method || init.method === "GET");
    return Response.json(String(input).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "Test" });
  };
  return { sent, downloads: () => downloads, deps: { env, fetch: fetcher, limit: () => true, store: { async resolveImage() { return image; } }, storage: { async download() { downloads++; return png; } }, getLevel: async () => ({ userId: user, guildId: guild, level: 20 }) } };
}

test("default and catalog render only server-derived identity, no preference read or writes, private output", async () => {
  const s = setup();
  for (const backgroundId of [null, "catalog-background-2"]) {
    const response = await handleProfilePreview(await request({ guildId: guild, backgroundId, revision: null }), s.deps);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  }
  assert.deepEqual(s.sent, [{ userId: user, guildId: guild, background: null }, { userId: user, guildId: guild, background: { id: "catalog-background-2", kind: "catalog-image" } }]);
  assert.equal(s.downloads(), 0);
});

test("retired solid backgrounds fail closed instead of reaching the bot", async () => {
  const s = setup();
  const response = await handleProfilePreview(await request({ guildId: guild, backgroundId: "sample-plum", revision: null }), s.deps);
  assert.equal(response.status, 400);
  assert.deepEqual(s.sent, []);
});

test("CSRF, missing session, registry, target impersonation, size and limiter fail before render", async () => {
  const s = setup();
  const csrf = await request(); csrf.headers.set("origin", "https://evil.example");
  assert.equal((await handleProfilePreview(csrf, s.deps)).status, 403);
  const anon = await request(); anon.headers.delete("cookie");
  assert.equal((await handleProfilePreview(anon, s.deps)).status, 401);
  assert.equal((await handleProfilePreview(await request(), { ...s.deps, env: { ...env, PROFILE_BOT_GUILD_IDS: user } })).status, 403);
  assert.equal((await handleProfilePreview(await request(), { ...s.deps, limit: () => false })).status, 429);
  for (const body of [{ guildId: guild, backgroundId: null, revision: null, userId: user }, { guildId: user, backgroundId: null, revision: null }, { guildId: guild, backgroundId: "x".repeat(1100), revision: null }]) {
    assert.ok([400, 403].includes((await handleProfilePreview(await request(body), s.deps)).status));
  }
  assert.equal(s.sent.length, 0);
});

test("unsaved custom bytes require owner, guild, current level and exact revision without mutations", async () => {
  const s = setup();
  const body = { guildId: guild, backgroundId: imageId, revision: 2 };
  assert.equal((await handleProfilePreview(await request(body), s.deps)).status, 200);
  assert.deepEqual(s.sent[0], { userId: user, guildId: guild, background: { id: imageId, kind: "image", slot: 1, revision: 2, base64: png.toString("base64") } });
  assert.equal((await handleProfilePreview(await request({ ...body, revision: 1 }), s.deps)).status, 400);
  assert.equal((await handleProfilePreview(await request(body), { ...s.deps, getLevel: async () => ({ userId: user, guildId: guild, level: 19 }) })).status, 403);
  assert.equal((await handleProfilePreview(await request(body), { ...s.deps, store: { async resolveImage() { return { ...image, userId: guild }; } } })).status, 400);
  assert.equal((await handleProfilePreview(await request(body), { ...s.deps, storage: { async download() { return Buffer.alloc(png.length); } } })).status, 503);
  assert.equal(s.sent.length, 1);
});

test("bot failures, oversized streamed output and invalid PNG never escape as successful preview", async () => {
  for (const output of [new Response("private error", { status: 500 }), new Response(new Uint8Array(2305537), { headers: { "Content-Type": "image/png" } }), new Response(new Uint8Array(33), { headers: { "Content-Type": "image/png" } })]) {
    const s = setup();
    const fetcher: typeof fetch = (input, init) => String(input).startsWith(env.PROFILE_LEVEL_API_URL) ? Promise.resolve(output) : s.deps.fetch(input, init);
    const response = await handleProfilePreview(await request(), { ...s.deps, fetch: fetcher });
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.doesNotMatch(await response.text(), /private error/);
  }
});
