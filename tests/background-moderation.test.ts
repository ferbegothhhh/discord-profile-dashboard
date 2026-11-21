import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { handleModeration, type ModerationDependencies, type ReviewRow } from "../lib/background-moderation.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild };
const row: ReviewRow = { id, owner_guild_id: guild, owner_user_id: other, slot_number: 1, is_active: true, status: "ready", kind: "image", visibility: "private" };
async function request(method = "GET", query = `guildId=${guild}`, origin = env.APP_URL) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/moderation/backgrounds?${query}`, { method, headers: { cookie, origin } });
}
function fixture(permission: Record<string, unknown> = { permissions: "8" }) {
  const calls: string[] = [];
  const dependencies: ModerationDependencies = {
    env, limit: () => true,
    fetch: (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test", ...permission }] : { id: user, username: "tester" })) as typeof fetch,
    store: {
      async list(g, after) { assert.equal(g, guild); assert.equal(after, ""); calls.push("list"); return [row]; },
      async get(g, target) { assert.equal(g, guild); assert.equal(target, id); calls.push("get"); return row; },
      async disable(actor, g, target) { assert.equal(actor, user); assert.equal(g, guild); assert.equal(target, id); calls.push("disable"); return true; },
    },
  };
  return { dependencies, calls };
}

test("fresh owner or Administrator may list and disable another member's guild image", async () => {
  for (const permission of [{ owner: true, permissions: "0" }, { owner: false, permissions: "8" }, { permissions: "40" }]) {
    const f = fixture(permission);
    const response = await handleModeration(await request(), undefined, f.dependencies);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /private, no-store/);
    assert.deepEqual(await response.json(), { guildId: guild, items: [{ id, ownerUserId: other, slot: 1, active: true }], next: null });
    assert.equal((await handleModeration(await request("POST"), id, f.dependencies)).status, 200);
    assert.deepEqual(f.calls, ["list", "disable"]);
  }
});

test("Manage Guild alone, malformed permissions and membership never authorize", async () => {
  for (const permission of [{ permissions: "32" }, {}, { owner: "true", permissions: 8 }, { permissions: "-8" }, { permissions: "8junk" }, { id: other, permissions: "8" }]) {
    const f = fixture(permission);
    for (const method of ["GET", "POST"]) assert.equal((await handleModeration(await request(method), id, f.dependencies)).status, 403);
    assert.deepEqual(f.calls, []);
  }
});

test("permission removal between list and mutation is checked on Discord again", async () => {
  const f = fixture();
  let permissions = "8";
  let discordCalls = 0;
  f.dependencies.fetch = (async (url) => {
    discordCalls++;
    return Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test", permissions }] : { id: user, username: "tester" });
  }) as typeof fetch;
  const session = await request();
  assert.equal((await handleModeration(session.clone(), undefined, f.dependencies)).status, 200);
  permissions = "32";
  assert.equal((await handleModeration(new Request(session, { method: "POST" }), id, f.dependencies)).status, 403);
  assert.equal(discordCalls, 4);
  assert.deepEqual(f.calls, ["list"]);
});

test("session, upstream failures, CSRF, registry, query validation and limits fail closed", async () => {
  const f = fixture();
  assert.equal((await handleModeration(new Request("https://dashboard.example/?guildId=" + guild), undefined, f.dependencies)).status, 401);
  for (const fetcher of [(async () => { throw new Error("private-secret"); }) as typeof fetch, (async () => Response.json({}, { status: 500 })) as typeof fetch, (async () => new Response("private-secret", { status: 429, headers: { "Retry-After": "120" } })) as typeof fetch, (async () => new Response("private-secret")) as typeof fetch, (async () => Response.json({})) as typeof fetch]) {
    const response = await handleModeration(await request("POST"), id, { ...f.dependencies, fetch: fetcher });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private-secret/);
  }
  assert.equal((await handleModeration(await request("POST", `guildId=${guild}`, "https://evil.example"), id, f.dependencies)).status, 403);
  assert.equal((await handleModeration(new Request(await request("POST"), { headers: { origin: env.APP_URL, "sec-fetch-site": "cross-site" } }), id, f.dependencies)).status, 403);
  assert.equal((await handleModeration(await request(), undefined, { ...f.dependencies, env: { ...env, PROFILE_BOT_GUILD_IDS: other } })).status, 403);
  for (const query of [`guildId=${other}`, `guildId=${guild}&guildId=${guild}`, `guildId=${guild}&after=bad`, `guildId=${guild}&limit=1000`, `guildId=${guild}&userId=${other}`]) {
    assert.ok((await handleModeration(await request("GET", query), undefined, f.dependencies)).status >= 400);
  }
  assert.equal((await handleModeration(await request(), undefined, { ...f.dependencies, limit: () => false })).status, 429);
  assert.deepEqual(f.calls, []);
});

test("cross-guild database row cannot leak metadata or preview", async () => {
  const f = fixture();
  f.dependencies.store!.list = async () => [{ ...row, owner_guild_id: other }];
  f.dependencies.store!.get = async () => ({ ...row, owner_guild_id: other });
  assert.equal((await handleModeration(await request(), undefined, f.dependencies)).status, 503);
  assert.equal((await handleModeration(await request(), id, f.dependencies)).status, 404);
  f.dependencies.store!.disable = async () => false;
  assert.equal((await handleModeration(await request("POST"), id, f.dependencies)).status, 404);
});
