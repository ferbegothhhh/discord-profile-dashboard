import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { authenticatedMember, authConfig, handleAuth, validSession, validState } from "../lib/auth.ts";
import { ApiError } from "../lib/api-security.ts";
import { setTimeout as delay } from "node:timers/promises";
import { handlePreferences } from "../lib/preferences.ts";
import { handleBackgroundLibrary } from "../lib/background-library.ts";
import { handleModeration } from "../lib/background-moderation.ts";
import { handleBackgroundUpload } from "../lib/background-upload.ts";
import { handleBackgroundDelete } from "../lib/background-delete.ts";
import { handleProfilePreview } from "../lib/profile-preview.ts";

const env = { PROFILE_BOT_GUILD_IDS: "123456789012345678", NODE_ENV: "test", DISCORD_CLIENT_ID: "123456789012345678", DISCORD_CLIENT_SECRET: "mock-secret", APP_URL: "http://localhost:3000", SESSION_PASSWORD: "mock-password-only-for-tests-1234567890" };
const now = 1800000000000;
const state = "s".repeat(43);
const verifier = "v".repeat(43);
const id = "123456789012345678";
const deps = { env, now: () => now, limit: () => true, discordScope: {} };
test.beforeEach(() => { deps.discordScope = {}; });
const req = (path: string, init?: RequestInit) => new Request(`http://attacker.invalid/api/auth/${path}`, init);
async function flowCookie(expiresAt = now + 600000) {
  return `profile_oauth=${await sealData({ state, verifier, expiresAt }, { password: env.SESSION_PASSWORD, ttl: 600 })}`;
}
async function sessionCookie(expiresAt = now + 600000) {
  return `profile_session=${await sealData({ accessToken: "mock-access-token", expiresAt }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
}
const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch;

test("async auth limits deny before authorization, token exchange or identity fetch", async () => {
  let calls = 0;
  const dependencies = { ...deps, limit: async () => { await delay(1); return false; }, fetch: mockFetch(() => { calls++; throw new Error("must not fetch"); }) };
  const start = await handleAuth(req("discord"), "discord", dependencies);
  assert.equal(start.status, 429);
  assert.equal(start.headers.get("set-cookie"), null);
  const callback = await handleAuth(req(`discord/callback?state=${state}&code=mock`, { headers: { cookie: await flowCookie() } }), "discord/callback", dependencies);
  assert.match(callback.headers.get("location")!, /auth_error=rate_limited/);
  assert.match(callback.headers.get("set-cookie")!, /Max-Age=0/);
  const session = await handleAuth(req("session", { headers: { cookie: await sessionCookie() } }), "session", dependencies);
  assert.equal(session.status, 429);
  assert.equal(session.headers.get("retry-after"), "60");
  assert.equal(calls, 0);
});

test("auth shared limiter configuration fails closed with setup callback handling", async () => {
  const dependencies = { ...deps, limit: undefined, env: { ...env, PROFILE_RATE_LIMIT_BACKEND: "invalid" }, fetch: mockFetch(() => { throw new Error("must not fetch"); }) };
  const start = await handleAuth(req("discord"), "discord", dependencies);
  assert.equal(start.status, 503);
  assert.deepEqual(await start.json(), { error: "rate_limit_unavailable" });
  const callback = await handleAuth(req(`discord/callback?state=${state}&code=mock`, { headers: { cookie: await flowCookie() } }), "discord/callback", dependencies);
  assert.match(callback.headers.get("location")!, /auth_error=setup/);
});

test("browser callers await async denial before body, level, database or storage", async () => {
  const callers = [
    (request: Request, dependencies: Parameters<typeof handlePreferences>[1]) => handlePreferences(request, dependencies),
    (request: Request, dependencies: Parameters<typeof handleBackgroundLibrary>[1]) => handleBackgroundLibrary(request, dependencies),
    (request: Request, dependencies: Parameters<typeof handleModeration>[2]) => handleModeration(request, undefined, dependencies),
    (request: Request, dependencies: Parameters<typeof handleBackgroundUpload>[2]) => handleBackgroundUpload(request, "1", dependencies),
    (request: Request, dependencies: Parameters<typeof handleBackgroundDelete>[2]) => handleBackgroundDelete(request, "1", dependencies),
    (request: Request, dependencies: Parameters<typeof handleProfilePreview>[1]) => handleProfilePreview(request, dependencies),
  ];
  for (const [index, caller] of callers.entries()) {
    const method = ["GET", "GET", "GET", "PUT", "DELETE", "POST"][index];
    let limited = false;
    const response = await caller(new Request("http://localhost:3000/api/test", { method, headers: { cookie: await sessionCookie(), origin: env.APP_URL } }), {
      ...deps, discordScope: {},
      limit: async (key) => { assert.equal(key, id); await delay(1); limited = true; return false; },
      fetch: mockFetch((url) => {
        assert.equal(limited, false);
        if (url.endsWith("users/@me")) return Response.json({ id, username: "test" });
        if (url.includes("users/@me/guilds")) return Response.json([{ id, name: "Test" }]);
        assert.fail("No backend or storage calls allowed");
      }),
    });
    assert.equal(limited, true);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "rate_limited" });
  }
});

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

test("logout is POST only and rejects unsafe origins without clearing cookies or fetching upstream", async () => {
  const cookie = `${await sessionCookie()}; ${await flowCookie()}`;
  let calls = 0;
  const dependencies = { ...deps, fetch: mockFetch(() => { calls++; return new Response(null, { status: 500 }); }) };
  const get = await handleAuth(req("logout", { headers: { cookie } }), "logout", dependencies);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("set-cookie"), null);
  for (const origin of [undefined, "", "null", "not-an-origin", "https://attacker.invalid", "http://localhost:3000.attacker.invalid", "http://localhost.attacker.invalid:3000", "http://localhost:3001"]) {
    const headers = new Headers({ cookie });
    if (origin !== undefined) headers.set("origin", origin);
    const response = await handleAuth(req("logout", { method: "POST", headers }), "logout", dependencies);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(calls, 0);
  }
  const crossSite = await handleAuth(req("logout", { method: "POST", headers: { cookie, origin: env.APP_URL, "Sec-Fetch-Site": "cross-site" } }), "logout", dependencies);
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers.get("set-cookie"), null);
  assert.equal(calls, 0);
});

test("logout accepts exact configured Origin without fetch metadata and clears cookies without fetching upstream", async () => {
  const cookie = `${await sessionCookie()}; ${await flowCookie()}`;
  let calls = 0;
  const response = await handleAuth(req("logout", { method: "POST", headers: { cookie, origin: env.APP_URL } }), "logout", { ...deps, fetch: mockFetch(() => { calls++; return new Response(null, { status: 500 }); }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /profile_session=;.*Max-Age=0/);
  assert.match(response.headers.get("set-cookie")!, /profile_oauth=;/);
  assert.equal(calls, 0);
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
  assert.notEqual(signals[0], signals[1]);
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
      deps.discordScope = {};
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

test("session and concurrent authorization share only pending reads and revalidate revoked permissions", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  let calls = 0;
  let permissions = "8";
  const fetch = mockFetch(async (url) => {
    calls++;
    await delay(30);
    return Response.json(url.includes("guilds?") ? [{ id, name: "Guild", permissions }] : { id, username: "tester" });
  });
  const dependencies = { ...deps, fetch };
  const results = await Promise.all([
    handleAuth(request, "session", dependencies),
    authenticatedMember(request, authConfig(env)!, dependencies),
    authenticatedMember(request, authConfig(env)!, dependencies),
  ]);
  assert.equal(calls, 2);
  assert.equal((results[0] as Response).status, 200);
  assert.equal((results[1] as Awaited<ReturnType<typeof authenticatedMember>>).guilds[0].canModerate, true);
  permissions = "0";
  assert.equal((await authenticatedMember(request, authConfig(env)!, dependencies)).guilds[0].canModerate, undefined);
  assert.equal(calls, 4);
});

test("pending reads share equivalent environments and fetch wrappers", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  let calls = 0;
  const handler = async (url: string) => {
    calls++;
    await delay(20);
    return Response.json(url.includes("guilds?") ? [{ id, name: "Guild" }] : { id, username: "tester" });
  };
  const fetch = mockFetch(handler);
  await Promise.all([
    authenticatedMember(request, authConfig(env)!, { ...deps, fetch }),
    authenticatedMember(request, authConfig(env)!, { ...deps, env: { ...env }, fetch }),
    authenticatedMember(request, authConfig(env)!, { ...deps, fetch: mockFetch(handler) }),
  ]);
  assert.equal(calls, 2);
});

test("coalesced failures settle, bound Retry-After, preserve sessions and never replay", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  let calls = 0;
  let status = 429;
  const fetch = mockFetch(async (url) => {
    calls++;
    await delay(20);
    return status === 200 ? Response.json(url.includes("guilds?") ? [] : { id, username: "tester" }) : new Response("private-body", { status, headers: { "Retry-After": "999999" } });
  });
  let time = now;
  const dependencies = { ...deps, fetch, now: () => time };
  const [session, member] = await Promise.all([
    handleAuth(request, "session", dependencies),
    authenticatedMember(request, authConfig(env)!, dependencies).catch((error: unknown) => error),
  ]);
  assert.equal(calls, 1);
  assert.ok(member instanceof ApiError);
  assert.equal(member.reason, "rate_limited");
  assert.equal(member.retryAfter, 86400);
  assert.equal(session.headers.get("Retry-After"), "86400");
  assert.equal(session.headers.get("set-cookie"), null);
  assert.doesNotMatch(await session.text(), /private-body|mock-access-token/);
  status = 200;
  time += 301000;
  await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 86099);
  assert.equal(calls, 1);
  time = now + 86400000;
  const refreshed = req("session", { headers: { cookie: await sessionCookie(time + 600000) } });
  await authenticatedMember(refreshed, authConfig(env)!, dependencies);
  assert.equal(calls, 3);
  status = 401;
  const revoked = await handleAuth(refreshed, "session", dependencies);
  assert.equal(revoked.status, 401);
  assert.match(revoked.headers.get("set-cookie")!, /Max-Age=0/);
});

test("one aborted waiter does not cancel another authorization", async () => {
  const cookie = await sessionCookie();
  const controller = new AbortController();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const fetch = mockFetch(async (url, init) => {
    calls++;
    signals.push(init!.signal!);
    await delay(40);
    assert.equal(init?.signal?.aborted, false);
    return Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
  });
  const dependencies = { ...deps, fetch };
  const cancelled = authenticatedMember(req("session", { headers: { cookie }, signal: controller.signal }), authConfig(env)!, dependencies);
  const continuing = authenticatedMember(req("session", { headers: { cookie } }), authConfig(env)!, dependencies);
  await delay(10);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof ApiError && error.reason === "aborted");
  assert.equal((await continuing).user.id, id);
  assert.equal(calls, 2);
  assert.ok(signals.every(signal => !signal.aborted));
});

test("last cancelled waiter aborts orphaned identity and guild reads and allows immediate replacement", async () => {
  const cookie = await sessionCookie();
  for (const stage of ["identity", "guilds"]) {
    const controller = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    let upstream: AbortSignal | null | undefined;
    let release!: (response: Response) => void;
    let calls = 0;
    const dependencies = { ...deps, discordScope: {}, fetch: mockFetch((url, init) => {
      calls++;
      if (stage === "identity" || url.includes("guilds?")) {
        upstream = init?.signal;
        reached();
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json({ id, username: "tester" });
    }) };
    const cancelled = authenticatedMember(req("session", { headers: { cookie }, signal: controller.signal }), authConfig(env)!, dependencies);
    await started;
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => error instanceof ApiError && error.reason === "aborted");
    assert.equal(upstream?.aborted, true);
    const replacement = { ...dependencies, fetch: mockFetch(url => {
      calls++;
      return Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
    }) };
    assert.equal((await authenticatedMember(req("session", { headers: { cookie } }), authConfig(env)!, replacement)).user.id, id);
    release(Response.json(stage === "identity" ? { id, username: "tester" } : []));
    assert.equal(calls, stage === "identity" ? 3 : 4);
  }
});

test("Discord deadline cleans pending requests even when transport ignores abort", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  let stalled = true;
  let calls = 0;
  const fetch = mockFetch((url) => {
    calls++;
    return stalled ? new Promise<Response>(() => {}) : Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
  });
  const dependencies = { ...deps, fetch };
  await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.reason === "timeout");
  stalled = false;
  await authenticatedMember(request, authConfig(env)!, dependencies);
  assert.equal(calls, 3);
});

test("in-flight capacity rejects excess work without evicting or poisoning pending requests", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  const releases: (() => void)[] = [];
  const fetch = mockFetch(async (url) => {
    await new Promise<void>(resolve => releases.push(resolve));
    return Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
  });
  const environments = Array.from({ length: 256 }, (_, index) => ({ ...env, DISCORD_CLIENT_ID: String(123456789012345678n + BigInt(index)) }));
  const pending = environments.map(environment => authenticatedMember(request, authConfig(environment)!, { ...deps, env: environment, fetch }));
  while (releases.length < 256) await delay(5);
  await assert.rejects(authenticatedMember(request, { ...authConfig(env)!, clientId: "923456789012345678" }, { ...deps, fetch }), (error: unknown) => error instanceof ApiError && error.reason === "capacity");
  releases.splice(0).forEach(release => release());
  while (releases.length < 256) await delay(5);
  releases.splice(0).forEach(release => release());
  assert.equal((await Promise.all(pending)).length, 256);
});

test("Discord cooldown shares token endpoints, isolates tokens and expires without cached results", async () => {
  let time = now;
  let limited = true;
  let calls = 0;
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  const other = req("session", { headers: { cookie: `profile_session=${await sealData({ accessToken: "other-token", expiresAt: now + 600000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}` } });
  const fetch = mockFetch((url, init) => {
    calls++;
    if (limited && url.includes("guilds?") && new Headers(init?.headers).get("authorization") === "Bearer mock-access-token") return Response.json({ retry_after: 600.25 }, { status: 429, headers: { "Retry-After": "400" } });
    return Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
  });
  const dependencies = { ...deps, fetch, now: () => time };
  await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 601);
  assert.equal(calls, 2);
  time += 300000;
  const blocked = await handleAuth(request, "session", dependencies);
  assert.equal(blocked.headers.get("Retry-After"), "301");
  assert.equal(calls, 2);
  await authenticatedMember(other, authConfig(env)!, dependencies);
  assert.equal(calls, 4);
  limited = false;
  time += 301000;
  const refreshed = req("session", { headers: { cookie: await sessionCookie(time + 600000) } });
  await authenticatedMember(refreshed, authConfig(env)!, dependencies);
  await authenticatedMember(refreshed, authConfig(env)!, dependencies);
  assert.equal(calls, 8);
});

test("explicit Discord global cooldown shares wrappers and environments but isolates config and explicit scope", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  const other = req("session", { headers: { cookie: `profile_session=${await sealData({ accessToken: "other-token", expiresAt: now + 600000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}` } });
  let calls = 0;
  const fetch = mockFetch(() => { calls++; return Response.json({ global: true, retry_after: 20 }, { status: 429 }); });
  const dependencies = { ...deps, fetch };
  await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies));
  await assert.rejects(authenticatedMember(other, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 20);
  assert.equal(calls, 1);
  await assert.rejects(authenticatedMember(request, authConfig(env)!, { ...dependencies, env: { ...env } }));
  await assert.rejects(authenticatedMember(request, { ...authConfig(env)!, clientId: "223456789012345678" }, dependencies));
  assert.equal(calls, 2);
  let isolatedCalls = 0;
  const wrapper = mockFetch(() => { isolatedCalls++; return new Response(null, { status: 500 }); });
  await assert.rejects(authenticatedMember(request, authConfig(env)!, { ...dependencies, fetch: wrapper }));
  assert.equal(isolatedCalls, 0);
  await assert.rejects(authenticatedMember(request, authConfig(env)!, { ...dependencies, discordScope: {}, fetch: wrapper }));
  assert.equal(isolatedCalls, 1);
});

test("invalid Discord hints use conservative fallback and bounded bodies never leak", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  for (const body of [{ retry_after: -1 }, { retry_after: "Infinity" }, { retry_after: null }, { retry_after: true }, { retry_after: 0 }, { retry_after: "1e300" }, { padding: "private".repeat(200) }]) {
    deps.discordScope = {};
    let time = now;
    let calls = 0;
    const fetch = mockFetch(() => { calls++; return Response.json(body, { status: 429, headers: { "Retry-After": "NaN" } }); });
    const dependencies = { ...deps, fetch, now: () => time };
    await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 5 && !error.message.includes("private"));
    time += 1000;
    await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 4);
    assert.equal(calls, 1);
    time += 4000;
    await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies));
    assert.equal(calls, 2);
  }
});

test("non-429 failures clean shared work without starting cooldown", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  for (const status of [500, 503]) {
    let calls = 0;
    let failed = true;
    const fetch = mockFetch(async (url) => {
      calls++;
      await delay(20);
      return failed ? new Response(null, { status, headers: { "Retry-After": "600" } }) : Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
    });
    const dependencies = { ...deps, fetch };
    const results = await Promise.allSettled([authenticatedMember(request, authConfig(env)!, dependencies), authenticatedMember(request, authConfig(env)!, dependencies)]);
    assert.ok(results.every(result => result.status === "rejected"));
    assert.equal(calls, 1);
    failed = false;
    await authenticatedMember(request, authConfig(env)!, dependencies);
    assert.equal(calls, 3);
  }
});

test("actual session preferences library and moderation callers share two fresh Discord GETs", async () => {
  const cookie = await sessionCookie();
  const request = new Request(`http://localhost:3000/api/preferences?guildId=${id}`, { headers: { cookie } });
  let calls = 0;
  const fetch = mockFetch(async (url) => {
    calls++;
    await delay(20);
    return Response.json(url.includes("guilds?") ? [{ id, name: "Guild", permissions: "8" }] : { id, username: "tester" });
  });
  const dependencies = { ...deps, fetch };
  const responses = await Promise.all([
    handleAuth(request, "session", dependencies),
    handlePreferences(request, { ...dependencies, env: { ...env }, fetch: mockFetch((url, init) => fetch(url, init)), store: { async get() { return null; }, async set() {}, async reset() {} } }),
    handleBackgroundLibrary(request, { ...dependencies, getLevel: async () => ({ userId: id, guildId: id, level: 65 }), listBackgrounds: async () => [] }),
    handleModeration(request, undefined, { ...dependencies, store: { async list() { return []; }, async get() { return null; }, async disable() { return false; } } }),
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
  assert.equal(calls, 2);
});

test("late overlapping caller shares the whole pending context after identity completed", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  let release!: () => void;
  let guildStarted!: () => void;
  const started = new Promise<void>(resolve => { guildStarted = resolve; });
  let calls = 0;
  const fetch = mockFetch(async (url) => {
    calls++;
    if (url.includes("guilds?")) {
      guildStarted();
      await new Promise<void>(resolve => { release = resolve; });
      return Response.json([{ id, name: "Guild", permissions: "8" }]);
    }
    return Response.json({ id, username: "tester" });
  });
  const first = authenticatedMember(request, authConfig(env)!, { ...deps, fetch });
  await started;
  const second = handleAuth(request, "session", { ...deps, env: { ...env }, fetch: mockFetch(() => { throw new Error("duplicate transport"); }) });
  await delay(20);
  release();
  assert.equal((await first).guilds[0].canModerate, true);
  assert.equal((await second).status, 200);
  assert.equal(calls, 2);
});

test("successful exhausted headers proactively pace fresh reads and excessive waits fail closed", async () => {
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  const guildTimes: number[] = [];
  let reset = "0.25";
  let permissions = "8";
  const fetch = mockFetch((url) => {
    if (!url.includes("guilds?")) return Response.json({ id, username: "tester" });
    guildTimes.push(performance.now());
    return Response.json([{ id, name: "Guild", permissions }], { headers: { "X-RateLimit-Bucket": "mock-guild-bucket", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": reset } });
  });
  const dependencies = { ...deps, now: Date.now, fetch };
  const cookie = `profile_session=${await sealData({ accessToken: "paced-token", expiresAt: Date.now() + 600000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  const fresh = new Request(request, { headers: { cookie } });
  await authenticatedMember(fresh, authConfig(env)!, dependencies);
  permissions = "0";
  reset = "20";
  assert.equal((await authenticatedMember(fresh, authConfig(env)!, dependencies)).guilds[0].canModerate, undefined);
  assert.ok(guildTimes[1] - guildTimes[0] >= 340);
  const started = performance.now();
  await assert.rejects(authenticatedMember(fresh, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.reason === "rate_limited" && error.retryAfter! >= 19);
  assert.ok(performance.now() - started < 1000);
  assert.equal(guildTimes.length, 2);
});

test("short 429 body hint is honored without replay or an accidental five-second cooldown", async () => {
  let time = now;
  let calls = 0;
  const request = req("session", { headers: { cookie: await sessionCookie() } });
  const dependencies = { ...deps, now: () => time, fetch: mockFetch((url) => {
    calls++;
    if (calls === 1) return Response.json({ retry_after: 1 }, { status: 429 });
    return Response.json(url.includes("guilds?") ? [] : { id, username: "tester" });
  }) };
  await assert.rejects(authenticatedMember(request, authConfig(env)!, dependencies), (error: unknown) => error instanceof ApiError && error.retryAfter === 1);
  assert.equal(calls, 1);
  time += 1000;
  await authenticatedMember(request, authConfig(env)!, dependencies);
  assert.equal(calls, 3);
});

test("rate limits avoid upstream calls and production cookies are Secure", async () => {
  const limited = await handleAuth(req("discord"), "discord", { ...deps, limit: () => false });
  assert.equal(limited.status, 429);
  const response = await handleAuth(req("discord"), "discord", { ...deps, env: { ...env, NODE_ENV: "production", APP_URL: "https://example.com" } });
  assert.match(response.headers.get("set-cookie")!, /Secure/);
});
