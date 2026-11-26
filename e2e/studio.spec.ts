import { expect, test } from "./fixtures";
import sharp from "sharp";

test("exact preview is explicit, read-only and invalidated by selection and guild", async ({ page }) => {
  const requests: unknown[] = [];
  const writes: string[] = [];
  const png = await sharp({ create: { width: 1000, height: 560, channels: 4, background: "#352442" } }).png().toBuffer();
  await page.route("**/api/auth/session", route => route.fulfill({ json: { status: "authenticated", user: { id: "111111111111111111", name: "Akun uji", username: "test" }, guilds: [{ id: "222222222222222222", name: "Server uji" }, { id: "333333333333333333", name: "Server lain" }] } }));
  await page.route("**/api/preferences**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    return route.fulfill({ json: { status: "ready", backgroundId: null } });
  });
  await page.route("**/api/backgrounds?*", route => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/profile-preview", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "image/png", body: png, headers: { "Cache-Control": "private, no-store" } });
  });
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption("222222222222222222");
  const refresh = page.getByRole("button", { name: "Perbarui preview", exact: true });
  await expect(refresh).toBeEnabled();
  expect(requests).toHaveLength(0);
  await refresh.focus();
  await page.keyboard.press("Enter");
  const image = page.getByAltText("Hasil renderer bot untuk akun dan server terpilih");
  await expect(image).toBeVisible();
  const previous = await image.getAttribute("src");
  expect(previous).toMatch(/^blob:/);
  await expect(page.locator(".profile-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Background 2 Bawaan", exact: true }).click();
  await expect(image).toHaveCount(0);
  expect(await page.evaluate(async src => { try { await fetch(src!); return true; } catch { return false; } }, previous)).toBe(false);
  await refresh.click();
  await expect(image).toBeVisible();
  await page.getByRole("button", { name: "Coba default bot" }).click();
  await expect(image).toHaveCount(0);
  await refresh.click();
  await expect(image).toBeVisible();
  expect(requests).toEqual([
    { guildId: "222222222222222222", backgroundId: "catalog-background-1", revision: null },
    { guildId: "222222222222222222", backgroundId: "catalog-background-2", revision: null },
    { guildId: "222222222222222222", backgroundId: null, revision: null },
  ]);
  await page.getByLabel("Server keanggotaan kamu").selectOption("333333333333333333");
  await expect(image).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("conditional library and moderation navigation follows the selected guild", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { status: "authenticated", user: { id: "111111111111111111", name: "Akun uji", username: "test" }, guilds: [{ id: "222222222222222222", name: "Server uji", canModerate: true }, { id: "333333333333333333", name: "Server anggota", canModerate: false }] } }));
  await page.route("**/api/preferences?*", (route) => route.fulfill({ json: { status: "ready", backgroundId: null } }));
  await page.route("**/api/backgrounds?*", (route) => route.fulfill({ status: 503, json: {} }));
  await page.route("**/api/moderation/backgrounds?*", (route) => route.fulfill({ json: { guildId: "222222222222222222", items: [], next: null } }));
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption("222222222222222222");
  const nav = page.getByRole("navigation", { name: "Navigasi studio" });
  await nav.getByRole("link", { name: "Library pribadi" }).click();
  await expect(page).toHaveURL(/#library$/);
  await expect(page.locator("#library")).toBeVisible();
  await nav.getByRole("link", { name: "Moderasi server" }).click();
  await expect(page).toHaveURL(/#moderation$/);
  await expect(page.locator("#moderation")).toBeVisible();
  await page.getByLabel("Server keanggotaan kamu").selectOption("333333333333333333");
  await expect(nav.getByRole("link", { name: "Moderasi server" })).toHaveCount(0);
  await expect(page.locator("#moderation")).toHaveCount(0);
});

test("Discord upstream errors show retry delay and re-read without replaying failed writes or losing draft", async ({ page }) => {
  let reads = 0;
  let writes = 0;
  let libraries = 0;
  let sessions = 0;
  await page.route("**/api/auth/session", route => { sessions++; return route.fulfill({ json: { status: "authenticated", user: { id: "111111111111111111", name: "Akun uji", username: "test" }, guilds: [{ id: "222222222222222222", name: "Server uji" }] } }); });
  await page.route("**/api/backgrounds?*", route => { libraries++; return route.fulfill({ status: 503, headers: { "Retry-After": "12" }, json: { error: "discord_unavailable", reason: "rate_limited" } }); });
  await page.route("**/api/preferences**", route => {
    if (route.request().method() === "GET") {
      reads++;
      if (reads > 1) return route.fulfill({ json: { status: "ready", backgroundId: null } });
    } else writes++;
    return route.fulfill({ status: 503, headers: { "Retry-After": "12" }, json: { error: "discord_unavailable", reason: "rate_limited" } });
  });
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption("222222222222222222");
  await expect(page.locator(".save-status")).toContainText("Discord membatasi verifikasi akses");
  await expect(page.locator(".save-status")).toContainText("12 detik");
  await expect(page.locator("#library")).toContainText("Discord membatasi verifikasi akses");
  await page.clock.install();
  await page.clock.fastForward(15000);
  expect({ reads, libraries, sessions, writes }).toEqual({ reads: 1, libraries: 1, sessions: 1, writes: 0 });
  await page.getByRole("button", { name: "Muat ulang preferensi", exact: true }).click();
  await page.getByRole("button", { name: "Background 2 Bawaan", exact: true }).click();
  await page.getByRole("button", { name: "Simpan online", exact: true }).click();
  await expect(page.locator(".save-status")).toContainText("Discord membatasi verifikasi akses");
  await page.getByRole("button", { name: "Muat ulang preferensi", exact: true }).click();
  await expect(page.locator(".draft-summary")).toContainText("Background 2");
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeEnabled();
  expect(reads).toBe(3);
  expect(writes).toBe(1);
});

test("Universality uses TechText on hover and switches to static text when motion is reduced", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/auth/session", route => route.fulfill({ status: 401, json: { status: "signed_out" } }));
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const title = page.getByRole("heading", { name: "Universality", exact: true, level: 1 });
  await expect(title).toHaveCount(1);
  const effect = title.locator(".universality-title-effect");
  await expect(effect).toHaveAttribute("aria-hidden", "true");
  await expect(effect.locator("canvas")).toHaveCount(1);
  await expect(page.getByRole("img", { name: "Universality" })).toHaveCount(0);
  const before = await title.boundingBox();
  await title.hover();
  await expect(effect).toBeVisible();
  await expect.poll(() => effect.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d")!;
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  await expect(title.locator(".universality-title-text")).toHaveCSS("opacity", "0");
  expect(await title.boundingBox()).toEqual(before);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(effect).toHaveCount(0);
  await expect(title.locator(".universality-title-text")).toHaveCSS("opacity", "1");
  expect(await title.boundingBox()).toEqual(before);
  expect(errors).toEqual([]);
});

for (const width of [320, 1440]) {
  test(`topbar Shuffle preserves one accessible brand and reduced-motion fallback ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/auth/session", route => route.fulfill({ status: 401, json: { status: "signed_out" } }));
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const topbar = page.locator(".studio-topbar");
    const brand = topbar.locator(".studio-brand");
    const text = brand.locator(".studio-brand-text");
    const shuffle = brand.locator(".shuffle-parent");
    await expect(text).toHaveText("Roblox Univers");
    await expect(text).toHaveCSS("opacity", "1");
    await expect(shuffle).toHaveCount(0);
    const box = await brand.boundingBox();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(brand.locator(".studio-brand-effect")).toHaveAttribute("aria-hidden", "true");
    await expect(shuffle).toHaveClass(/is-ready/);
    await expect(shuffle.locator(".shuffle-char")).toHaveCount("RobloxUnivers".length);
    await expect(shuffle).toHaveText("Roblox Univers");
    await expect(text).toHaveCSS("opacity", "0");
    await expect(shuffle).toHaveCSS("text-transform", "none");
    await expect(shuffle).toHaveCSS("font-size", width === 320 ? "20px" : "28px");
    expect(await brand.boundingBox()).toEqual(box);
    expect((await topbar.ariaSnapshot()).match(/Roblox Univers/g)).toHaveLength(1);
    await brand.hover();
    await expect(shuffle).toHaveText("Roblox Univers");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(shuffle).toHaveCount(0);
    await expect(text).toHaveCSS("opacity", "1");
    expect(await brand.boundingBox()).toEqual(box);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(shuffle).toHaveClass(/is-ready/);
    await expect(shuffle).toHaveText("Roblox Univers");
    await topbar.getByRole("link", { name: "Hubungkan Discord" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#discord$/);
    await expect(page.locator("#discord")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 375, 768, 1440, 1600]) {
  test(`studio navigation, composition and screenshot ${width}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/auth/session", (route) => route.fulfill({ status: 401, json: { status: "signed_out" } }));
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Background 2 Bawaan", exact: true })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    const title = page.getByRole("heading", { name: "Universality", exact: true });
    await expect(title).toHaveCount(1);
    expect(await title.evaluate(element => element.tagName)).toBe("H1");
    await expect(title.locator(".universality-title-text")).toHaveText("Universality");
    await expect(title.locator("canvas")).toHaveCount(0);
    await expect(title).toHaveCSS("font-weight", "800");
    await expect(title).toHaveCSS("font-family", /Barlow/);
    const titleBox = await title.boundingBox();
    expect(titleBox!.x).toBeGreaterThanOrEqual(0);
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(width);
    const backdrop = page.locator(".studio-backdrop");
    await expect(backdrop).toHaveAttribute("aria-hidden", "true");
    await expect(backdrop).toHaveCSS("position", "fixed");
    await expect(backdrop.locator("img")).toHaveAttribute("alt", "");
    await expect.poll(() => backdrop.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    const nav = page.getByRole("navigation", { name: "Navigasi studio" });
    await expect(nav.getByRole("link", { name: "Library pribadi" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Moderasi server" })).toHaveCount(0);
    for (const [name, hash] of [["Katalog background", "#catalog"], ["Akun & server", "#discord"], ["Editor profil", "#editor"]]) {
      await nav.getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${hash}$`));
      await expect(page.locator(hash)).toBeVisible();
    }
    await page.keyboard.press("Tab");
    await nav.getByRole("link", { name: "Katalog background" }).focus();
    await expect(nav.getByRole("link", { name: "Katalog background" })).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Background 2 Bawaan", exact: true }).click();
    await expect(page.locator(".draft-summary")).toContainText("Background 2");
    const tiles = page.locator(".catalog-grid .swatch");
    await expect(tiles).toHaveCount(2);
    const [first, second] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(1).boundingBox()]);
    if (width >= 440) {
      expect(first!.y).toBe(second!.y);
      expect(second!.x + second!.width).toBeCloseTo((await page.locator(".catalog-grid").boundingBox())!.width + first!.x, 0);
    } else {
      expect(second!.y).toBeGreaterThan(first!.y + first!.height);
    }
    const catalog = await page.locator(".background-options").boundingBox();
    const preview = await page.locator(".preview-section").boundingBox();
    if (width >= 700) expect(preview!.x).toBeGreaterThan(catalog!.x + catalog!.width);
    else expect(preview!.y).toBeGreaterThan(catalog!.y + catalog!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const link of await nav.getByRole("link").all()) {
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`studio-${width}.png`), fullPage: true });
    await page.route("**/api/auth/discord*", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Mock OAuth endpoint</h1>" }));
    await page.getByRole("button", { name: "Login dengan Discord" }).click();
    await expect(page).toHaveURL(/\/api\/auth\/discord/);
    await expect(page.getByRole("heading", { name: "Mock OAuth endpoint" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
