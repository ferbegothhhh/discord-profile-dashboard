import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../lib/api-security.ts";
import { BACKGROUND_BUCKET, backgroundStorage, type BackgroundStorageOptions } from "../lib/background-storage.ts";
import { MAX_OUTPUT_BYTES } from "../lib/image-processing.ts";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-service-secret-not-a-real-key" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const key = `profile-images/${"a".repeat(32)}.png`;
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === "storage_unavailable" && error.message === "storage_unavailable" && error.cause === undefined;
const noFetch: typeof fetch = async () => { assert.fail("Unexpected network request"); };
const fakeClient: NonNullable<BackgroundStorageOptions["clientFactory"]> = () => ({ storage: { from: () => ({ upload: async () => ({ error: null }) }) } });

function storage(fetcher: typeof fetch = noFetch, options: Partial<BackgroundStorageOptions> = {}) {
  return backgroundStorage({ env, fetcher, clientFactory: fakeClient, ...options });
}

function response(body: BodyInit = png, headers: HeadersInit = { "Content-Type": "image/png" }) {
  return new Response(body, { headers });
}

test("configuration is explicit, validated and never creates buckets or clients eagerly", () => {
  for (const invalid of [{}, { ...env, SUPABASE_URL: "http://example.supabase.co" }, { ...env, SUPABASE_URL: `${env.SUPABASE_URL}/path` }, { ...env, SUPABASE_SERVICE_ROLE_KEY: "short" }]) {
    assert.throws(() => storage(noFetch, { env: invalid }), unavailable);
  }
  for (const timeoutMs of [0, -1, 5001, NaN, 1.5]) assert.throws(() => storage(noFetch, { timeoutMs }), unavailable);
  storage(noFetch, { clientFactory: () => { assert.fail("Eager client creation"); } });
  assert.equal(BACKGROUND_BUCKET, "profile-backgrounds");
});

test("uploads only a generated key and PNG with private client transport settings", async () => {
  const uploaded: string[] = [];
  let calls = 0;
  const adapter = storage(async (input, init) => {
    calls++;
    assert.equal(input, `${env.SUPABASE_URL}/storage/v1/object/${BACKGROUND_BUCKET}/${uploaded.at(-1)}`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(new Headers(init?.headers).get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
    return Response.json({ Key: "attacker/path.png" });
  }, {
    clientFactory: (url, secret, options) => {
      assert.equal(url, env.SUPABASE_URL);
      assert.equal(secret, env.SUPABASE_SERVICE_ROLE_KEY);
      assert.deepEqual(options.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
      return { storage: { from: (bucket) => {
        assert.equal(bucket, BACKGROUND_BUCKET);
        return { upload: async (path, body, uploadOptions) => {
          assert.match(path, /^profile-images\/[a-f0-9]{32}\.png$/);
          uploaded.push(path);
          assert.deepEqual(body, png);
          assert.notEqual(body, png);
          assert.deepEqual(uploadOptions, { contentType: "image/png", cacheControl: "0", upsert: false });
          await options.global!.fetch!(`${url}/storage/v1/object/${bucket}/${path}`, { headers: { Authorization: `Bearer ${secret}`, apikey: secret } });
          return { error: null, data: { path: "attacker/path.png" } };
        } };
      } } };
    },
  });
  assert.deepEqual(await adapter.upload(png), { object_key: uploaded[0] });
  assert.deepEqual(await adapter.upload(png), { object_key: uploaded[1] });
  assert.notEqual(uploaded[0], uploaded[1]);
  assert.equal(calls, 2);
});

test("real Supabase client uses the injected fetch without hosted calls", async () => {
  let calls = 0;
  const adapter = backgroundStorage({ env, fetcher: async (input, init) => {
    calls++;
    assert.match(String(input), /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/profile-backgrounds\/profile-images\/[a-f0-9]{32}\.png$/);
    assert.equal(init?.method, "POST");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(headers.get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(headers.get("x-upsert"), "false");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json({ Key: "ignored" });
  } });
  assert.match((await adapter.upload(png)).object_key, /^profile-images\/[a-f0-9]{32}\.png$/);
  assert.equal(calls, 1);
});

test("upload rejects invalid signatures and oversized buffers before creating a client", async () => {
  const adapter = storage(noFetch, { clientFactory: () => { assert.fail("Invalid PNG reached storage"); } });
  for (const input of [Buffer.alloc(0), Buffer.from("not png"), png.subarray(0, 7), Buffer.alloc(MAX_OUTPUT_BYTES + 1), "not a buffer" as unknown as Buffer]) {
    await assert.rejects(adapter.upload(input), unavailable);
  }
  const maximum = Buffer.alloc(MAX_OUTPUT_BYTES);
  png.copy(maximum);
  assert.match((await storage().upload(maximum)).object_key, /^profile-images\/[a-f0-9]{32}\.png$/);
});

test("download and delete refuse arbitrary URLs, traversal, prefixes and malformed keys", async () => {
  const adapter = storage();
  for (const invalid of ["https://evil.example/image.png", "../secret", "profile-images/", `${key}/extra`, `${key}?x=1`, `${key}\n`, key.toUpperCase(), key.replace("/", "%2f"), key.replace("a", "g"), "", null as unknown as string]) {
    await assert.rejects(adapter.download(invalid), unavailable);
    await assert.rejects(adapter.delete(invalid), unavailable);
  }
});

test("downloads via fixed private REST origin and streams PNG bytes", async () => {
  const adapter = storage(async (input, init) => {
    assert.equal(input, `${env.SUPABASE_URL}/storage/v1/object/${BACKGROUND_BUCKET}/${key}`);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY });
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(png.subarray(0, 3)); controller.enqueue(png.subarray(3)); controller.close(); } }), { headers: { "Content-Type": "image/png", "Content-Length": String(png.length) } });
  });
  assert.deepEqual(await adapter.download(key), png);
});

test("rejects MIME, invalid PNG, declared size, status and redirects; cancels bodies", async () => {
  const invalidHeaders: HeadersInit[] = [{ "Content-Type": "text/html" }, {}, { "Content-Type": "image/png", "Content-Length": String(MAX_OUTPUT_BYTES + 1) }, { "Content-Type": "image/png", "Content-Length": "invalid" }];
  for (const headers of invalidHeaders) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(storage(async () => new Response(stream, { headers })).download(key), unavailable);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
  for (const result of [response("not a png"), new Response(null), new Response("secret", { status: 403 }), new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })]) {
    await assert.rejects(storage(async () => result).download(key), unavailable);
  }
  const redirected = response();
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(storage(async () => redirected).download(key), unavailable);
});

test("stream cap applies without content-length and cancels before reading the rest", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); controller.enqueue(new Uint8Array(MAX_OUTPUT_BYTES)); }, cancel() { cancelled = true; } });
  await assert.rejects(storage(async () => new Response(stream, { headers: { "Content-Type": "image/png" } })).download(key), unavailable);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  const maximum = Buffer.alloc(MAX_OUTPUT_BYTES);
  png.copy(maximum);
  assert.deepEqual(await storage(async () => response(maximum)).download(key), maximum);
});

test("delete sends only validated prefixes and treats missing storage objects as success", async () => {
  for (const status of [200, 204, 404]) {
    let cancelled = false;
    await storage(async (input, init) => {
      assert.equal(input, `${env.SUPABASE_URL}/storage/v1/object/${BACKGROUND_BUCKET}`);
      assert.equal(init?.method, "DELETE");
      assert.equal(init?.body, JSON.stringify({ prefixes: [key] }));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(init?.headers, { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" });
      return new Response(status === 204 ? null : new ReadableStream({ cancel() { cancelled = true; } }), { status });
    }).delete(key);
    assert.equal(cancelled, status !== 204);
  }
  await assert.rejects(storage(async () => new Response(null, { status: 500 })).delete(key), unavailable);
});

test("all upstream failures are sanitized without logging", async (context) => {
  const logs = [context.mock.method(console, "log"), context.mock.method(console, "warn"), context.mock.method(console, "error")];
  const secretError = new Error(`upstream ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  const adapter = storage(async () => { throw secretError; }, { clientFactory: () => { throw secretError; } });
  await assert.rejects(adapter.upload(png), unavailable);
  await assert.rejects(adapter.download(key), unavailable);
  await assert.rejects(adapter.delete(key), unavailable);
  await assert.rejects(storage(noFetch, { clientFactory: () => ({ storage: { from: () => ({ upload: async () => ({ error: secretError }) }) } }) }).upload(png), unavailable);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
});

test("timeouts abort fetch and cancel and unlock stalled download streams", async () => {
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const adapter = storage(async (_input, init) => { signal = init?.signal; return new Response(stream, { headers: { "Content-Type": "image/png" } }); }, { timeoutMs: 10 });
  await assert.rejects(adapter.download(key), unavailable);
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("timeouts bound uncooperative fetch and upload clients", async () => {
  const never: typeof fetch = () => new Promise(() => {});
  const adapter = storage(never, { timeoutMs: 10, clientFactory: () => ({ storage: { from: () => ({ upload: () => new Promise(() => {}) }) } }) });
  await assert.rejects(adapter.upload(png), unavailable);
  await assert.rejects(adapter.download(key), unavailable);
  await assert.rejects(adapter.delete(key), unavailable);
});

test("internal reserved upload keys are validated and used without overwrite", async () => {
  const adapter = storage(noFetch, { clientFactory: () => ({ storage: { from: () => ({ upload: async (path, _body, options) => {
    assert.equal(path, key);
    assert.equal(options.upsert, false);
    return { error: null };
  } }) } }) });
  assert.deepEqual(await adapter.upload(png, key), { object_key: key });
  for (const invalid of ["", "../secret", `${key}?x=1`, key.toUpperCase(), "profile-images/short.png"]) {
    await assert.rejects(adapter.upload(png, invalid), unavailable);
  }
});

test("successful operations clear deadline timers", async () => {
  let signal: AbortSignal | null | undefined;
  await storage(async (_input, init) => { signal = init?.signal; return response(); }, { timeoutMs: 10 }).download(key);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(signal?.aborted, false);
});

test("supports injected configuration and ignores environment", async () => {
  const injected = { url: "https://injected.example.test", serviceRoleKey: "injected-service-role-key" };
  let calledUrl = "";
  const adapter = backgroundStorage({
    config: injected,
    env: { SUPABASE_URL: "https://wrong.example.test", SUPABASE_SERVICE_ROLE_KEY: "wrong-key" },
    fetcher: async (input) => {
      calledUrl = String(input);
      return response();
    }
  });
  await adapter.download(key);
  assert.ok(calledUrl.startsWith(injected.url));
  assert.ok(!calledUrl.startsWith("https://wrong.example.test"));
});
