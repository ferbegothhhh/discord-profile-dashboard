import assert from "node:assert/strict";
import test from "node:test";
import { sealData } from "iron-session";
import { handleProfileBio, handleBotProfileBio } from "../lib/profile-bio.ts";
import { validBio } from "../lib/profile-bio-store.ts";
import { handleProfileAchievements } from "../lib/profile-achievements.ts";
import { getAchievements, selectTitle } from "../lib/profile-achievements-bot.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const other = "323456789012345678";
const key = "test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_random";
const levelKey = "abcdefghijklmnopqrstuvwxyz012345";
const env = { DISCORD_CLIENT_ID: user, DISCORD_CLIENT_SECRET: "mock", SESSION_PASSWORD: "test-only-session-password-1234567890", APP_URL: "https://dashboard.example", PROFILE_BOT_API_KEY: key, PROFILE_BOT_GUILD_IDS: guild, PROFILE_LEVEL_API_URL: "https://bot.example", PROFILE_LEVEL_API_KEY: levelKey };
let bio: string | null = null;
const store = { async get(id: string) { assert.equal(id, user); return bio; }, async set(id: string, value: string) { assert.equal(id, user); bio = value; }, async delete(id: string) { assert.equal(id, user); bio = null; } };
const discord = (async (url) => Response.json(String(url).includes("guilds") ? [{ id: guild, name: "Test" }] : { id: user, username: "tester" })) as typeof fetch;
const deps = { env, store, fetch: discord, limit: () => true, discordScope: {} };
test.beforeEach(() => { deps.discordScope = {}; bio = null; });
async function browser(path: string, method = "GET", body?: unknown) {
  const cookie = `profile_session=${await sealData({ accessToken: "mock", expiresAt: Date.now() + 60000 }, { password: env.SESSION_PASSWORD, ttl: 28800 })}`;
  return new Request(`https://dashboard.example${path}`, { method, headers: { cookie, origin: env.APP_URL, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const ready = { status: "ready", userId: user, guildId: guild, achievements: [{ id: "first_contact", name: "First Contact", unlocked: true }], selectedTitleId: null };

test("bio is global, Unicode scalar bounded, and delete is idempotent", async () => {
  assert.equal(validBio("😀".repeat(120)), true);
  for (const invalid of ["😀".repeat(121), "\n", "\u202e", "\ud800", "e\u0301"]) assert.equal(validBio(invalid), false);
  assert.deepEqual(await (await handleProfileBio(await browser("/api/profile-bio", "POST", { bio: "😀".repeat(120) }), deps)).json(), { status: "saved", bio: "😀".repeat(120) });
  assert.equal((await (await handleProfileBio(await browser("/api/profile-bio"), deps)).json()).bio, bio);
  assert.equal((await handleProfileBio(await browser("/api/profile-bio", "DELETE"), deps)).status, 200);
  assert.equal(bio, null);
});

test("bio rejects spoofing, CSRF, invalid bodies and bot credentials", async () => {
  assert.equal((await handleProfileBio(await browser("/api/profile-bio", "POST", { bio: "yes", userId: other }), deps)).status, 400);
  const csrf = await browser("/api/profile-bio", "DELETE"); csrf.headers.set("origin", "https://evil.example");
  assert.equal((await handleProfileBio(csrf, deps)).status, 403);
  assert.equal((await handleProfileBio(await browser("/api/profile-bio", "POST", { bio: "\u0000" }), deps)).status, 400);
  assert.equal((await handleProfileBio(await browser("/api/profile-bio?userId=" + other), deps)).status, 400);
  const bot = (query: string, authorization?: string) => new Request(`https://dashboard.example/api/bot/profile-bio?${query}`, { headers: authorization ? { authorization } : {} });
  assert.equal((await handleBotProfileBio(bot(`userId=${user}`), deps)).status, 401);
  assert.equal((await handleBotProfileBio(bot(`userId=${user}&userId=${other}`, `Bearer ${key}`), deps)).status, 400);
  assert.deepEqual(await (await handleBotProfileBio(bot(`userId=${user}`, `Bearer ${key}`), deps)).json(), { status: "ready", userId: user, bio: null });
});

test("achievements bridge binds guild and user to session and rejects spoofing", async () => {
  const get = async (u: string, g: string) => { assert.equal(u, user); assert.equal(g, guild); return ready as typeof ready & { status: "ready" }; };
  const select = async (u: string, g: string, id: string) => { assert.equal(u, user); assert.equal(g, guild); assert.equal(id, "first_contact"); return { status: "saved" as const, userId: u, guildId: g, achievementId: id }; };
  const options = { ...deps, get, select };
  assert.equal((await handleProfileAchievements(await browser(`/api/profile-achievements?guildId=${guild}`), options)).status, 200);
  assert.equal((await handleProfileAchievements(await browser(`/api/profile-achievements?guildId=${other}`), options)).status, 403);
  assert.equal((await handleProfileAchievements(await browser(`/api/profile-achievements?guildId=${guild}&userId=${other}`), options)).status, 400);
  assert.equal((await handleProfileAchievements(await browser("/api/profile-achievements", "POST", { guildId: guild, achievementId: "first_contact", userId: other }), options)).status, 400);
  assert.equal((await handleProfileAchievements(await browser("/api/profile-achievements", "POST", { guildId: guild, achievementId: "first_contact" }), options)).status, 200);
  const csrf = await browser("/api/profile-achievements", "POST", { guildId: guild, achievementId: "first_contact" }); csrf.headers.set("origin", "https://evil.example");
  assert.equal((await handleProfileAchievements(csrf, options)).status, 403);
});

test("bot bridge sends server-only bearer, rejects mismatched and oversized responses", async () => {
  const achievement = { id: "first_contact", name: "First Contact", metric: "messages", threshold: 1, title: "Pendatang Orbit", unlocked: true };
  const progress = { messages: 0, voiceSeconds: 0, dailyStreak: 0, earnedCoins: 0, levelsGained: 0 };
  const botGet = { status: "ready", snapshot: { userId: user, guildId: guild, seasonNumber: 2, progress, selectedTitle: null, selectedTitleId: null, achievements: [achievement] } };
  const botTitle = { status: "ready", snapshot: { userId: user, guildId: guild, seasonNumber: 2, progress, selectedTitle: "Pendatang Orbit", selectedTitleId: "first_contact", achievements: [achievement] } };
  const fetcher = (async (input, init) => {
    assert.equal(init?.headers && new Headers(init.headers).get("Authorization"), `Bearer ${levelKey}`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    if (init?.method === "POST") {
      assert.equal(new URL(String(input)).pathname, "/api/profile-achievements/title");
      assert.deepEqual(JSON.parse(String(init.body)), { userId: user, guildId: guild, achievementId: "first_contact" });
      return Response.json(botTitle);
    }
    assert.equal(new URL(String(input)).searchParams.get("userId"), user);
    return Response.json(botGet);
  }) as typeof fetch;
  assert.deepEqual(await getAchievements(user, guild, env, fetcher), ready);
  assert.deepEqual(await selectTitle(user, guild, "first_contact", env, fetcher), { status: "saved", userId: user, guildId: guild, achievementId: "first_contact" });
  await assert.rejects(getAchievements(user, guild, env, (async () => Response.json({ ...botGet, snapshot: { ...botGet.snapshot, userId: other } })) as typeof fetch), { code: "achievements_unavailable" });
  await assert.rejects(getAchievements(user, guild, env, (async () => new Response("x".repeat(32769), { headers: { "Content-Type": "application/json" } })) as typeof fetch), { code: "achievements_unavailable" });
  await assert.rejects(selectTitle(user, guild, "../../x", env, fetcher), { code: "invalid_achievement" });
});

test("achievements deadline aborts an unresponsive bot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | null | undefined;
  const pending = getAchievements(user, guild, env, (async (_input, init) => { signal = init?.signal; return new Promise<Response>(() => {}); }) as typeof fetch);
  const rejected = assert.rejects(pending, { code: "achievements_unavailable" });
  t.mock.timers.tick(1999);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal?.aborted, true);
});
