import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sealData } from "iron-session";
import { ApiError } from "../lib/api-security.ts";
import { handleBackgroundDelete, type BackgroundDeleteDependencies } from "../lib/background-delete.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const key = `profile-images/${"a".repeat(32)}.png`;
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild };
const fetcher = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "tester" })) as typeof fetch;
async function browser(headers: Record<string, string> = {}, query = `guildId=${guild}`) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/backgrounds/slots/3?${query}`, { method: "DELETE", headers: { cookie, origin: env.APP_URL, ...headers } });
}
function fixture() {
  const events: string[] = [];
  const queued: string[] = [];
  let exists = true;
  const dependencies: BackgroundDeleteDependencies = {
    env, discordScope: {}, fetch: fetcher, limit: (id) => { assert.equal(id, user); return true; },
    store: { async deleteSlot(owner) {
      assert.deepEqual(owner, { userId: user, guildId: guild, slot: 3 });
      events.push("store");
      if (!exists) return { removed: false, object_key: null };
      queued.push(key);
      exists = false;
      return { removed: true, object_key: key };
    } },
    storage: { async delete(value) { assert.equal(value, key); assert.ok(queued.includes(key)); events.push("storage"); } },
  };
  return { dependencies, events, queued };
}
async function check(response: Response, status: number, error?: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control")!, /private, no-store/);
  assert.match(response.headers.get("vary")!, /Cookie/);
  const body = await response.json();
  if (error) assert.equal(body.error, error);
  assert.doesNotMatch(JSON.stringify(body), /object_key|profile-images|private-secret/);
  return body;
}

test("locked retained slot deletes without a level provider, queues first and is idempotent", async () => {
  const f = fixture();
  assert.deepEqual(await check(await handleBackgroundDelete(await browser(), "3", f.dependencies), 200), { status: "deleted", guildId: guild, slot: 3, removed: true, cleanupPending: false });
  assert.deepEqual(await check(await handleBackgroundDelete(await browser(), "3", f.dependencies), 200), { status: "deleted", guildId: guild, slot: 3, cleanupPending: false });
  assert.deepEqual(f.events, ["store", "storage", "store"]);
  assert.deepEqual(f.queued, [key]);
});

test("auth, CSRF, registry, membership, limiter and exact owner input gates", async () => {
  const f = fixture();
  await check(await handleBackgroundDelete(new Request(await browser(), { headers: { origin: env.APP_URL } }), "3", f.dependencies), 401);
  for (const headers of [{ origin: "https://evil.example" }, { origin: `${env.APP_URL}/` }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    await check(await handleBackgroundDelete(await browser(headers), "3", f.dependencies), 403, "csrf");
  }
  await check(await handleBackgroundDelete(await browser(), "3", { ...f.dependencies, limit: () => false }), 429);
  await check(await handleBackgroundDelete(await browser(), "3", { ...f.dependencies, env: { ...env, PROFILE_BOT_GUILD_IDS: other } }), 403);
  await check(await handleBackgroundDelete(await browser(), "3", { ...f.dependencies, fetch: (async (url) => Response.json(String(url).includes("guilds") ? [] : { id: user, username: "tester" })) as typeof fetch }), 403);
  for (const slot of ["0", "4", "03", "3.0", "-1", ""]) await check(await handleBackgroundDelete(await browser(), slot, f.dependencies), 400);
  for (const query of ["", "guildId=bad", `guildId=${guild}&guildId=${guild}`, `guildId=${guild}&userId=${other}`, `guildId=${guild}&objectKey=${key}`, `guildId=${guild}&slot=1`]) await check(await handleBackgroundDelete(await browser({}, query), "3", f.dependencies), 400);
  await check(await handleBackgroundDelete(new Request(await browser(), { method: "PUT" }), "3", f.dependencies), 405);
  assert.deepEqual(f.events, []);
});

test("session is rechecked after fresh Discord membership lookup", async () => {
  const f = fixture();
  let calls = 0;
  await check(await handleBackgroundDelete(await browser(), "3", { ...f.dependencies, now: () => ++calls === 1 ? Date.now() : Date.now() + 120000 }), 401);
  assert.deepEqual(f.events, []);
});

test("store errors never delete storage or claim success; processing conflicts stay 409", async () => {
  for (const error of [new Error("private-secret"), new ApiError(409, "slot_processing")]) {
    const f = fixture();
    f.dependencies.store!.deleteSlot = async () => { throw error; };
    await check(await handleBackgroundDelete(await browser(), "3", f.dependencies), error instanceof ApiError ? 409 : 503);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.queued, []);
  }
});

test("failed immediate cleanup reports removal and pending durable cleanup", async () => {
  const f = fixture();
  f.dependencies.storage!.delete = async () => { throw new Error("private-secret"); };
  const body = await check(await handleBackgroundDelete(await browser(), "3", f.dependencies), 200);
  assert.equal(body.removed, true);
  assert.equal(body.cleanupPending, true);
  assert.deepEqual(f.queued, [key]);
});

test("default RPC scopes only server-derived owner, validates response and maps processing", async () => {
  const dbEnv = { ...env, SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };
  for (const result of [{ removed: true, object_key: key }, { removed: false, object_key: null }, null, [], {}, { removed: false, object_key: key }, { removed: true, object_key: "../secret" }, { removed: true, object_key: key, extra: true }, "processing", "failure"]) {
    const f = fixture();
    let deleted = false;
    const fetch = (async (input, init) => {
      if (new URL(String(input)).hostname !== "database.example") return fetcher(input, init);
      assert.equal(new URL(String(input)).pathname, "/rest/v1/rpc/delete_profile_background_slot");
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { p_user_id: user, p_guild_id: guild, p_slot: 3 });
      if (typeof result === "string") return Response.json({ code: result === "processing" ? "55000" : "23514", message: "private-secret" }, { status: 400 });
      return Response.json(result);
    }) as typeof globalThis.fetch;
    const valid = result !== null && typeof result === "object" && "removed" in result && (result.object_key === key && result.removed === true && !("extra" in result) || result.object_key === null && result.removed === false);
    await check(await handleBackgroundDelete(await browser(), "3", { ...f.dependencies, env: dbEnv, fetch, store: undefined, storage: { async delete(value) { assert.equal(value, key); deleted = true; } } }), valid ? 200 : result === "processing" ? 409 : 503);
    assert.equal(deleted, valid && result !== null && typeof result === "object" && "removed" in result && result.removed === true);
  }
});

test("route exports typed DELETE wrapper and preserves PUT", async () => {
  const source = await readFile(new URL("../app/api/backgrounds/slots/[slot]/route.ts", import.meta.url), "utf8");
  assert.match(source, /type Context = \{ params: Promise<\{ slot: string \}> \}/);
  assert.match(source, /export async function DELETE\(request: Request, context: Context\)/);
  assert.match(source, /return handleBackgroundDelete\(request, \(await context.params\).slot\)/);
  assert.match(source, /return handleBackgroundUpload\(request, \(await context.params\).slot\)/);
});
