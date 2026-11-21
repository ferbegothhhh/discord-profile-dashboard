import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import sharp from "sharp";
import { ApiError } from "../lib/api-security.ts";
import { handleBackgroundUpload, type BackgroundUploadDependencies, type BackgroundUploadStore } from "../lib/background-upload.ts";
import { MAX_IMAGE_BYTES } from "../lib/image-processing.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_GUILD_IDS: guild };
const fetcher = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "tester" })) as typeof fetch;
const image = () => sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
async function browser(body: BodyInit | null = "invalid", headers: HeadersInit = {}, query = `guildId=${guild}`) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example/api/backgrounds/slots/1?${query}`, { method: "PUT", body, headers: { cookie, origin: env.APP_URL, "content-type": "image/png", ...headers } });
}
function fixture() {
  let row: Parameters<BackgroundUploadStore["reserve"]>[1] | undefined;
  let status = "empty";
  const events: string[] = [];
  const queued: string[] = [];
  const store: BackgroundUploadStore = {
    async reserve(owner, reservation) {
      events.push("reserve");
      assert.deepEqual(owner, { userId: user, guildId: guild, slot: 1 });
      assert.match(reservation.id, /^[a-f0-9-]{36}$/);
      assert.match(reservation.object_key, /^profile-images\/[a-f0-9]{32}\.png$/);
      assert.equal(reservation.revision, 1);
      if (row) throw new ApiError(409, "slot_occupied");
      row = reservation;
      status = "processing";
      return reservation;
    },
    async finalize(_owner, reservation, bytes, level) {
      events.push("finalize");
      assert.equal(row, reservation);
      assert.equal(status, "processing");
      assert.ok(bytes > 0);
      assert.ok(level >= 20);
      status = "ready";
    },
    async abort(_owner, reservation) {
      events.push("abort");
      if (row !== reservation || status !== "processing") throw new Error("Reservation unavailable");
      queued.push(reservation.object_key);
      row = undefined;
      status = "empty";
      return reservation.object_key;
    },
  };
  const dependencies: BackgroundUploadDependencies = {
    env, fetch: fetcher, limit: () => true, store,
    getLevel: async () => { events.push("level"); return { userId: user, guildId: guild, level: 65 }; },
    storage: {
      async upload(png, key) {
        events.push("upload");
        assert.equal(key, row?.object_key);
        const metadata = await sharp(png).metadata();
        assert.equal(metadata.format, "png");
        assert.equal(metadata.width, 1000);
        assert.equal(metadata.height, 560);
        return { object_key: key! };
      },
      async delete(key) { events.push("delete"); assert.ok(queued.includes(key)); },
    },
  };
  return { dependencies, store, events, queued, status: () => status };
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

test("valid upload reserves generated key, normalizes PNG, rechecks fresh level and commits", async () => {
  const f = fixture();
  const body = await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), 201);
  assert.equal(body.background.name, "Background pribadi 1");
  assert.equal(body.background.revision, 2);
  assert.equal(body.background.isActive, true);
  assert.deepEqual(f.events, ["level", "reserve", "upload", "level", "finalize"]);
  assert.equal(f.status(), "ready");
  assert.deepEqual(f.queued, []);
  await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), 409, "slot_occupied");
  assert.equal(f.status(), "ready");
  assert.ok(!f.events.includes("delete"));
});

test("auth, exact origin, CSRF, registry, membership, rate and input gates run before body or reservation", async () => {
  const f = fixture();
  await check(await handleBackgroundUpload(new Request(await browser(), { headers: { origin: env.APP_URL } }), "1", f.dependencies), 401);
  for (const headers of [{ origin: "https://evil.example" }, { origin: `${env.APP_URL}/` }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    await check(await handleBackgroundUpload(await browser(undefined, headers), "1", f.dependencies), 403, "csrf");
  }
  await check(await handleBackgroundUpload(await browser(), "1", { ...f.dependencies, limit: () => false }), 429);
  await check(await handleBackgroundUpload(await browser(), "1", { ...f.dependencies, env: { ...env, PROFILE_BOT_GUILD_IDS: other } }), 403);
  await check(await handleBackgroundUpload(await browser(), "1", { ...f.dependencies, fetch: (async (url) => Response.json(String(url).includes("guilds") ? [] : { id: user, username: "tester" })) as typeof fetch }), 403);
  for (const slot of ["0", "4", "01", "1.0", "-1", "", "NaN"]) await check(await handleBackgroundUpload(await browser(), slot, f.dependencies), 400, "invalid_slot");
  for (const query of ["", "guildId=bad", `guildId=${guild}&guildId=${guild}`, `guildId=${guild}&objectKey=evil`, `guildId=${guild}&userId=${other}`]) {
    await check(await handleBackgroundUpload(await browser(undefined, {}, query), "1", f.dependencies), 400);
  }
  assert.deepEqual(f.events, []);
});

test("locked, mismatched and unavailable levels fail closed before reservation or decoding", async () => {
  for (const snapshot of [{ userId: user, guildId: guild, level: 19 }, { userId: other, guildId: guild, level: 65 }, { userId: user, guildId: other, level: 65 }, { userId: user, guildId: guild, level: NaN }, { userId: user, guildId: guild, level: -1 }]) {
    const f = fixture();
    await check(await handleBackgroundUpload(await browser(), "1", { ...f.dependencies, getLevel: async () => snapshot }), snapshot.level === 19 ? 403 : 503);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  await check(await handleBackgroundUpload(await browser(), "1", { ...f.dependencies, getLevel: async () => { throw new Error("private-secret"); } }), 503);
  assert.deepEqual(f.events, []);
});

test("locked slot rejects without pulling binary request stream", async () => {
  const f = fixture();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulls++; throw new Error("Body must not be read"); } }, { highWaterMark: 0 });
  const request = new Request(await browser(), { body, duplex: "half" } as RequestInit);
  await check(await handleBackgroundUpload(request, "3", { ...f.dependencies, getLevel: async () => ({ userId: user, guildId: guild, level: 64 }) }), 403, "slot_locked");
  assert.equal(pulls, 0);
  assert.deepEqual(f.events, []);
  await check(await handleBackgroundUpload(new Request(await browser(), { method: "POST" }), "1", f.dependencies), 405);
});

test("content type and declared length gates reject before reservation", async () => {
  for (const headers of [{ "content-type": "text/plain" }, { "content-type": "image/svg+xml" }, { "content-type": "multipart/form-data" }, { "content-length": String(MAX_IMAGE_BYTES + 1) }, { "content-length": "bad" }] as Record<string, string>[]) {
    const f = fixture();
    await check(await handleBackgroundUpload(await browser(undefined, headers), "1", f.dependencies), "content-type" in headers ? 415 : 413);
    assert.deepEqual(f.events, ["level"]);
  }
});

test("invalid image and actual oversized body abort to durable cleanup before delete", async () => {
  for (const input of [Buffer.from("invalid"), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) {
    const f = fixture();
    await check(await handleBackgroundUpload(await browser(input), "1", f.dependencies), input.length > MAX_IMAGE_BYTES ? 413 : 415);
    assert.deepEqual(f.events, ["level", "reserve", "abort", "delete"]);
    assert.equal(f.queued.length, 1);
    assert.equal(f.status(), "empty");
  }
});

test("level drop or unavailable second snapshot aborts uploaded object without finalize", async () => {
  for (const mode of ["locked", "unavailable", "mismatch"]) {
    const f = fixture();
    let calls = 0;
    f.dependencies.getLevel = async () => {
      if (++calls === 1) return { userId: user, guildId: guild, level: 65 };
      if (mode === "unavailable") throw new ApiError(503, "level_unavailable");
      return { userId: mode === "mismatch" ? other : user, guildId: guild, level: 19 };
    };
    await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), mode === "locked" ? 403 : 503);
    assert.deepEqual(f.events, ["reserve", "upload", "abort", "delete"]);
    assert.equal(f.queued.length, 1);
  }
});

test("upload and finalize failures queue cleanup; cleanup failures stay durable", async () => {
  for (const failure of ["upload", "finalize", "delete"]) {
    const f = fixture();
    if (failure === "upload") f.dependencies.storage!.upload = async () => { throw new Error("private-secret"); };
    else f.store.finalize = async () => { throw new Error("private-secret"); };
    if (failure === "delete") f.dependencies.storage!.delete = async () => { throw new Error("private-secret"); };
    await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), 503);
    assert.equal(f.queued.length, 1);
    assert.equal(f.status(), "empty");
  }
});

test("database abort failure never deletes an object with uncertain ownership", async () => {
  const f = fixture();
  f.store.finalize = async () => { throw new Error("private-secret"); };
  f.store.abort = async () => { throw new Error("private-secret"); };
  await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), 503);
  assert.equal(f.status(), "processing");
  assert.deepEqual(f.queued, []);
  assert.ok(!f.events.includes("delete"));
});

test("ambiguous committed finalize never deletes ready object", async () => {
  const f = fixture();
  const finalize = f.store.finalize;
  f.store.finalize = async (...args) => { await finalize(...args); throw new Error("lost response private-secret"); };
  await check(await handleBackgroundUpload(await browser(await image()), "1", f.dependencies), 503);
  assert.equal(f.status(), "ready");
  assert.deepEqual(f.queued, []);
  assert.ok(!f.events.includes("delete"));
});

test("simultaneous uploads reserve only one row and loser cannot abort winner", async () => {
  const f = fixture();
  const input = await image();
  const requests = await Promise.all([browser(input), browser(input)]);
  const responses = await Promise.all(requests.map((request) => handleBackgroundUpload(request, "1", f.dependencies)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(f.events.filter((event) => event === "upload").length, 1);
  assert.equal(f.events.filter((event) => event === "finalize").length, 1);
  assert.ok(!f.events.includes("delete"));
  assert.equal(f.status(), "ready");
});

test("default RPC adapter scopes ownership, validates metadata and maps occupied conflicts", async () => {
  const dbEnv = { ...env, SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" };
  for (const occupied of [false, true]) {
    const f = fixture();
    const calls: string[] = [];
    const fetch = (async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "database.example") return fetcher(input, init);
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      const args = JSON.parse(String(init?.body));
      assert.equal(args.p_user_id, user);
      assert.equal(args.p_guild_id, guild);
      assert.equal(args.p_slot, 1);
      assert.equal(args.p_revision, 1);
      calls.push(url.pathname);
      if (url.pathname.endsWith("reserve_profile_background")) {
        if (occupied) return Response.json({ code: "23505", message: "private-secret" }, { status: 409 });
        return Response.json([{ id: args.p_id, object_key: args.p_object_key, revision: 1 }]);
      }
      if (url.pathname.endsWith("abort_profile_background")) return Response.json({ code: "23514" }, { status: 400 });
      assert.ok(url.pathname.endsWith("finalize_profile_background"));
      assert.equal(args.p_mime, "image/png");
      assert.equal(args.p_width, 1000);
      assert.equal(args.p_height, 560);
      assert.equal(args.p_level, 65);
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    await check(await handleBackgroundUpload(await browser(await image()), "1", { ...f.dependencies, env: dbEnv, fetch, store: undefined, storage: { upload: async (_png, key) => ({ object_key: key! }), delete: async () => assert.fail("Unexpected deletion") } }), occupied ? 409 : 201);
    assert.equal(calls.length, 2);
  }
});
