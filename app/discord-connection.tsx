"use client";

import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { BackgroundModeration } from "../components/background-moderation";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import type { Guild, Identity } from "../lib/auth";
import { responseRetrySeconds } from "../components/background-library";

type View = { status: "loading" | "setup_required" | "signed_out" } | { status: "error"; message?: string; retryAt?: number } | { status: "authenticated"; user: Identity; guilds: Guild[] };
const failures: Record<string, string> = {
  state: "Permintaan login tidak valid atau kedaluwarsa. Mulai login lagi.",
  denied: "Izin Discord dibatalkan. Kamu tetap bisa memakai demo lokal.",
  callback: "Respons login tidak valid. Mulai login lagi.",
  upstream: "Login belum berhasil karena Discord tidak dapat diproses. Coba lagi nanti.",
  rate_limited: "Terlalu banyak permintaan login. Tunggu satu menit.",
  setup: "Login belum dikonfigurasi pada server.",
};

export function DiscordConnection({
  onContextChange,
}: {
  onContextChange: (context: { userId: string | null | undefined; guildId: string | null; canModerate?: boolean }) => void;
}) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState("");
  const [selected, setSelected] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [retryReady, setRetryReady] = useState(true);
  const retryAt = view.status === "error" ? view.retryAt : undefined;

  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setTimeout(() => setRetryReady(true), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const userId = view.status === "authenticated" ? view.user.id : view.status === "signed_out" || view.status === "setup_required" ? null : undefined;

  const canModerate = view.status === "authenticated" && view.guilds.some((guild) => guild.id === selected && guild.canModerate);

  useEffect(() => {
    onContextChange({ userId, guildId: userId && selected ? selected : null, canModerate });
  }, [userId, selected, canModerate, onContextChange]);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("auth_error");
    if (code) {
      queueMicrotask(() => setFailure(failures[code] ?? "Login belum berhasil. Mulai login lagi."));
      window.history.replaceState(null, "", "/#discord");
    }
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    async function load() {
      setView({ status: "loading" });
      setSelected("");
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!active) return;
        if (response.status === 503 && data.status === "setup_required") setView({ status: "setup_required" });
        else if (response.status === 401) setView({ status: "signed_out" });
        else if (response.ok && data.status === "authenticated" && data.user && Array.isArray(data.guilds)) setView(data);
        else {
          const discordLimited = data.error === "discord_unavailable" && data.reason === "rate_limited";
          const limited = response.status === 429 || discordLimited;
          const seconds = limited ? responseRetrySeconds(response) ?? (discordLimited ? 5 : 60) : null;
          setRetryReady(!seconds);
          setView({ status: "error", message: discordLimited ? "Discord membatasi verifikasi sesi." : response.status === 429 ? "Terlalu banyak permintaan sesi dashboard." : data.error === "discord_unavailable" ? "Verifikasi sesi Discord belum tersedia. Coba lagi nanti." : undefined, ...(seconds ? { retryAt: Date.now() + seconds * 1000 } : {}) });
        }
      } catch { if (active) setView({ status: "error" }); }
      finally { window.clearTimeout(timeout); }
    }
    void load();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);

  async function logout() {
    setLoggingOut(true);
    setFailure("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("logout");
      setSelected("");
      setView({ status: "signed_out" });
    } catch { setFailure("Logout gagal. Coba lagi sebelum meninggalkan perangkat ini."); }
    finally { setLoggingOut(false); }
  }

  return (
    <section id="discord" className="connection" aria-labelledby="connection-title" aria-busy={view.status === "loading"}>
      <div>
        <h2 id="connection-title">Akun dan server Discord</h2>
        <p>Login hanya membaca identitas dan keanggotaan server. Pilihan server dipakai untuk menyimpan background per server.</p>
        <p>Daftar ini menunjukkan keanggotaan, bukan jaminan bot tersedia. Backend memeriksa registry bot saat preferensi diakses. Operator perlu mendaftarkan server yang belum terdaftar. Perubahan Supabase/cloud berlaku pada fetch bot berikutnya yang berhasil; integrasi nyata belum diuji.</p>
        <p>Sesi maksimal 8 jam atau sampai token kedaluwarsa. Logout menghapus sesi browser ini; otorisasi aplikasi dapat dicabut lewat pengaturan Discord.</p>
      </div>
      <div className="auth-panel">
        {failure && <p role="alert">{failure}</p>}
        {view.status === "loading" && <p role="status">Memuat sesi dan server Discord…</p>}
        {view.status === "setup_required" && <><p role="status">Login belum dikonfigurasi.</p><p>Isi <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>, <code>APP_URL</code>, dan <code>SESSION_PASSWORD</code> (acak, minimal 32 karakter) pada environment server lalu mulai ulang aplikasi. Untuk lokal, gunakan <code>http://localhost:3000</code> sebagai APP_URL.</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Periksa konfigurasi</Button></>}
        {view.status === "signed_out" && <><p>Belum login atau sesi sudah berakhir.</p><form action="/api/auth/discord" method="get"><Button variant="outline" type="submit">Login dengan Discord</Button></form></>}
        {view.status === "error" && <><p role="alert">{view.message ?? "Sesi atau daftar server gagal dimuat. Tunggu sebentar lalu coba lagi."}{view.retryAt && !retryReady ? ` Tunggu sampai ${new Date(view.retryAt).toLocaleTimeString()} sebelum mencoba lagi. Tidak ada retry otomatis.` : ""}</p><Button variant="outline" disabled={!!view.retryAt && !retryReady} onClick={() => { if (view.retryAt && Date.now() < view.retryAt) return; setAttempt((value) => value + 1); }}>Muat ulang Discord</Button><Button variant="outline" disabled={loggingOut} onClick={logout}>{loggingOut ? "Keluar…" : "Logout Discord"}</Button></>}
        {view.status === "authenticated" && <>
          <p>Login sebagai <strong>{view.user.name}</strong> (@{view.user.username}).</p>
          <Button variant="outline" disabled={loggingOut} onClick={logout}>{loggingOut ? "Keluar…" : "Logout Discord"}</Button>
          {view.guilds.length === 0 ? <p role="status">Tidak ada server dalam keanggotaan akun ini. Gabung server di Discord lalu muat ulang.</p> : <><div className="guild-field"><label className="field-label" htmlFor="guild">Server keanggotaan kamu</label><NativeSelect id="guild" value={selected} onChange={(event) => setSelected(event.target.value)}><NativeSelectOption value="">Pilih server untuk dilihat</NativeSelectOption>{view.guilds.map((guild) => <NativeSelectOption key={guild.id} value={guild.id}>{guild.name}</NativeSelectOption>)}</NativeSelect></div>{selected && <p role="status">Pilihan background akan disimpan terpisah untuk server ini. Akses preferensi tetap memerlukan verifikasi registry bot oleh backend.</p>}</>}
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Muat ulang server</Button>
          {selected && view.guilds.some((guild) => guild.id === selected && guild.canModerate) && <BackgroundModeration key={`${view.user.id}:${selected}:${attempt}`} guildId={selected} />}
        </>}
      </div>
    </section>
  );
}
