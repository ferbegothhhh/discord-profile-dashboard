import { expect, test } from "@playwright/test";

test("legal pages accessibility, navigation and Indonesian prose", async ({ page }) => {
  const checkPage = async (path: string, title: string) => {
    await page.goto(path);
    await expect(page).toHaveTitle(`${title} | Universality`);
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Kembali ke editor" })).toBeVisible();

    // Antislop: No em-dashes
    const text = await page.content();
    expect(text).not.toContain("—");

    // Bahasa Indonesia check
    await expect(page.getByText("Ketentuan", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Kebijakan", { exact: false }).first()).toBeVisible();

    // Accessibility: skip link
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Lewati ke dokumen" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#dokumen")).toBeFocused();

    // Check footer links presence and safety
    const links = page.locator(".legal-links a");
    await expect(links.filter({ hasText: "Ketentuan Layanan" })).toHaveAttribute("href", "/terms");
    await expect(links.filter({ hasText: "Kebijakan Privasi" })).toHaveAttribute("href", "/privacy");
    const support = links.filter({ hasText: "Dukungan Discord" });
    await expect(support).toHaveAttribute("href", "https://discord.gg/ruv");
    await expect(support).toHaveAttribute("target", "_blank");
    await expect(support).toHaveAttribute("rel", /noopener/);
  };

  await checkPage("/terms", "Ketentuan Layanan");
  await checkPage("/privacy", "Kebijakan Privasi");

  // Navigation from home
  await page.goto("/");
  await page.getByRole("link", { name: "Ketentuan Layanan" }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.getByRole("link", { name: "Kebijakan Privasi" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
});

test("responsive legal pages", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  for (const path of ["/terms", "/privacy"]) {
    await page.goto(path);
    const main = page.locator(".legal-main");
    const box = await main.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("legal pages describe approved upload, retention and reporting policies", async ({ page }) => {
  for (const path of ["/terms", "/privacy"]) {
    await page.goto(path);
    const prose = page.locator(".legal-prose");
    const text = await prose.innerText();
    for (const expected of [
      "JPG, PNG, atau WebP statis",
      "3 MiB (3.145.728 byte)",
      "PNG 1000×560 piksel",
      "crop tengah (centered cover)",
      "level terbaru",
      "level 0–19 mendapat 0 slot",
      "level 20–44 mendapat 1 slot",
      "level 45–64 mendapat 2 slot",
      "level 65 ke atas mendapat maksimal 3 slot",
      "slot berlebih dikunci",
      "slot terkunci sedang aktif, kartu kembali memakai background bawaan",
      "tidak otomatis",
      "katalog publik",
      "tetap disimpan sampai",
      "upload gagal atau orphan",
      "antrean cleanup",
      "bertahap",
      "seluruh byte",
      "backup",
      "tidak menarik kembali kartu yang sudah diposting",
      "terlihat oleh pengguna yang dapat mengakses kanal tersebut",
      "ilegal, seksual eksplisit, kebencian",
      "hak cipta",
      "tautan pesan /profile",
      "alasan laporan",
      "harus menjadi anggota server dukungan",
      "peninjauan manual oleh administrator",
      "penonaktifan atau penghapusan gambar",
      "pemilik server atau pemegang izin Discord Administrator",
      "bukan Manage Server saja atau daftar ID global",
      "aktivasi hosted masih menunggu migrasi database dan uji admin nyata",
      "Penonaktifan mengembalikan preferensi ke default tanpa menghapus file",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("Dashboard saat ini menyediakan editor demo dengan draft lokal");
    expect(text).not.toContain("—");
    const report = page.getByRole("link", { name: "kanal #laporan" });
    await expect(report).toHaveAttribute("href", "https://discord.com/channels/873228006078939196/1541242307620376616");
    await expect(report).toHaveAttribute("target", "_blank");
    await expect(report).toHaveAttribute("rel", "noopener noreferrer");
    await report.focus();
    await expect(report).toBeFocused();
    await page.getByRole("link", { name: "Kembali ke editor" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

test("privacy distinguishes backend storage, browser drafts and deletion requests", async ({ page }) => {
  await page.goto("/privacy");
  const text = await page.locator(".legal-prose").innerText();
  for (const expected of [
    "ID pengguna dari sesi Discord, keanggotaan server, dan level terbaru dari bot",
    "Preferensi background disimpan per ID pengguna dan ID server",
    "kepemilikan, slot, status pemrosesan, revisi, metadata gambar",
    "bucket privat Supabase Storage",
    "backend yang memeriksa izin",
    "bukan token OAuth atau gambar pribadi",
    "Logout mengakhiri sesi browser, bukan menghapus preferensi, gambar tersimpan",
    "bukan di localStorage",
    "bukan pernyataan bahwa database bot terenkripsi saat disimpan",
    "Untuk mengajukan penghapusan data",
    "tidak ada jaminan seluruh data di semua pihak terhapus seketika atau dalam tenggat tertentu",
    "Laporan yang kamu kirim dapat terlihat oleh anggota",
  ]) {
    expect(text).toContain(expected);
  }
});
