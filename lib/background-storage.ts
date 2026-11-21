import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ApiError, type Environment } from "./api-security.ts";
import { MAX_OUTPUT_BYTES } from "./image-processing.ts";
import { supabaseConfig } from "./supabase.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export const BACKGROUND_BUCKET = "profile-backgrounds";
const objectKeyPattern = /^profile-images\/[a-f0-9]{32}\.png$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type StorageClient = {
  storage: {
    from(bucket: string): {
      upload(path: string, body: Buffer, options: { contentType: string; cacheControl: string; upsert: boolean }): PromiseLike<{ error: unknown }>;
    };
  };
};
export type BackgroundStorageOptions = {
  env: Environment;
  fetcher?: typeof fetch;
  clientFactory?: (url: string, key: string, options: NonNullable<Parameters<typeof createClient>[2]>) => StorageClient;
  timeoutMs?: number;
};

function unavailable() { return new ApiError(503, "storage_unavailable"); }
function validKey(key: string) { return typeof key === "string" && objectKeyPattern.test(key); }
function validPng(input: Buffer) {
  return Buffer.isBuffer(input) && input.length >= pngSignature.length && input.length <= MAX_OUTPUT_BYTES && input.subarray(0, 8).equals(pngSignature);
}

export function backgroundStorage({ env, fetcher = fetch, clientFactory = createClient, timeoutMs = 5000 }: BackgroundStorageOptions) {
  const config = supabaseConfig(env);
  if (!config || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw unavailable();
  const { url, serviceRoleKey } = config;
  const headers = { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey };
  const endpoint = `${url}/storage/v1/object/${encodeURIComponent(BACKGROUND_BUCKET)}`;

  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs);
    });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }

  return {
    async upload(png: Buffer, objectKey?: string): Promise<{ object_key: string }> {
      try {
        if (!validPng(png)) throw unavailable();
        const body = Buffer.from(png);
        const object_key = objectKey ?? `profile-images/${randomBytes(16).toString("hex")}.png`;
        if (!validKey(object_key)) throw unavailable();
        await bounded(async (signal) => {
          const client = clientFactory(url, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: { fetch: (input, init) => fetcher(input, { ...init, signal, redirect: "error", cache: "no-store" }) },
          });
          const { error } = await client.storage.from(BACKGROUND_BUCKET).upload(object_key, body, { contentType: "image/png", cacheControl: "0", upsert: false });
          if (error) throw unavailable();
        });
        return { object_key };
      } catch { throw unavailable(); }
    },
    async download(objectKey: string): Promise<Buffer> {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (!validKey(objectKey)) throw unavailable();
        return await bounded(async (signal) => {
          const response = await fetcher(`${endpoint}/${objectKey.split("/").map(encodeURIComponent).join("/")}`, { headers, signal, redirect: "error", cache: "no-store" });
          if (signal.aborted) { void response.body?.cancel().catch(() => {}); throw unavailable(); }
          reader = response.body?.getReader();
          const length = response.headers.get("content-length");
          if (!response.ok || response.redirected || !reader || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png" || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_OUTPUT_BYTES))) throw unavailable();
          const chunks: Buffer[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw unavailable();
            size += value.byteLength;
            if (size > MAX_OUTPUT_BYTES) throw unavailable();
            chunks.push(Buffer.from(value));
          }
          const png = Buffer.concat(chunks, size);
          if (!validPng(png)) throw unavailable();
          return png;
        });
      } catch { throw unavailable(); }
      finally {
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    },
    async delete(objectKey: string): Promise<void> {
      try {
        if (!validKey(objectKey)) throw unavailable();
        await bounded(async (signal) => {
          const response = await fetcher(endpoint, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [objectKey] }), signal, redirect: "error", cache: "no-store" });
          void response.body?.cancel().catch(() => {});
          if (response.redirected || (!response.ok && response.status !== 404)) throw unavailable();
        });
      } catch { throw unavailable(); }
    },
  };
}
export type BackgroundStorage = ReturnType<typeof backgroundStorage>;
