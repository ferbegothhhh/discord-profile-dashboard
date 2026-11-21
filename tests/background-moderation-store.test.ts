import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { handleModeration } from "../lib/background-moderation.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild, SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };

test("real moderation adapter scopes reads and atomic RPC to authorized guild without owner impersonation", async () => {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const key = `profile-images/${"a".repeat(32)}.png`;
  let calls = 0;
  const fetcher = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "discord.com") return Response.json(url.pathname.includes("guilds") ? [{ id: guild, name: "Test", permissions: "8" }] : { id: user, username: "tester" });
    calls++;
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    if (init?.method === "POST") {
      assert.equal(url.pathname, "/rest/v1/rpc/disable_guild_background");
      assert.deepEqual(JSON.parse(String(init.body)), { p_actor_id: user, p_guild_id: guild, p_id: id });
      return Response.json(true);
    }
    assert.equal(url.searchParams.get("owner_guild_id"), `eq.${guild}`);
    assert.equal(url.searchParams.get("kind"), "eq.image");
    assert.equal(url.searchParams.get("visibility"), "eq.private");
    assert.equal(url.searchParams.get("status"), "eq.ready");
    const row = { id, owner_user_id: "323456789012345678", owner_guild_id: guild, slot_number: 1, is_active: false, status: "ready", kind: "image", visibility: "private", object_key: key, byte_size: 8, mime: "image/png" };
    if (url.searchParams.has("id")) { assert.equal(url.searchParams.get("id"), `eq.${id}`); return Response.json(row); }
    assert.equal(url.searchParams.get("limit"), "21");
    assert.equal(url.searchParams.get("order"), "id.asc");
    return Response.json(Array.from({ length: 21 }, (_, index) => ({ ...row, id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}` })));
  }) as typeof fetch;
  for (const [method, target] of [["GET", undefined], ["GET", id], ["POST", id]] as const) {
    const response = await handleModeration(new Request(`https://dashboard.example/?guildId=${guild}`, { method, headers: { cookie, origin: env.APP_URL } }), target, { env, fetch: fetcher, limit: () => true, storage: { async download(value) { assert.equal(value, key); return png; } } });
    assert.equal(response.status, 200);
    if (target && method === "GET") assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    else {
      const data = await response.json();
      assert.doesNotMatch(JSON.stringify(data), /object_key|profile-images|service-key/);
      if (!target) { assert.equal(data.items.length, 20); assert.equal(data.next, "aaaaaaaa-aaaa-4aaa-8aaa-000000000013"); }
    }
  }
  assert.equal(calls, 3);
});
