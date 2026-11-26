import { expect, test } from "./fixtures";

for (const width of [320, 1440]) {
  test(`footer keyboard, legal links and layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/");
    const footer = page.locator("footer.stt");
    await footer.scrollIntoViewIfNeeded();
    const toggle = footer.locator(".stt-toggle");
    const note = footer.locator(".stt-note");
    await expect(note).toHaveAttribute("inert", "");
    await expect(footer.locator('a[href="/terms"]')).toBeVisible();
    await expect(footer.locator('a[href="/privacy"]')).toBeVisible();
    await footer.locator(".stt-seal").focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(footer).toHaveAttribute("data-phase", "open", { timeout: 2500 });
    await expect(note).not.toHaveAttribute("inert");
    await page.waitForTimeout(800);
    const link = note.getByRole("link");
    await link.focus();
    await expect(link).toBeFocused();
    const bounds = await link.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`footer-${width}-open.png`), fullPage: true });
    await footer.screenshot({ path: testInfo.outputPath(`footer-${width}-detail.png`) });
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(note).toHaveAttribute("inert", "");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    await expect(footer).toHaveAttribute("data-phase", "open");
    await toggle.click();
    await expect(note).toHaveAttribute("inert", "");
    await toggle.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(footer.locator(".stt-seal")).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test("footer stages visible motion, reverses rapid toggles and stops writing at idle", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const footer = page.locator("footer.stt");
  await footer.scrollIntoViewIfNeeded();
  const toggle = footer.locator(".stt-toggle");
  await toggle.click();
  await page.waitForTimeout(240);
  await footer.screenshot({ path: testInfo.outputPath("cord-unwind.png") });
  await page.waitForTimeout(350);
  await footer.screenshot({ path: testInfo.outputPath("flap-open.png") });
  await page.waitForTimeout(350);
  await footer.screenshot({ path: testInfo.outputPath("note-slide.png") });
  for (const delay of [90, 180, 60, 220]) {
    await toggle.click();
    await page.waitForTimeout(delay);
  }
  await expect(footer).toHaveAttribute("data-phase", "open");
  await expect(footer.locator(".stt-note")).not.toHaveAttribute("inert");
  expect(await footer.evaluate(element => element.style.getPropertyValue("--stt-note"))).toBe("1");
  await toggle.click();
  await page.waitForTimeout(1600);
  expect(await footer.evaluate(element => element.style.getPropertyValue("--stt-note"))).toBe("0");
  expect(await footer.evaluate(element => element.style.getPropertyValue("--stt-flap"))).toBe("1");
  const writes = await footer.evaluate(async element => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(element, { attributes: true, subtree: true, attributeFilter: ["style", "d"] });
    await new Promise(resolve => setTimeout(resolve, 400));
    observer.disconnect();
    return count;
  });
  expect(writes).toBe(0);
  await expect(footer.locator(".stt-note")).toHaveAttribute("inert", "");
});

test("reduced motion opens immediately with no animations and a static cord", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const footer = page.locator("footer.stt");
  await footer.scrollIntoViewIfNeeded();
  await footer.locator(".stt-toggle").click();
  await expect(footer).toHaveAttribute("data-phase", "open");
  const path = footer.locator(".stt-cord path");
  const d = await path.getAttribute("d");
  await page.waitForTimeout(500);
  expect(await path.getAttribute("d")).toBe(d);
  expect(await footer.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await footer.locator(".stt-toggle").click();
  await expect(footer.locator(".stt-note")).toHaveAttribute("inert", "");
});

test("loose cord responds to pointer drag, settles and stays still offscreen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const footer = page.locator("footer.stt");
  await footer.scrollIntoViewIfNeeded();
  await footer.locator(".stt-toggle").click();
  await expect(footer).toHaveAttribute("data-phase", "open");
  await page.waitForTimeout(2800);
  const path = footer.locator(".stt-cord path");
  const initial = await path.getAttribute("d");
  const box = await footer.locator(".stt-cord").boundingBox();
  await page.mouse.move(box!.x + box!.width * .76, box!.y + box!.height * .91);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * .9, box!.y + box!.height * .7, { steps: 12 });
  await page.waitForTimeout(100);
  expect(await path.getAttribute("d")).not.toBe(initial);
  await page.mouse.up();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2800);
  const settled = await path.getAttribute("d");
  await page.waitForTimeout(300);
  expect(await path.getAttribute("d")).toBe(settled);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(300);
  const offscreen = await path.getAttribute("d");
  await page.waitForTimeout(500);
  expect(await path.getAttribute("d")).toBe(offscreen);
});
