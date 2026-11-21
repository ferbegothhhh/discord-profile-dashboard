import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:3100", browserName: "chromium" },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: { DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", APP_URL: "", SESSION_PASSWORD: "" },
    timeout: 120000,
  },
});
