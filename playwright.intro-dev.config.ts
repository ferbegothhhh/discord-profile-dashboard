import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "intro.spec.ts",
  fullyParallel: false,
  workers: 1,
  projects: [{ name: "intro-dev" }],
  use: { baseURL: "http://127.0.0.1:3101", browserName: "chromium" },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3101",
    url: "http://127.0.0.1:3101",
    reuseExistingServer: false,
    env: { DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", APP_URL: "", SESSION_PASSWORD: "" },
    timeout: 120000,
  },
});
