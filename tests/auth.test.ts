import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { authenticatedMember, authConfig, handleAuth, validSession, validState } from "../lib/auth.ts";
import { ApiError } from "../lib/api-security.ts";
import { setTimeout as delay } from "node:timers/promises";

const env = { PROFILE_BOT_GUILD_IDS: "123456789012345678", NODE_ENV: "test", DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "mock-secret", APP_URL: "http://localhost:3000", SESSION_PASSWORD: "mock-password-only-for-tests-1234567890" };
const now = 1800000000000;
const state = "s".repeat(43);
const verifier = "v".repeat(43);
const id = "123456789012345678";
const deps = { env, now: () => now, limit: () => true };
const req = (path: string, init?: RequestInit) => new Request(`http://attacker.invalid/api/auth/${path}`, init);
async function flowCookie(expiresAt = now + 600000) {
  return `profile_oauth=${await sealData({ state, verifier, expiresAt }, { password: env.SESSION_PASSWORD, ttl: 600 })}`;
}
async function sessionCookie(expiresAt = now + 600000) {
  return `profile_session=${await sealData({ accessToken: "mock-access-token", expiresAt }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
}
const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;

test("configuration rejects missing secrets, unsafe origins and production HTTP", () => {
  assert.equal(authConfig({}), null);
  assert.equal(authConfig({ ...env, APP_URL: "https://example.com/path" }), null);
  assert.equal(authConfig({ ...env, NODE_ENV: "production" }), null);
  assert.equal(authConfig({ ...env, APP_URL: "https://example.com" })?.origin, "https://example.com");
});

test("state uses strict shape, expiry and session rejects expiry", () => {
  assert.equal(validState({ state, verifier, expiresAt: now + 1000 }, state, now), true);
  for (const candidate of [null, "", "x", "a".repeat(43)]) assert.equal(validState({ state, verifier, expiresAt: now + 1000 }, candidate, now), false);
  assert.equal(validState({ state, verifier, expiresAt: now }, state, now), false);
  assert.equal(validSession({ accessToken: "mock", expiresAt: now }, now), false);
});

test("missing config is useful and private, including callback clearing state", async () => {
  const response = await handleAuth(req("session"), "session", { env: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "setup_required");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const callback = await handleAuth(req("discord/callback"), "discord/callback", { env: {} });
  assert.match(callback.headers.get("set-cookie")!, /profile_oauth=;.*Max-Age=0/);
  assert.equal(callback.headers.get("location"), "/?auth_error=setup#discord");
});

test("authorization binds fixed origin, minimum scopes, random state and S256", async () => {
  const response = await handleAuth(req("discord?next=https://attacker.invalid"), "discord", deps);
  const url = new URL(response.headers.get("location")!);
  assert.equal(url.origin, "https://discord.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000/api/auth/discord/callback");
  assert.equal(url.searchParams.get("scope"), "identify guilds");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(response.headers.get("set-cookie")!, /SameSite=Lax/i);
  const other = await handleAuth(req("discord"), "discord", deps);
  assert.notEqual(response.headers.get("location"), other.headers.get("location"));
});

test("all callback failures consume state without leaking codes or upstream bodies", async () => {
  for (const query of ["state=wrong&code=sensitive", `state=${state}&error=secret-details`, `state=${state}`, `state=${state}&code=sensitive&iss=https://attacker.invalid`, `state=${state}&code=sensitive&state=${state}`]) {
    const response = await handleAuth(req(`discord/callback?${query}`, { headers: { cookie: await flowCookie() } }), "discord/callback", { ...deps, fetch: mockFetch(() => { throw new Error("must not fetch"); }) });
    assert.equal(response.status, 303);
    assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
    assert.doesNotMatch(response.headers.get("location")!, /sensitive|secret-details|attacker/);
  }
  const response = await handleAuth(req(`discord/callback?state=${state}&code=sensitive`, { headers: { cookie: await flowCookie(now) } }), "discord/callback", deps);
  assert.match(response.headers.get("location")!, /auth_error=state/);
});

test("mock code exchange passes verifier, creates bounded encrypted cookie and excludes refresh token", async () => {
  let exchanged = false;
  const response = await handleAuth(req(`discord/callback?state=${state}&code=mock-code`, { headers: { cookie: await flowCookie() } }), "discord/callback", {
    ...deps,
    fetch: mockFetch((url, init) => {
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      if (url.endsWith("oauth2/token")) {
        const body = init?.body as URLSearchParams;
        assert.equal(body.get("code_verifier"), verifier);
        assert.equal(body.get("redirect_uri"), "http://localhost:3000/api/auth/discord/callback");
        exchanged = true;
        return Response.json({ access_token: "mock-access-token", refresh_token: "mock-refresh-token", expires_in: 3600, token_type: "Bearer", scope: "identify guilds" });
      }
      return Response.json({ id, username: "mock-account", global_name: null });
    }),
  });
  assert.equal(exchanged, true);
  assert.equal(response.headers.get("location"), "http://localhost:3000/#discord");
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /profile_session=/);
  assert.match(cookie, /Max-Age=3570/);
  assert.doesNotMatch(cookie, /mock-access-token|mock-refresh-token/);
  assert.ok(cookie.length < 4096);
});

test("sessions return validated identity and memberships only; expired or tampered cookies sign out", async () => {
  for (const cookie of [await sessionCookie(now), "profile_session=tampered", ""]) {
    const response = await handleAuth(req("session", { headers: { cookie } }), "session", deps);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
  }
  const response = await handleAuth(req("session", { headers: { cookie: await sessionCookie() } }), "session", { ...deps, fetch: mockFetch((url) => Response.json(url.includes("guilds?") ? [{ id, name: "Mock guild" }] : { id, username: "mock-account", global_name: "Mock identity" })) });
  assert.deepEqual(await response.json(), { status: "authenticated", user: { id, username: "mock-account", name: "Mock identity" }, guilds: [{ id, name: "Mock guild" }] });
});

test("upstream failures and invalid data are sanitized; 401 clears session", async () => {
  for (const result of [new Response("raw-secret-body", { status: 500 }), Response.json({ bad: "shape" }), Response.json([{ id: "bad", name: "bad" }])]) {
    const response = await handleAuth(req("session", { headers: { cookie: await sessionCookie() } }), "session", { ...deps, fetch: mockFetch(() => result) });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /raw-secret-body|shape/);
  }
  const expired = await handleAuth(req("session", { headers: { cookie: await sessionCookie() } }), "session", { ...deps, fetch: mockFetch(() => new Response(null, { status: 401 })) });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("set-cookie")!, /Max-Age=0/);
  const callback = await handleAuth(req(`discord/callback?state=${state}&code=mock-code`, { headers: { cookie: await flowCookie() } }), "discord/callback", { ...deps, fetch: mockFetch(() => { throw new Error("secret network details"); }) });
  assert.match(callback.headers.get("location")!, /auth_error=upstream/);
  assert.match(callback.headers.get("set-cookie")!, /Max-Age=0/);
});

test("logout is POST only and verifies exact configured Origin", async () => {
  assert.equal((await handleAuth(req("logout"), "logout", deps)).status, 405);
  for (const origin of ["", "https://attacker.invalid", "http://localhost:3000.attacker.invalid"]) {
    const response = await handleAuth(req("logout", { method: "POST", headers: { origin } }), "logout", deps);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const response = await handleAuth(req("logout", { method: "POST", headers: { origin: env.APP_URL } }), "logout", deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /profile_session=;.*Max-Age=0/);
  assert.match(response.headers.get("set-cookie")!, /profile_oauth=;/);
});

test("member authorization allows sequential Discord latency above the old two-second budget", async () => {
  const signals: AbortSignal[] = [];
  const result = await authenticatedMember(req("session", { headers: { cookie: await sessionCookie() } }), authConfig(env)!, {
    ...deps,
    fetch: mockFetch(async (url, init) => {
      signals.push(init!.signal!);
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      await delay(1150, undefined, { signal: init!.signal! });
      return Response.json(url.includes("guilds?") ? [{ id, name: "Guild", permissions: "8" }] : { id, username: "tester" });
    }),
  });
  assert.equal(result.guilds[0].canModerate, true);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, false);
});

test("simultaneous member reads stay token-isolated and later operations validate again", async () => {
  const other = "223456789012345678";
  let calls = 0;
  const requests = await Promise.all(["first-token", "second-token"].map(async (accessToken) => req("session", { headers: { cookie: `profile_session=${await sealData({ accessToken, expiresAt: now + 600000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}` } })));
  const fetch = mockFetch(async (url, init) => {
    calls++;
    const first = new Headers(init?.headers).get("authorization") === "Bearer first-token";
    await delay(20);
    return Response.json(url.includes("guilds?") ? [{ id: first ? id : other, name: "Guild", permissions: first ? "8" : "32" }] : { id: first ? id : other, username: "tester" });
  });
  const results = await Promise.all(requests.map((request) => authenticatedMember(request, authConfig(env)!, { ...deps, fetch })));
  assert.deepEqual(results.map((result) => [result.user.id, result.guilds[0].id, result.guilds[0].canModerate]), [[id, id, true], [other, other, undefined]]);
  assert.equal(calls, 4);
  await authenticatedMember(requests[0], authConfig(env)!, { ...deps, fetch });
  assert.equal(calls, 6);
});

test("Discord 429 with Retry-After and invalid JSON fail closed without retry or stale authorization", async () => {
  for (const guildFailure of [false, true]) {
    for (const status of [429, 401, 200]) {
      let calls = 0;
      const fetch = mockFetch((url) => {
        calls++;
        if (guildFailure && !url.includes("guilds?")) return Response.json({ id, username: "tester" });
        return new Response("private-invalid-json", { status, headers: { "Retry-After": "120" } });
      });
      await assert.rejects(authenticatedMember(req("session", { headers: { cookie: await sessionCookie() } }), authConfig(env)!, { ...deps, fetch }), (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, status === 401 ? 401 : 503);
        assert.doesNotMatch(error.message, /private-invalid-json|mock-access-token/);
        return true;
      });
      assert.equal(calls, guildFailure ? 2 : 1);
    }
  }
});

test("rate limits avoid upstream calls and production cookies are Secure", async () => {
  const limited = await handleAuth(req("discord"), "discord", { ...deps, limit: () => false });
  assert.equal(limited.status, 429);
  const response = await handleAuth(req("discord"), "discord", { ...deps, env: { ...env, NODE_ENV: "production", APP_URL: "https://example.com" } });
  assert.match(response.headers.get("set-cookie")!, /Secure/);
});
