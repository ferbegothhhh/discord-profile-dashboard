import nextEnv from "@next/env";
import { cleanupBackgrounds } from "../lib/background-cleanup.ts";

if (typeof window !== "undefined") throw new Error("Server-only module");

try {
  if (process.argv.length !== 2) throw new Error();
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", { info() {}, error() {} });
  const counts = await cleanupBackgrounds();
  console.log(JSON.stringify(counts));
  if (counts.failed > 0 || counts.skipped > 0) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ failed: 1 }));
  process.exitCode = 1;
}
