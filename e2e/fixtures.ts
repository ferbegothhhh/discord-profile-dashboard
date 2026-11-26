import { test as base } from "@playwright/test";

export { expect, type Page, type Route } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, run) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.setItem("roblox-univers:dashboard-intro:seen:v2", "1");
      } catch {}
    });
    await run(page);
  },
});
