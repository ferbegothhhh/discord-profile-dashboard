import { expect, test, type Page, type Route } from "@playwright/test";

const guildA = "234567890123456789";
const guildB = "345678901234567890";
const draftKey = "profile-dashboard:draft:v1";

async function mockSession(page: Page) {
  let account = "123456789012345678";
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: {
    status: "authenticated",
    user: { id: account, username: "mock-account", name: account },
    guilds: [{ id: guildA, name: "Server A" }, { id: guildB, name: "Server B" }],
  } }));
  return { getAccount: () => account, switchAccount: (id: string) => { account = id; } };
}

async function chooseGuild(page: Page, id = guildA) {
  await page.getByLabel("Server keanggotaan kamu").selectOption(id);
}

const selected = (page: Page, name: string) => page.getByRole("button", { name: `${name} Dipilih` });
const status = (page: Page) => page.locator(".save-status");

async function settleLate(route: Route, backgroundId: string | null, state = "ready") {
  await route.fulfill({ json: { status: state, backgroundId } }).catch(() => {});
}

test("remote null, account and guild isolation never import or overwrite anonymous draft", async ({ page }) => {
  const { getAccount, switchAccount } = await mockSession(page);
  const originalAccount = getAccount();
  const writes: unknown[] = [];
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ version: 1, backgroundId: "catalog-background-2" })), draftKey);
  await page.route("**/api/preferences**", (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: "saved" } });
    }
    const id = new URL(route.request().url()).searchParams.get("guildId");
    return route.fulfill({ json: { status: "ready", backgroundId: getAccount() === originalAccount && id === guildA ? "catalog-background-2" : null } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
  await chooseGuild(page);
  await expect(selected(page, "Background 2")).toBeVisible();
  await expect(selected(page, "Background 2").locator(".swatch-color")).toHaveCSS("background-image", /\/background2\.jpeg["']?\)$/);
  await expect(page.getByRole("button", { name: "Background 1 Bawaan" }).locator(".swatch-color")).toHaveCSS("background-image", /\/background1\.jpeg["']?\)$/);
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeDisabled();
  await chooseGuild(page, guildB);
  await expect(status(page)).toContainText("Belum ada pilihan online");
  await expect(selected(page, "Background 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeEnabled();
  await page.getByRole("button", { name: "Background 2 Bawaan" }).click();
  await expect(selected(page, "Background 2")).toBeVisible();
  switchAccount("456789012345678901");
  await page.getByRole("button", { name: "Muat ulang server" }).click();
  await expect(page.getByLabel("Server keanggotaan kamu")).toHaveValue("");
  await expect(selected(page, "Background 1")).toBeVisible();
  await chooseGuild(page, guildA);
  await expect(status(page)).toContainText("Belum ada pilihan online");
  await expect(selected(page, "Background 1")).toBeVisible();
  expect(writes).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(JSON.stringify({ version: 1, backgroundId: "catalog-background-2" }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({ json: { status: "signed_out" } }));
  await page.getByRole("button", { name: "Logout Discord" }).click();
  await expect(status(page)).toContainText("Draft dimuat dari browser");
  await expect(selected(page, "Background 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan draft lokal" })).toBeDisabled();
  expect(writes).toEqual([]);
});

test("late GET cannot restore a previous guild selection", async ({ page }) => {
  await mockSession(page);
  let late: Route | undefined;
  await page.route("**/api/preferences**", (route) => {
    if (route.request().url().includes(guildA)) { late = route; return; }
    return route.fulfill({ json: { status: "ready", backgroundId: null } });
  });
  await page.goto("/");
  await chooseGuild(page);
  await expect(status(page)).toContainText("Memuat preferensi online");
  await expect(page.getByRole("button", { name: "Background 2 Bawaan" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Reset pilihan" })).toBeDisabled();
  await chooseGuild(page, guildB);
  await expect(status(page)).toContainText("Belum ada pilihan online");
  expect(late).toBeDefined();
  await settleLate(late!, "catalog-background-2");
  await expect(selected(page, "Background 1")).toBeVisible();
  await expect(status(page)).toContainText("Belum ada pilihan online");
});

for (const action of ["save", "reset"] as const) {
  test(`late ${action} after account/guild switch is ignored, controls lock while pending`, async ({ page }) => {
    const { getAccount, switchAccount } = await mockSession(page);
    const originalAccount = getAccount();
    let late: Route | undefined;
    await page.route("**/api/preferences**", (route) => {
      if (route.request().method() === "POST") { late = route; return; }
      return route.fulfill({ json: { status: "ready", backgroundId: getAccount() === originalAccount ? "catalog-background-1" : "catalog-background-2" } });
    });
    await page.goto("/");
    await chooseGuild(page);
    await expect(selected(page, "Background 1")).toBeVisible();
    if (action === "save") await page.getByRole("button", { name: "Background 2 Bawaan" }).click();
    await page.getByRole("button", { name: action === "save" ? "Simpan online" : "Reset pilihan" }).click();
    await expect(page.getByRole("button", { name: "Memproses…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: action === "save" ? "Background 1 Bawaan" : "Background 2 Bawaan" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reset pilihan" })).toBeDisabled();
    if (action === "save") {
      await chooseGuild(page, guildB);
    } else {
      switchAccount("456789012345678901");
      await page.getByRole("button", { name: "Muat ulang server" }).click();
      await expect(page.getByLabel("Server keanggotaan kamu")).toHaveValue("");
      await chooseGuild(page);
    }
    await expect(status(page)).toContainText("Pilihan dimuat dari Supabase/cloud");
    expect(late).toBeDefined();
    expect(late!.request().postDataJSON()).toEqual({ guildId: guildA, backgroundId: action === "save" ? "catalog-background-2" : null });
    await settleLate(late!, action === "save" ? "catalog-background-2" : null, action === "save" ? "saved" : "reset");
    await expect(selected(page, action === "save" ? "Background 1" : "Background 2")).toBeVisible();
    await expect(status(page)).toContainText("Pilihan dimuat dari Supabase/cloud");
    await expect(page.getByRole("button", { name: "Simpan online" })).toBeDisabled();
  });
}

for (const code of [401, 403, 503, 400, 429]) {
  test(`GET ${code} is not an empty preference or local save and can retry`, async ({ page }) => {
    await mockSession(page);
    let fail = true;
    await page.route("**/api/preferences**", (route) => route.fulfill(fail ? { status: code, json: { error: "mock" } } : { json: { status: "ready", backgroundId: null } }));
    await page.goto("/");
    await chooseGuild(page);
    const expected = code === 401 ? "Sesi berakhir" : code === 403 ? "registry bot" : code === 503 ? "Supabase/database" : code === 400 ? "tidak aktif" : "Terlalu banyak";
    await expect(status(page)).toContainText(expected);
    await expect(page.getByRole("button", { name: "Simpan online" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Reset pilihan" })).toBeDisabled();
    fail = false;
    await page.getByRole("button", { name: "Muat ulang preferensi" }).click();
    await expect(status(page)).toContainText("Belum ada pilihan online");
    await expect(page.getByRole("button", { name: "Simpan online" })).toBeEnabled();
  });
}

test("unknown remote ID has safe fallback and no saved claim, then retries", async ({ page }) => {
  await mockSession(page);
  let id: string | null = "unknown-active-background";
  await page.route("**/api/preferences**", (route) => route.fulfill({ json: { status: "ready", backgroundId: id } }));
  await page.goto("/");
  await chooseGuild(page);
  await expect(status(page)).toContainText("tidak dikenal");
  await expect(selected(page, "Background 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeDisabled();
  id = null;
  await page.getByRole("button", { name: "Muat ulang preferensi" }).click();
  await expect(status(page)).toContainText("Belum ada pilihan online");
});

test("mobile cloud save and reset retry retain actual saved state with all browser storage blocked", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockSession(page);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    Storage.prototype.removeItem = () => { throw new Error("blocked"); };
  });
  let fail = true;
  const writes: unknown[] = [];
  await page.route("**/api/preferences**", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { status: "ready", backgroundId: "catalog-background-1" } });
    const body = route.request().postDataJSON();
    writes.push(body);
    return route.fulfill(fail ? { status: body.backgroundId === null ? 403 : 503, json: { error: "mock" } } : { json: { status: body.backgroundId === null ? "reset" : "saved" } });
  });
  await page.goto("/");
  await chooseGuild(page);
  await expect(selected(page, "Background 1")).toBeVisible();
  const background2 = page.getByRole("button", { name: "Background 2 Bawaan" });
  await background2.focus();
  await expect(background2).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Simpan online" }).click();
  await expect(status(page)).toContainText("Belum berhasil menyimpan online");
  await expect(status(page)).toContainText("Supabase/database");
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeEnabled();
  fail = false;
  await page.getByRole("button", { name: "Simpan online" }).click();
  await expect(status(page)).toContainText("Pilihan disimpan di Supabase/cloud");
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeDisabled();
  fail = true;
  await page.getByRole("button", { name: "Reset pilihan" }).click();
  await expect(status(page)).toContainText("Belum berhasil mereset online");
  await expect(status(page)).toContainText("registry bot");
  await expect(selected(page, "Background 2")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Reset pilihan" }).click();
  await expect(status(page)).toContainText("Pilihan online direset");
  await expect(selected(page, "Background 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan online" })).toBeEnabled();
  expect(writes).toEqual([
    { guildId: guildA, backgroundId: "catalog-background-2" }, { guildId: guildA, backgroundId: "catalog-background-2" },
    { guildId: guildA, backgroundId: null }, { guildId: guildA, backgroundId: null },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await page.locator("button, input, select").all()) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  expect(errors).toEqual([]);
});
