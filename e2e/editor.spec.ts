import { expect, test } from "./fixtures";

test("selection, search, category, save, restore, reset and keyboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Lewati ke editor" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Background 1 Dipilih" })).toBeVisible();
  const second = page.getByRole("button", { name: "Background 2 Bawaan" });
  await expect(second).toBeEnabled();
  await second.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Background 2 Dipilih" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Simpan draft lokal" }).click();
  await expect(page.locator(".save-status")).toContainText("berhasil disimpan hanya di browser ini");
  expect(await page.evaluate(() => localStorage.getItem("profile-dashboard:draft:v1"))).toBe(JSON.stringify({ version: 1, backgroundId: "catalog-background-2" }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Background 2 Dipilih" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
  const search = page.getByLabel("Cari background");
  const category = page.getByLabel("Kategori", { exact: true });
  const swatches = page.locator("#catalog .swatch");
  await search.fill("tidak-ada");
  await expect(page.getByText("Tidak ada background yang cocok.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Hapus filter" }).click();
  await category.selectOption("Katalog");
  await expect(category).toHaveValue("Katalog");
  await expect(swatches).toHaveCount(2);
  await search.fill("background 1");
  await expect(swatches).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Background 1 Bawaan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Background 2 Dipilih" })).toHaveCount(0);
  await page.getByRole("button", { name: "Bersihkan" }).click();
  await expect(category).toHaveValue("Semua");
  await expect(search).toHaveValue("");
  await expect(swatches).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Background 2 Dipilih" })).toBeVisible();
  await page.getByRole("button", { name: "Reset draft" }).click();
  await expect(page.locator(".save-status")).toContainText("Draft lokal dihapus");
  await page.reload();
  await expect(page.getByRole("button", { name: "Background 1 Dipilih" })).toBeVisible();
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
  await expect(page.getByText("Memuat katalog gambar…")).toBeVisible();
  await expect(page.locator(".catalog-state[role='alert']")).toContainText("Katalog gagal dimuat");
  state = "empty";
  await page.getByRole("button", { name: "Coba lagi" }).click();
  await expect(page.getByText("Katalog belum berisi", { exact: false })).toBeVisible();
  state = "invalid";
  await page.getByRole("button", { name: "Muat ulang katalog" }).click();
  await expect(page.locator(".catalog-state[role='alert']")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
});

for (const upstream of [false, true]) {
  test(`session cooldown ${upstream ? "Discord" : "dashboard"} waits for manual retry and preserves draft`, async ({ page }) => {
    let calls = 0;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem("profile-dashboard:draft:v1", JSON.stringify({ version: 1, backgroundId: "catalog-background-2" })));
    await page.route("**/api/auth/session", route => {
      calls++;
      return route.fulfill(calls === 1 ? { status: upstream ? 502 : 429, headers: { "Retry-After": "601" }, json: { error: upstream ? "discord_unavailable" : "rate_limited", ...(upstream ? { reason: "rate_limited" } : {}) } } : { status: 401, json: { status: "signed_out" } });
    });
    await page.goto("/");
    await expect(page.locator(".auth-panel [role='alert']")).toContainText(upstream ? "Discord membatasi" : "permintaan sesi dashboard");
    const retry = page.getByRole("button", { name: "Muat ulang Discord" });
    await expect(retry).toBeDisabled();
    await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
    await page.clock.fastForward(301000);
    await expect(retry).toBeDisabled();
    expect(calls).toBe(1);
    await page.clock.fastForward(300000);
    await expect(retry).toBeEnabled();
    expect(calls).toBe(1);
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Login dengan Discord" })).toBeVisible();
    expect(calls).toBe(2);
    await expect(page.getByRole("button", { name: "Background 2 Dipilih" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
    await page.getByRole("button", { name: "Reset draft" }).click();
    await expect(page.getByRole("button", { name: "Background 1 Dipilih" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("corrupt draft and blocked storage are explained", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("profile-dashboard:draft:v1", "invalid"));
  await page.goto("/");
  await expect(page.locator(".save-status")).toContainText("Draft lama tidak valid");
  await expect(page.getByRole("button", { name: "Background 1 Dipilih" })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Background 2 Bawaan" })).toBeVisible();
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
    const second = page.getByRole("button", { name: "Background 2 Bawaan" });
    await expect(second).toBeEnabled();
    await expect(search).toHaveAttribute("data-slot", "input");
    await expect(category).toHaveAttribute("data-slot", "native-select");
    await expect(second).toHaveAttribute("data-slot", "button");
    await expect(second).toHaveAttribute("data-size", "swatch");
    await expect(preview).toHaveCSS("background-image", /\/background1\.jpeg"?\)$/);
    await expect(preview).toHaveCSS("background-size", "cover");
    await expect(preview).toHaveCSS("background-position", "50% 50%");
    await expect(preview).toHaveCSS("transform", "none");
    for (const [name, file, width, height] of [
      ["Background 1 Dipilih", "background1.jpeg", 735, 415],
      ["Background 2 Bawaan", "background2.jpeg", 736, 414],
    ] as const) {
      const thumbnail = page.getByRole("button", { name }).locator(".swatch-color");
      await expect(thumbnail).toBeVisible();
      const image = await thumbnail.evaluate(async (element) => {
        const src = getComputedStyle(element).backgroundImage.match(/^url\("?(.*?)"?\)$/)?.[1];
        if (!src) return null;
        const bitmap = new Image();
        bitmap.src = src;
        await bitmap.decode();
        return { pathname: new URL(bitmap.src).pathname, width: bitmap.naturalWidth, height: bitmap.naturalHeight };
      });
      expect(image).toEqual({ pathname: `/${file}`, width, height });
    }
    const save = page.getByRole("button", { name: "Simpan draft lokal" });
    await expect(save).toHaveAttribute("data-variant", "default");
    await expect(save).toHaveCSS("background-color", "rgb(119, 64, 214)");
    await second.focus();
    await expect(second).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(preview).toHaveCSS("background-image", /\/background2\.jpeg"?\)$/);
    await expect(page.locator(".draft-summary")).toContainText("Background 2");
    if (reducedMotion === "reduce") {
      await page.getByRole("button", { name: "Background 1 Bawaan" }).click();
      const frames = await preview.evaluate(async (element) => {
        const images: string[] = [];
        for (let index = 0; index < 4; index++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          images.push(getComputedStyle(element).backgroundImage);
        }
        return images;
      });
      expect(frames).toEqual(Array(4).fill(expect.stringMatching(/\/background1\.jpeg"?\)$/)));
      await expect(search).toHaveCSS("transition-duration", "0s");
    }
    await page.getByRole("button", { name: "Reset draft" }).click();
    await expect(preview).toHaveCSS("background-image", /\/background1\.jpeg"?\)$/);
    expect(errors).toEqual([]);
  });
}

test("safe health and sample catalog APIs", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({ status: "ok", mode: "local-draft", integrations: { discord: "setup-required", supabase: "not-connected", bot: "not-connected" } });
  const catalog = await request.get("/api/catalog");
  expect(catalog.ok()).toBe(true);
  expect(await catalog.json()).toEqual({
    source: "sample-solid-swatches",
    backgrounds: [
      { id: "catalog-background-1", name: "Background 1", image: "/background1.jpeg", category: "Katalog" },
      { id: "catalog-background-2", name: "Background 2", image: "/background2.jpeg", category: "Katalog" },
    ],
  });
});
