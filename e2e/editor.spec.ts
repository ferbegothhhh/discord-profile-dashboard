import { expect, test } from "@playwright/test";

test("selection, search, category, save, restore, reset and keyboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Lewati ke editor" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Karbon Dipilih" })).toBeVisible();
  const violet = page.getByRole("button", { name: "Violet Solid" });
  await violet.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Violet Dipilih" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Simpan draft lokal" }).click();
  await expect(page.locator(".save-status")).toContainText("berhasil disimpan hanya di browser ini");
  await page.reload();
  await expect(page.getByRole("button", { name: "Violet Dipilih" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
  await page.getByLabel("Cari background").fill("tidak-ada");
  await expect(page.getByText("Tidak ada warna yang cocok.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Hapus filter" }).click();
  await page.getByLabel("Kategori", { exact: true }).selectOption("Netral");
  await expect(page.getByRole("button", { name: "Violet Dipilih" })).toHaveCount(0);
  await page.getByRole("button", { name: "Bersihkan" }).click();
  await page.getByLabel("Cari background").fill("plum");
  await expect(page.getByRole("button", { name: "Plum Solid" })).toBeVisible();
  await page.getByRole("button", { name: "Bersihkan" }).click();
  await page.getByRole("button", { name: "Reset draft" }).click();
  await expect(page.locator(".save-status")).toContainText("Draft lokal dihapus");
  await page.reload();
  await expect(page.getByRole("button", { name: "Karbon Dipilih" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("profile-dashboard:draft:v1"))).toBeNull();
  expect(errors).toEqual([]);
});

test("loading, API failure, retry, empty catalog, reload and invalid response", async ({ page }) => {
  let state = "loading";
  await page.route("**/api/catalog", async (route) => {
    if (state === "loading") await new Promise((resolve) => setTimeout(resolve, 800));
    if (state === "empty") return route.fulfill({ json: { backgrounds: [] } });
    if (state === "invalid") return route.fulfill({ json: { backgrounds: [{ id: "fake" }] } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/");
  await expect(page.getByText("Memuat katalog sampel…")).toBeVisible();
  await expect(page.locator(".catalog-state[role='alert']")).toContainText("Katalog gagal dimuat");
  state = "empty";
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Katalog belum berisi", { exact: false })).toBeVisible();
  state = "invalid";
  await page.getByRole("button", { name: "Muat ulang katalog" }).click();
  await expect(page.locator(".catalog-state[role='alert']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
});

test("corrupt draft and blocked storage are explained", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("profile-dashboard:draft:v1", "invalid"));
  await page.goto("/");
  await expect(page.locator(".save-status")).toContainText("Draft lama tidak valid");
  await expect(page.getByRole("button", { name: "Karbon Dipilih" })).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    Storage.prototype.removeItem = () => { throw new Error("blocked"); };
  });
  await page.getByRole("button", { name: "Simpan draft lokal" }).click();
  await expect(page.locator(".save-status")).toContainText("Draft gagal disimpan");
  await page.getByRole("button", { name: "Reset draft" }).click();
  await expect(page.locator(".save-status")).toContainText("gagal dihapus");
});

for (const width of [320, 375, 600, 768, 1024, 1440]) {
  test(`responsive ${width}px, controls and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Violet Solid" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const control of await page.locator("button, input, select").all()) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByLabel("Cari background").focus();
    expect(await page.getByLabel("Cari background").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  });
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`shadcn controls and Motion selection with ${reducedMotion}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    const preview = page.locator(".profile-preview");
    const search = page.getByLabel("Cari background");
    const category = page.getByLabel("Kategori", { exact: true });
    const violet = page.getByRole("button", { name: "Violet Solid" });
    await expect(violet).toBeVisible();
    await expect(search).toHaveAttribute("data-slot", "input");
    await expect(category).toHaveAttribute("data-slot", "native-select");
    await expect(violet).toHaveAttribute("data-slot", "button");
    await expect(violet).toHaveAttribute("data-size", "swatch");
    await expect(preview).toHaveCSS("background-color", "rgb(32, 32, 36)");
    await expect(preview).toHaveCSS("transform", "none");
    const save = page.getByRole("button", { name: "Simpan draft lokal" });
    await expect(save).toHaveAttribute("data-variant", "default");
    await expect(save).toHaveCSS("background-color", "rgb(119, 64, 214)");
    await violet.focus();
    await expect(violet).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(preview).toHaveCSS("background-color", "rgb(73, 50, 96)");
    await expect(page.locator(".draft-summary")).toContainText("Violet");
    if (reducedMotion === "reduce") {
      await page.getByRole("button", { name: "Plum Solid" }).click();
      const frames = await preview.evaluate(async (element) => {
        const colors: string[] = [];
        for (let index = 0; index < 4; index++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          colors.push(getComputedStyle(element).backgroundColor);
        }
        return colors;
      });
      expect(frames).toEqual(Array(4).fill("rgb(53, 36, 66)"));
      await expect(search).toHaveCSS("transition-duration", "0s");
    }
    await page.getByRole("button", { name: "Reset draft" }).click();
    await expect(preview).toHaveCSS("background-color", "rgb(32, 32, 36)");
    expect(errors).toEqual([]);
  });
}

test("safe health and sample catalog APIs", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ status: "ok", mode: "local-draft", integrations: { discord: "setup-required", supabase: "not-connected", bot: "not-connected" } });
  const catalog = await request.get("/api/catalog");
  expect((await catalog.json()).source).toBe("sample-solid-swatches");
});
