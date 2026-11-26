import { expect, test } from "./fixtures";

const guild = "223456789012345678";
const other = "323456789012345678";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=", "base64");

test("moderation review, cancel, disable, pagination and denied retry on mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let active = true;
  let denied = false;
  let writes = 0;
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { status: "authenticated", user: { id: "123456789012345678", username: "mock", name: "Mock" }, guilds: [{ id: guild, name: "Server A", canModerate: true }, { id: other, name: "Server B", canModerate: true }] } }));
  await page.route("**/api/moderation/backgrounds**", async (route) => {
    const url = new URL(route.request().url());
    const g = url.searchParams.get("guildId");
    if (denied) return route.fulfill({ status: 403, json: { error: "guild_forbidden" } });
    if (url.pathname.endsWith(id)) {
      if (route.request().method() === "POST") {
        writes++;
        active = false;
        return route.fulfill({ json: { status: "disabled", guildId: g, id } });
      }
      return route.fulfill({ contentType: "image/png", body: png });
    }
    return route.fulfill({ json: { guildId: g, items: g === guild && !url.searchParams.has("after") ? [{ id, ownerUserId: other, slot: 1, active }] : [], next: g === guild && !url.searchParams.has("after") ? id : null } });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption(guild);
  await expect(page.getByRole("heading", { name: "Moderasi background server" })).toBeVisible();
  await page.getByRole("button", { name: "Tinjau gambar" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("img", { name: "Background pribadi slot 1 untuk ditinjau" })).toBeVisible();
  await page.getByRole("button", { name: "Tutup preview" }).click();
  await expect(page.getByRole("img", { name: "Background pribadi slot 1 untuk ditinjau" })).toHaveCount(0);
  await page.getByRole("button", { name: "Tinjau gambar" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Nonaktifkan gambar", exact: true }).click();
  expect(writes).toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Nonaktifkan gambar", exact: true }).click();
  await expect(page.getByText("Background dinonaktifkan. Preferensi terkait kembali ke default.", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "Halaman berikutnya" }).click();
  await expect(page.getByText("Belum ada background siap ditinjau pada halaman ini.")).toBeVisible();
  await page.getByRole("button", { name: "Halaman pertama" }).click();
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: other, exact: true }) });
  await expect(row.getByRole("cell", { name: "Slot 1", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "Nonaktif", exact: true })).toBeVisible();
  denied = true;
  await page.getByRole("button", { name: "Muat ulang moderasi" }).click();
  await expect(page.getByText("Daftar moderasi gagal dimuat.", { exact: false })).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: "Muat ulang moderasi" }).click();
  await expect(page.getByRole("button", { name: "Tinjau gambar" })).toBeVisible();
  await page.getByLabel("Server keanggotaan kamu").selectOption(other);
  await expect(page.getByText("Belum ada background siap ditinjau pada halaman ini.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tinjau gambar" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("late guild list cannot populate another guild and non-admin has no panel", async ({ page }) => {
  let moderator = true;
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { status: "authenticated", user: { id: "123456789012345678", username: "mock", name: "Mock" }, guilds: [{ id: guild, name: "Server A", canModerate: moderator }, { id: other, name: "Server B", canModerate: moderator }] } }));
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/moderation/backgrounds?**", async (route) => {
    const g = new URL(route.request().url()).searchParams.get("guildId");
    if (g === guild) { started(); await new Promise((resolve) => setTimeout(resolve, 700)); }
    await route.fulfill({ json: { guildId: g, items: g === guild ? [{ id, ownerUserId: other, slot: 1, active: true }] : [], next: null } });
  });
  await page.goto("/");
  await page.getByLabel("Server keanggotaan kamu").selectOption(guild);
  await start;
  await page.getByLabel("Server keanggotaan kamu").selectOption(other);
  await page.waitForTimeout(900);
  await expect(page.getByText("Belum ada background siap ditinjau pada halaman ini.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Tinjau gambar" })).toHaveCount(0);
  moderator = false;
  await page.getByRole("button", { name: "Muat ulang server" }).click();
  await page.getByLabel("Server keanggotaan kamu").selectOption(guild);
  await expect(page.getByRole("heading", { name: "Moderasi background server" })).toHaveCount(0);
});
