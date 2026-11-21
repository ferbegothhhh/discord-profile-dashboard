import assert from "node:assert/strict";
import test from "node:test";
import { supabaseConfig, preferenceStore, validatePreferenceImage } from "../lib/supabase.ts";

const user = "123456789012345678";
const guild = "223456789012345678";
const id = "12345678-1234-4234-8234-123456789abc";
const row = { id, kind: "image", visibility: "private", owner_user_id: user, owner_guild_id: guild, slot_number: 1, revision: 1, status: "ready", is_active: true, mime: "image/png", width: 1000, height: 560, byte_size: 8, object_key: `profile-images/${"a".repeat(32)}.png` };

test("image metadata fails closed on ownership, activation and malformed media", () => {
  assert.ok(validatePreferenceImage(row, user, guild, id));
  for (const change of [{ owner_user_id: guild }, { owner_guild_id: user }, { visibility: "catalog" }, { status: "processing" }, { is_active: false }, { slot_number: 0 }, { slot_number: 4 }, { revision: 0 }, { byte_size: 0 }, { width: 999 }, { object_key: "https://external.example/a.png" }]) assert.equal(validatePreferenceImage({ ...row, ...change }, user, guild, id), null);
});

test("image preference database reads and writes filter private owner and validate rows", async () => {
  for (const valid of [true, false]) {
    let writes = 0;
    const store = preferenceStore({ SUPABASE_URL: "https://database.example", SUPABASE_SERVICE_ROLE_KEY: "test-service-key-not-real-12345" }, (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") { writes++; return new Response(null, { status: 204 }); }
      if (url.pathname.includes("profile_preferences")) return Response.json({ background_id: id });
      for (const [key, value] of Object.entries({ id, owner_user_id: user, owner_guild_id: guild, kind: "image", visibility: "private", status: "ready", is_active: "true" })) assert.equal(url.searchParams.get(key), `eq.${value}`);
      return Response.json(valid ? row : { ...row, owner_user_id: guild });
    }) as typeof fetch);
    assert.equal(await store.get(user, guild), valid ? id : null);
    if (valid) await store.set(user, guild, id);
    else await assert.rejects(store.set(user, guild, id));
    assert.equal(writes, valid ? 1 : 0);
  }
});

test("supabase config requires https url and a key", () => {
  assert.equal(supabaseConfig({}), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "https://example.supabase.co" }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "http://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }), null);
  assert.equal(supabaseConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "short" }), null);
  assert.deepEqual(
    supabaseConfig({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x".repeat(32) }),
    { url: "https://example.supabase.co", serviceRoleKey: "x".repeat(32) },
  );
});
