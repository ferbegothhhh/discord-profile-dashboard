import { createDatabaseClient } from "./supabase.ts";
import { ApiError, type Environment } from "./api-security.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

export function validBio(value: unknown): value is string {
  if (typeof value !== "string" || [...value].length > 120 || value.length > 240) return false;
  return !/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(value) && value === value.normalize("NFC");
}

export type BioStore = {
  get(userId: string): Promise<string | null>;
  set(userId: string, bio: string): Promise<void>;
  delete(userId: string): Promise<void>;
};

export function bioStore(env: Environment = process.env, fetcher: typeof fetch = fetch): BioStore {
  const client = createDatabaseClient(env, fetcher);
  return {
    async get(userId) {
      const { data, error } = await client.from("profile_bios").select("bio").eq("user_id", userId).maybeSingle();
      if (error || (data && !validBio(data.bio))) throw new ApiError(503, "database_unavailable");
      return data?.bio ?? null;
    },
    async set(userId, bio) {
      const { error } = await client.from("profile_bios").upsert({ user_id: userId, bio, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw new ApiError(503, "database_unavailable");
    },
    async delete(userId) {
      const { error } = await client.from("profile_bios").delete().eq("user_id", userId);
      if (error) throw new ApiError(503, "database_unavailable");
    },
  };
}
