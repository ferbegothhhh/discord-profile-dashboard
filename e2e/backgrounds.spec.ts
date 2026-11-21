import { expect, test, type Page } from "@playwright/test";

const guildA = "234567890123456789";
const guildB = "345678901234567890";
const id = "11111111-1111-4111-8111-111111111111";
const background = { id, name: "Background pribadi 1", status: "ready", revision: 2, isActive: true };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const draftKey = "profile-dashboard:draft:v1";

async function setup(page: Page, options: { occupied?: boolean; level?: number; preference?: string; fail?: boolean; preferenceStatus?: number } = {}) {
  let occupied = options.occupied ?? false;
  let fail = options.fail ?? false;
  let preference: string | null = options.preference ?? null;
  const posts: unknown[] = [];
  const uploads: { method: string; type: string | undefined; bytes: Buffer | null }[] = [];
  const media: string[] = [];
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { status: "authenticated", user: { id: "123456789012345678", username: "mock", name: "mock" }, guilds: [{ id: guildA, name: "Server A" }, { id: guildB, name: "Server B" }] } }));
  await page.route("**/api/auth/logout", (route) => route.fulfill({ json: { status: "signed_out" } }));
  await page.route("**/api/preferences**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      preference = body.backgroundId;
      return route.fulfill({ json: { status: preference === null ? "reset" : "saved" } });
    }
    if (options.preferenceStatus) return route.fulfill({ status: options.preferenceStatus, json: { error: "unavailable" } });
    return route.fulfill({ json: { status: "ready", backgroundId: preference } });
  });
  await page.route("**/api/backgrounds**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const guildId = url.searchParams.get("guildId");
    if (url.pathname.endsWith("/media")) { media.push(request.url()); return route.fulfill({ contentType: "image/png", body: png }); }
    if (url.pathname.includes("/slots/")) {
      if (request.method() === "PUT") { uploads.push({ method: request.method(), type: request.headers()["content-type"], bytes: request.postDataBuffer() }); occupied = true; return route.fulfill({ status: 201, json: { status: "ready", guildId, slot: 1, background } }); }
      occupied = false;
      preference = null;
      return route.fulfill({ json: { status: "deleted", guildId, slot: 1, removed: true, cleanupPending: false } });
    }
    if (fail) return route.fulfill({ status: 503, json: { error: "level_unavailable" } });
    const level = options.level ?? 20;
    return route.fulfill({ json: { status: "ready", guildId, level, slots: [20, 45, 65].map((requiredLevel, index) => ({ slot: index + 1, requiredLevel, unlocked: level >= requiredLevel, background: occupied && index === 0 && guildId === guildA ? background : null })) } });
  });
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildA);
  return { posts, uploads, media, recover: () => { fail = false; } };
}

test("upload stays unsaved until explicit selection and cloud save, uses raw image and authenticated revision media", async ({ page }) => {
  const mock = await setup(page);
  await expect(page.getByText("Belum ada gambar pribadi di server ini.")).toBeVisible();
  await page.getByLabel("Upload slot 1").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".library-status")).toContainText("Belum disimpan");
  expect(mock.posts).toEqual([]);
  expect(mock.uploads[0]).toEqual({ method: "PUT", type: "image/png", bytes: png });
  await page.getByRole("button", { name: "Pilih slot 1", exact: true }).click();
  await expect(page.getByAltText("Perkiraan background pribadi: Background pribadi 1")).toBeVisible();
  expect(mock.media[0]).toContain(`/api/backgrounds/${id}/media?guildId=${guildA}&revision=2`);
  await page.getByRole("button", { name: "Simpan online", exact: true }).click();
  await expect(page.locator(".save-status")).toContainText("Pilihan disimpan");
  expect(mock.posts).toEqual([{ guildId: guildA, backgroundId: id }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(id);
});

test("locked retained metadata has no upload, selection or media; deletion needs inline confirmation", async ({ page }) => {
  const mock = await setup(page, { occupied: true, level: 0 });
  await expect(page.getByText("Background pribadi 1", { exact: true })).toBeVisible();
  await expect(page.locator('.private-library input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pilih slot 1", exact: true })).toHaveCount(0);
  expect(mock.media).toEqual([]);
  await page.getByRole("button", { name: "Hapus slot 1", exact: true }).click();
  await page.getByRole("button", { name: "Batal hapus" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Batal hapus" })).toHaveCount(0);
  await page.getByRole("button", { name: "Hapus slot 1", exact: true }).click();
  await page.getByRole("button", { name: "Ya, hapus slot 1" }).click();
  await expect(page.getByText("Belum ada gambar pribadi di server ini.")).toBeVisible();
});

test("library error retry and invalid files preserve safe mobile controls", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const mock = await setup(page, { fail: true });
  await expect(page.getByText("Layanan library belum tersedia.", { exact: false })).toBeVisible();
  mock.recover();
  await page.getByRole("button", { name: "Coba lagi library" }).click();
  await page.getByLabel("Upload slot 1").setInputFiles({ name: "bad.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await expect(page.locator(".library-status")).toContainText("PNG, JPG, atau WebP statis");
  expect(mock.uploads).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = await page.locator(".private-library button, .private-library input").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  expect(controls.every((height) => height >= 44)).toBe(true);
});

test("saved custom resolves after library load, reset and guild/logout never leak to anonymous storage", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ version: 1, backgroundId: "sample-plum" })), draftKey);
  const mock = await setup(page, { occupied: true, preference: id });
  await expect(page.getByRole("button", { name: "Dipilih slot 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reset pilihan", exact: true }).click();
  await expect(page.getByAltText("Perkiraan background pribadi: Background pribadi 1")).toHaveCount(0);
  await page.getByRole("button", { name: "Pilih slot 1", exact: true }).click();
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildB);
  await expect(page.getByAltText("Perkiraan background pribadi: Background pribadi 1")).toHaveCount(0);
  await page.getByRole("button", { name: "Logout Discord" }).click();
  await expect(page.getByRole("heading", { name: "Library pribadi" })).toHaveCount(0);
  await expect(page.locator(".save-status")).toContainText("Draft dimuat dari browser");
  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(JSON.stringify({ version: 1, backgroundId: "sample-plum" }));
  expect(mock.posts).toEqual([{ guildId: guildA, backgroundId: null }]);
});

test("upload errors are sanitized, pending controls lock and late upload cannot cross guilds", async ({ page }) => {
  await setup(page);
  await page.route("**/api/backgrounds/slots/1?*", (route) => route.fulfill({ status: 409, json: { error: "slot_occupied", detail: "secret-internal" } }));
  await page.getByLabel("Upload slot 1").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: png });
  await expect(page.locator(".library-status")).toContainText("hapus gambar lama");
  await expect(page.locator(".library-status")).not.toContainText("secret-internal");
  let finish: (() => Promise<void>) | undefined;
  await page.route("**/api/backgrounds/slots/1?*", (route) => { finish = () => route.fulfill({ status: 201, json: { status: "ready", guildId: guildA, slot: 1, background } }).catch(() => {}); });
  await page.getByLabel("Upload slot 1").setInputFiles({ name: "test.png", mimeType: "image/png", buffer: png });
  await expect(page.getByLabel("Upload slot 1")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildB);
  await expect(page.getByLabel("Upload slot 1")).toBeEnabled();
  expect(finish).toBeDefined();
  await finish!();
  await expect(page.locator(".library-status")).not.toContainText("Upload berhasil");
  await expect(page.getByRole("button", { name: "Pilih slot 1", exact: true })).toHaveCount(0);
});

for (const fail of [true, false]) {
  test(`unresolved custom preference permits explicit reset with library ${fail ? "503" : "missing image"}`, async ({ page }) => {
    const mock = await setup(page, { preference: id, fail });
    await expect(page.locator(".save-status")).toContainText("bukan pilihan tersimpan");
    await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Reset pilihan", exact: true }).click();
    await expect(page.locator(".save-status")).toContainText("Pilihan online direset");
    expect(mock.posts).toEqual([{ guildId: guildA, backgroundId: null }]);
    await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeEnabled();
  });
}

test("library 503 permits an explicitly selected solid replacement, not the fallback sample", async ({ page }) => {
  const mock = await setup(page, { preference: id, fail: true });
  await expect(page.locator(".save-status")).toContainText("bukan pilihan tersimpan");
  expect(mock.posts).toEqual([]);
  await page.getByRole("button", { name: /Plum/ }).click();
  await page.getByRole("button", { name: "Simpan online", exact: true }).click();
  await expect(page.locator(".save-status")).toContainText("Pilihan disimpan");
  expect(mock.posts).toEqual([{ guildId: guildA, backgroundId: "sample-plum" }]);
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
});

test("library-only retry restores the unresolved preference without another preferences GET", async ({ page }) => {
  let reads = 0;
  page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname === "/api/preferences") reads += 1; });
  const mock = await setup(page, { preference: id, occupied: true, fail: true });
  await expect(page.locator(".save-status")).toContainText("bukan pilihan tersimpan");
  const initialReads = reads;
  mock.recover();
  await page.getByRole("button", { name: "Coba lagi library" }).click();
  await expect(page.getByRole("button", { name: "Dipilih slot 1" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".save-status")).toContainText("Pilihan pribadi dimuat");
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
  expect(reads).toBe(initialReads);
  expect(mock.posts).toEqual([]);
});

for (const status of [401, 403, 503]) {
  test(`failed preferences GET ${status} keeps reset and selection locked`, async ({ page }) => {
    const mock = await setup(page, { preferenceStatus: status, occupied: true });
    await expect(page.getByRole("button", { name: "Muat ulang preferensi" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset pilihan", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Plum/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Pilih slot 1", exact: true })).toBeDisabled();
    expect(mock.posts).toEqual([]);
  });
}

test("arbitrary unknown preference stays locked and never claims saved", async ({ page }) => {
  const mock = await setup(page, { preference: "unknown-background", occupied: true });
  await expect(page.locator(".save-status")).toContainText("tidak dikenal atau tidak valid");
  await expect(page.locator(".save-status")).not.toContainText("Pilihan disimpan");
  await expect(page.getByRole("button", { name: "Reset pilihan", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Plum/ })).toBeDisabled();
  expect(mock.posts).toEqual([]);
});

test("initial null preference preserves saving the selected default sample", async ({ page }) => {
  const mock = await setup(page);
  await expect(page.locator(".save-status")).toContainText("Belum ada pilihan online");
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /Plum/ }).click();
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeEnabled();
  expect(mock.posts).toEqual([]);
});

test("late recovery library response cannot restore another guild or logged-out account", async ({ page }) => {
  await setup(page, { preference: id, fail: true });
  await expect(page.locator(".save-status")).toContainText("bukan pilihan tersimpan");
  let finish: (() => Promise<void>) | undefined;
  await page.route("**/api/backgrounds?*", (route) => {
    finish = () => route.fulfill({ json: { status: "ready", guildId: guildA, level: 20, slots: [20, 45, 65].map((requiredLevel, index) => ({ slot: index + 1, requiredLevel, unlocked: index === 0, background: index === 0 ? background : null })) } }).catch(() => {});
  });
  await page.getByRole("button", { name: "Coba lagi library" }).click();
  await expect.poll(() => !!finish).toBe(true);
  const finishA = finish!;
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildB);
  await expect(page.locator(".save-status")).toContainText("Memuat library");
  await finishA();
  await expect(page.getByAltText("Perkiraan background pribadi: Background pribadi 1")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
  await expect.poll(() => finish !== finishA).toBe(true);
  const finishB = finish!;
  await page.getByRole("button", { name: "Logout Discord" }).click();
  await finishB();
  await expect(page.getByRole("heading", { name: "Library pribadi" })).toHaveCount(0);
  await expect(page.getByAltText("Perkiraan background pribadi: Background pribadi 1")).toHaveCount(0);
});

test("media failure is honest and unknown preference never claims saved", async ({ page }) => {
  await setup(page, { occupied: true, preference: id });
  await page.route("**/api/backgrounds/*/media?*", (route) => route.fulfill({ status: 403, json: { error: "slot_locked" } }));
  await page.reload();
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildA);
  await expect(page.locator(".media-fallback")).toContainText("bukan gambar tersimpan");
  await page.getByLabel("Server keanggotaan kamu").selectOption(guildB);
  await expect(page.locator(".save-status")).toContainText("tidak dikenal atau tidak valid");
  await expect(page.getByRole("button", { name: "Simpan online", exact: true })).toBeDisabled();
});
