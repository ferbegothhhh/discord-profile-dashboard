import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api-security.ts";
import { botLevelConfig, getCurrentLevel } from "../lib/bot-level.ts";

const userId = "123456789012345678";
const guildId = "234567890123456789";
const apiKey = "abcdefghijklmnopqrstuvwxyz012345";
const env = { PROFILE_LEVEL_API_URL: "https://bot.example", PROFILE_LEVEL_API_KEY: apiKey };
const payload = { status: "ready", userId, guildId, level: 45 };
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "level_unavailable" && error.message === "level_unavailable" && !error.cause;
const json = (value: unknown = payload) => Response.json(value);
const mockFetch = (response: Response): typeof fetch => async () => response;

test("config accepts HTTPS origins and independent strong keys", () => {
  assert.deepEqual(botLevelConfig(env), { origin: "https://bot.example", apiKey });
  assert.deepEqual(botLevelConfig({ ...env, PROFILE_LEVEL_API_URL: "https://bot.example:8443/", PROFILE_BOT_API_KEY: "different" }), { origin: "https://bot.example:8443", apiKey });
  for (const length of [32, 256]) assert.ok(botLevelConfig({ ...env, PROFILE_LEVEL_API_KEY: apiKey.repeat(8).slice(0, length) }));
  assert.ok(botLevelConfig({ ...env, PROFILE_LEVEL_API_KEY: "abcdefghijklmnop".repeat(2) }));
});

test("config rejects missing, weak, malformed and shared credentials", () => {
  assert.equal(botLevelConfig({}), null);
  for (const key of [undefined, "", "a".repeat(32), "abcdefghijklmno".repeat(3), apiKey.slice(0, 31), apiKey.repeat(9), `${apiKey}=`, `${apiKey}\n`, ` ${apiKey}`, `${apiKey}+`]) {
    assert.equal(botLevelConfig({ ...env, PROFILE_LEVEL_API_KEY: key }), null);
  }
  assert.equal(botLevelConfig({ ...env, PROFILE_BOT_API_KEY: apiKey }), null);
});

test("config rejects non-origins and insecure remote URLs", () => {
  for (const url of [undefined, "", "invalid", "ftp://bot.example", "http://bot.example", "https://user:password@bot.example", "https://bot.example/path", "https://bot.example/?x=1", "https://bot.example/#x", "https://bot.example/?", "https://bot.example/#", " https://bot.example", "https://bot.example/../", "https://bot.example\\path"]) {
    assert.equal(botLevelConfig({ ...env, PROFILE_LEVEL_API_URL: url, NODE_ENV: "development" }), null);
  }
});

test("HTTP loopback requires explicit development", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const local = { ...env, PROFILE_LEVEL_API_URL: `http://${host}:3000` };
    assert.ok(botLevelConfig({ ...local, NODE_ENV: "development" }));
    for (const mode of [undefined, "production", "test", ""]) assert.equal(botLevelConfig({ ...local, NODE_ENV: mode }), null);
  }
  for (const host of ["0.0.0.0", "192.168.0.1", "localhost.example", "127.0.0.2"]) assert.equal(botLevelConfig({ ...env, NODE_ENV: "development", PROFILE_LEVEL_API_URL: `http://${host}` }), null);
});

test("production requires an exact operator host allowlist and rejects private literals", async () => {
  const production = { ...env, NODE_ENV: "production", PROFILE_LEVEL_API_URL: "https://bot.example.com", PROFILE_LEVEL_API_ALLOWED_HOSTS: "bot.example.com" };
  assert.ok(botLevelConfig(production));
  for (const hosts of [undefined, "", "*.example.com", "example.com", "bot.example.com/path"]) {
    assert.equal(botLevelConfig({ ...production, PROFILE_LEVEL_API_ALLOWED_HOSTS: hosts }), null);
  }
  for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "[::1]", "[fc00::1]", "bot.internal", "bot.local"]) {
    const invalid = { ...production, PROFILE_LEVEL_API_URL: `https://${host}`, PROFILE_LEVEL_API_ALLOWED_HOSTS: host };
    assert.equal(botLevelConfig(invalid), null);
    await assert.rejects(getCurrentLevel(userId, guildId, invalid, async () => { assert.fail("unexpected fetch"); }), unavailable);
  }
});

test("fetch sends only the configured bearer and returns an uncached snapshot", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, env.PROFILE_LEVEL_API_URL);
    assert.equal(url.pathname, "/api/profile-level");
    assert.deepEqual([...url.searchParams], [["userId", userId], ["guildId", guildId]]);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${apiKey}`, Accept: "application/json" });
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return json({ ...payload, level: calls - 1 });
  };
  assert.deepEqual(await getCurrentLevel(userId, guildId, env, fetcher), { userId, guildId, level: 0 });
  assert.deepEqual(await getCurrentLevel(userId, guildId, env, fetcher), { userId, guildId, level: 1 });
  assert.equal(calls, 2);
});

test("invalid identities and configuration never fetch", async () => {
  const fetcher: typeof fetch = async () => { assert.fail("unexpected fetch"); };
  for (const id of ["", "0".repeat(18), "012345678901234567", "1".repeat(16), "1".repeat(21), `${userId}&x=y`]) {
    await assert.rejects(getCurrentLevel(id, guildId, env, fetcher), { status: 400, code: "invalid_user" });
    await assert.rejects(getCurrentLevel(userId, id, env, fetcher), { status: 400, code: "invalid_guild" });
  }
  await assert.rejects(getCurrentLevel(userId, guildId, {}, fetcher), unavailable);
});

test("all upstream statuses, redirects and exceptions are sanitized without retries", async () => {
  for (const status of [204, 301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 503]) {
    await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(null, { status }))), unavailable);
  }
  const redirected = json();
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(redirected)), unavailable);
  let calls = 0;
  await assert.rejects(getCurrentLevel(userId, guildId, env, async () => { calls++; throw new Error(apiKey); }), unavailable);
  assert.equal(calls, 1);
});

test("requires strict JSON content type and valid UTF-8 JSON", async () => {
  for (const type of ["", "text/json", "text/html", "application/jsonp", "application/problem+json", "application/json; charset=latin1", "application/json; x=y"]) {
    await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(JSON.stringify(payload), { headers: { "Content-Type": type } }))), unavailable);
  }
  assert.deepEqual(await getCurrentLevel(userId, guildId, env, mockFetch(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json; charset=utf-8" } }))), { userId, guildId, level: 45 });
  for (const body of ["", "not json", "{} trailing", new Uint8Array([0xff])]) await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(body, { headers: { "Content-Type": "application/json" } }))), unavailable);
});

test("requires exact ready identity and a nonnegative safe integer level", async () => {
  for (const value of [null, [], 45, {}, { ...payload, extra: true }, { ...payload, status: "pending" }, { userId, guildId, level: 45 }, { ...payload, userId: guildId }, { ...payload, guildId: userId }, { ...payload, userId: Number(userId) }, ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "45", null].map((level) => ({ ...payload, level }))]) {
    await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(json(value))), unavailable);
  }
  assert.equal((await getCurrentLevel(userId, guildId, env, mockFetch(json({ ...payload, level: Number.MAX_SAFE_INTEGER })))).level, Number.MAX_SAFE_INTEGER);
});

test("bounds declared and streamed body bytes and cancels oversize streams", async () => {
  for (const length of ["4097", "-1", "abc", "1.5"]) await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json", "Content-Length": length } }))), unavailable);
  const text = JSON.stringify(payload);
  assert.equal((await getCurrentLevel(userId, guildId, env, mockFetch(new Response(text.padEnd(4096), { headers: { "Content-Type": "application/json" } })))).level, 45);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.enqueue(new Uint8Array(4096)); }, cancel() { cancelled = true; } });
  await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(stream, { headers: { "Content-Type": "application/json", "Content-Length": "1" } }))), unavailable);
  assert.equal(cancelled, true);
});

test("accepts split streamed JSON and sanitizes stream errors", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  assert.equal((await getCurrentLevel(userId, guildId, env, mockFetch(new Response(stream, { headers: { "Content-Type": "application/json" } })))).level, 45);
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(apiKey)); } });
  await assert.rejects(getCurrentLevel(userId, guildId, env, mockFetch(new Response(broken, { headers: { "Content-Type": "application/json" } }))), unavailable);
});

test("deadline aborts even when fetch ignores the signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  const pending = getCurrentLevel(userId, guildId, env, async (_, init) => { signal = init?.signal; return new Promise<Response>(() => {}); });
  const rejected = assert.rejects(pending, unavailable);
  t.mock.timers.tick(1999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});

test("the same deadline covers body consumption and cancels stalled reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = getCurrentLevel(userId, guildId, env, async (_, init) => {
    signal = init?.signal;
    t.mock.timers.tick(1500);
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
  });
  const rejected = assert.rejects(pending, unavailable);
  await Promise.resolve();
  t.mock.timers.tick(499);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});
