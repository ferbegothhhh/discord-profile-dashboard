import { expect, test, type Page } from "@playwright/test";

const key = "roblox-univers:dashboard-intro:seen:v2";
const introDocument = "**/intro/index.html?*";
const introFrame = 'iframe[title="Roblox Univers Winter Intro"]';

function introRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/intro/")) requests.push(pathname);
  });
  return requests;
}

async function pauseIntroClock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 60_000));
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/auth/session", route => route.fulfill({ status: 401, json: { status: "signed_out" } }));
  await page.route("https://fonts.googleapis.com/**", route => route.abort());
});

test("fresh session traps focus, skips by keyboard and stays dismissed across reload and navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const intro = page.getByRole("dialog");
  const skip = intro.getByRole("button", { name: "Lewati intro" });
  const replay = page.frameLocator(introFrame).getByRole("button", { name: "Putar ulang" });
  await expect(replay).toBeVisible();
  await expect(skip).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => {
    const focused = document.activeElement;
    return focused === document.body || !!focused?.closest("dialog[open]");
  })).toBe(true);
  await skip.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(replay).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(intro).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Universality", exact: true })).toBeVisible();
  expect(await page.evaluate(k => sessionStorage.getItem(k), key)).toBe("1");
  await page.reload();
  await expect(page.locator(".studio-brand-effect")).toBeAttached();
  await expect(intro).not.toBeVisible();
  await page.goto("/privacy");
  await page.goto("/");
  await expect(page.locator(".studio-brand-effect")).toBeAttached();
  await expect(intro).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("StrictMode replay keeps the intro visible despite a legacy seen key and queued close events", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "intro-dev", "Requires development effect replay");
  await page.addInitScript(() => {
    sessionStorage.setItem("roblox-univers:dashboard-intro:seen:v1", "1");
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      this.dataset.opens = String(Number(this.dataset.opens ?? 0) + 1);
      return showModal.call(this);
    };
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const intro = page.locator(".session-intro");
  await expect(intro).toHaveAttribute("data-opens", "2");
  await expect(intro.getByRole("button", { name: "Lewati intro" })).toBeVisible();
  await intro.dispatchEvent("close");
  await expect(intro.getByRole("button", { name: "Lewati intro" })).toBeVisible();
  await page.getByRole("button", { name: "Lewati intro" }).click();
  await expect(intro).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".studio-brand-effect")).toBeAttached();
  await expect(intro).not.toBeVisible();
});

test("deadline includes the fade even when the intro frame never finishes loading", async ({ page }) => {
  const requests = introRequests(page);
  await page.route(introDocument, () => new Promise(() => {}));
  await pauseIntroClock(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const intro = page.getByRole("dialog");
  await expect(intro).toBeVisible();
  await page.clock.runFor(4299);
  await expect(intro.getByRole("button", { name: "Lewati intro" })).toBeVisible();
  await expect.poll(() => requests).toEqual(["/intro/index.html"]);
  await expect(intro).not.toHaveClass(/session-intro-fading/);
  await page.clock.runFor(1);
  await expect(intro).toHaveClass(/session-intro-fading/);
  await page.clock.runFor(150);
  await expect(intro).not.toBeVisible();
  await expect(page.locator(introFrame)).toHaveCount(0);
});

test("Escape dismisses and restores access to dashboard controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Lewati intro" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: "Katalog background", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#catalog$/);
});

test("reduced motion never renders or requests the intro frame", async ({ page }) => {
  const requests = introRequests(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Background 2 Bawaan" })).toBeEnabled();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(introFrame)).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("motion preference changes dismiss immediately", async ({ page }) => {
  await pauseIntroClock(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.clock.runFor(32);
  await expect(page.locator(introFrame)).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(introFrame)).toHaveCount(0);
});

test("storage failure fails open without requesting the intro frame", async ({ page }) => {
  const requests = introRequests(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await page.goto("/");
  await expect(page.locator(".studio-brand-effect")).toBeAttached();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.locator(introFrame)).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("a failed intro frame yields to the dashboard at the deadline", async ({ page }) => {
  const failure = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/intro/index.html");
  await page.route(introDocument, route => route.abort());
  await pauseIntroClock(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const intro = page.getByRole("dialog");
  await expect(intro).toBeVisible();
  await page.clock.runFor(32);
  await failure;
  await page.clock.runFor(4418);
  await expect(intro).not.toBeVisible();
  await expect(page.locator(introFrame)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Background 2 Bawaan" })).toBeEnabled();
});

for (const width of [320, 1440]) {
  test(`intro fits and remains legible at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
    const frame = page.frameLocator(introFrame);
    const image = frame.getByRole("img", { name: "Logo Roblox Univers dengan topi Santa" });
    const title = frame.getByRole("heading", { name: "Roblox Univers" });
    const skip = page.getByRole("button", { name: "Lewati intro" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 500 && img.naturalHeight === 500)).toBe(true);
    await expect(title).toBeVisible();
    await expect(title.locator(".c").last()).toHaveCSS("opacity", "1");
    await expect(skip).toHaveCSS("color", "rgb(245, 245, 247)");
    const frameBox = (await page.locator(introFrame).boundingBox())!;
    for (const content of [image, title, skip]) {
      const box = (await content.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(frameBox.x);
      expect(box.y).toBeGreaterThanOrEqual(frameBox.y);
      expect(box.x + box.width).toBeLessThanOrEqual(frameBox.x + frameBox.width);
      expect(box.y + box.height).toBeLessThanOrEqual(frameBox.y + frameBox.height);
    }
    expect(frameBox.x + frameBox.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`intro-${width}.png`) });
    await skip.click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`dashboard-${width}.png`) });
  });
}
