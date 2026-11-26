import { expect, test } from "@playwright/test";

test("security headers protect documents without blocking hydration", async ({ page, request }) => {
  for (const path of ["/", "/privacy", "/terms"]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const headers = response.headers();
    const policy = headers["content-security-policy"].split(";").map((directive) => directive.trim());
    expect(policy).toEqual(expect.arrayContaining(["base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self' https://discord.com", "script-src-attr 'none'"]));
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    expect(headers["x-powered-by"]).toBeUndefined();
  }
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { securityViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Periksa konfigurasi" })).toBeVisible();
  await page.getByRole("button", { name: "Periksa konfigurasi" }).click();
  await expect(page.getByText("Login belum dikonfigurasi.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "securityViolations"))).toEqual([]);
});

test("unavailable setup is honest, retry works and demo remains local", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText("Login belum dikonfigurasi.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Login dengan Discord" })).toHaveCount(0);
  await page.getByRole("button", { name: "Periksa konfigurasi" }).click();
  await expect(page.getByText("Login belum dikonfigurasi.", { exact: true })).toBeVisible();
  await expect(page.getByText("Perubahan Supabase/cloud berlaku", { exact: false })).toBeVisible();
  const login = await request.get("/api/auth/discord");
  expect(login.status()).toBe(503);
  expect((await login.json()).status).toBe("setup_required");
  const logout = await request.get("/api/auth/logout");
  expect(logout.status()).toBe(405);
});

test("mock UI loading, signed out, login navigation and sanitized callback error", async ({ page }) => {
  await page.route("**/api/auth/session", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ status: 401, json: { status: "signed_out" } });
  });
  await page.goto("/?auth_error=untrusted-secret");
  await expect(page.getByText("Memuat sesi dan server Discord…")).toBeVisible();
  await expect(page.getByText("Login belum berhasil. Mulai login lagi.", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/#discord$/);
  await page.route("**/api/auth/discord*", (route) => route.fulfill({ contentType: "text/plain", body: "Mock authorization navigation" }));
  await page.getByRole("button", { name: "Login dengan Discord" }).click();
  await expect(page).toHaveURL(/\/api\/auth\/discord\??$/);
  await expect(page.getByText("Mock authorization navigation")).toBeVisible();
});

test("mock guild choice, empty, error, reload and POST logout click-through", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let state = "guilds";
  await page.route("**/api/auth/session", (route) => route.fulfill(state === "error" ? { status: 502, json: { error: "discord_unavailable" } } : { json: { status: "authenticated", user: { id: "123456789012345678", username: "mock-account", name: "Mock identity" }, guilds: state === "empty" ? [] : [{ id: "234567890123456789", name: "Mock server" }] } }));
  await page.route("**/api/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: { status: "signed_out" } });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await expect(page.getByText("Mock identity", { exact: true })).toBeVisible();
  await page.getByLabel("Server keanggotaan kamu").selectOption("234567890123456789");
  await expect(page.getByText("Pilihan background akan disimpan terpisah untuk server ini", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  state = "empty";
  await page.getByRole("button", { name: "Muat ulang server" }).click();
  await expect(page.getByText("Tidak ada server dalam keanggotaan", { exact: false })).toBeVisible();
  state = "error";
  await page.getByRole("button", { name: "Muat ulang server" }).click();
  await expect(page.getByText("Verifikasi sesi Discord belum tersedia.", { exact: false })).toBeVisible();
  state = "guilds";
  await page.getByRole("button", { name: "Muat ulang Discord" }).click();
  await expect(page.getByLabel("Server keanggotaan kamu")).toHaveValue("");
  await page.getByRole("button", { name: "Logout Discord" }).click();
  await expect(page.getByRole("button", { name: "Login dengan Discord" })).toBeVisible();
  expect(errors).toEqual([]);
});
