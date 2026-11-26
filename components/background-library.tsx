"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";

export type PrivateBackground = { id: string; name: string; status: "processing" | "ready" | "failed"; revision: number; isActive: boolean };
type Slot = { slot: number; requiredLevel: number; unlocked: boolean; background: PrivateBackground | null };
type Library = { status: "ready"; guildId: string; level: number; slots: Slot[] };

function validLibrary(value: unknown, guildId: string): value is Library {
  if (!value || typeof value !== "object") return false;
  const data = value as Library;
  const ids = new Set<string>();
  return data.status === "ready" && data.guildId === guildId && Number.isSafeInteger(data.level) && data.level >= 0 && Array.isArray(data.slots) && data.slots.length === 3 && data.slots.every((slot, index) => {
    if (!slot || slot.slot !== index + 1 || slot.requiredLevel !== [20, 45, 65][index] || typeof slot.unlocked !== "boolean" || slot.unlocked !== (data.level >= slot.requiredLevel)) return false;
    const item = slot.background;
    if (item === null) return true;
    if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || /[\u0000-\u001f\u007f]/.test(item.name) || !["ready", "processing", "failed"].includes(item.status) || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.isActive !== "boolean") return false;
    ids.add(item.id);
    return true;
  });
}

export function responseRetrySeconds(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  const value = raw && raw.length <= 128 && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.min(86400, Math.max(1, Math.ceil(value))) : null;
}

export async function discordResponseError(response: Response): Promise<string | null> {
  const data = await response.clone().json().catch(() => null);
  if (data?.error !== "discord_unavailable") return null;
  const seconds = responseRetrySeconds(response);
  return `${data.reason === "rate_limited" ? "Discord membatasi verifikasi akses." : "Verifikasi Discord belum tersedia."}${seconds ? ` Tunggu ${seconds} detik sebelum mencoba lagi.` : " Coba lagi nanti."} Draft tidak diubah; muat ulang untuk memeriksa akses terbaru.`;
}

function libraryError(status: number, code?: string) {
  if (code === "slot_occupied") return "Slot sudah terisi. Muat ulang library dan hapus gambar lama terlebih dahulu.";
  if (code === "slot_processing") return "Slot masih diproses. Tunggu lalu muat ulang library.";
  if (code === "slot_locked") return "Slot terkunci karena level terbaru. Muat ulang library.";
  if (status === 401) return "Sesi berakhir. Login ulang untuk membuka library.";
  if (status === 403) return "Akses ditolak. Periksa keanggotaan server dan level terbaru.";
  if (status === 413) return "Ukuran gambar maksimal 3 MiB (3.145.728 byte).";
  if (status === 415) return "Gunakan gambar PNG, JPG, atau WebP statis.";
  if (status === 400) return "Gambar atau permintaan tidak valid. Gunakan PNG, JPG, atau WebP statis yang tidak rusak.";
  if (status === 429) return "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.";
  if (status === 503) return "Layanan library belum tersedia. Coba lagi nanti atau hubungi operator.";
  return "Library gagal diakses. Periksa koneksi lalu coba lagi.";
}

export function privateMedia(item: PrivateBackground, guildId: string) {
  return `/api/backgrounds/${encodeURIComponent(item.id)}/media?guildId=${encodeURIComponent(guildId)}&revision=${item.revision}`;
}

export function useBackgroundLibrary(guildId: string | null, enabled: boolean) {
  const [data, setData] = useState<Library | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!enabled || !guildId) return;
    const controller = new AbortController();
    let active = true;
    async function load() {
      setState("loading");
      setData(null);
      try {
        const response = await fetch(`/api/backgrounds?guildId=${encodeURIComponent(guildId!)}`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) throw new Error(await discordResponseError(response) ?? libraryError(response.status));
        const result: unknown = await response.json();
        if (!validLibrary(result, guildId!)) throw new Error("Respons library tidak valid. Coba muat ulang.");
        if (active) { setData(result); setState("ready"); }
      } catch (error) {
        if (active) { setError(error instanceof Error ? error.message : libraryError(0)); setState("error"); }
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [guildId, enabled, attempt]);
  return { data, state, error, refresh };
}

export function BackgroundLibrary({ guildId, library, selectedId, disabled, canSelect, onSelect, onDelete, onBusy }: {
  guildId: string; library: ReturnType<typeof useBackgroundLibrary>; selectedId: string; disabled: boolean; canSelect: boolean;
  onSelect: (id: string) => void; onDelete: (id: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const pending = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function mutate(slot: Slot, file?: File) {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || pending.current || disabled) return;
    if (file && (!slot.unlocked || slot.background)) return;
    if (file && (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 3 * 1024 * 1024)) {
      setMessage(file.size > 3 * 1024 * 1024 ? libraryError(413) : libraryError(415));
      return;
    }
    pending.current = true;
    setBusy(slot.slot);
    onBusy(true);
    setMessage(file ? "Mengunggah dan memproses gambar…" : "Menghapus gambar…");
    try {
      const response = await fetch(`/api/backgrounds/slots/${slot.slot}?guildId=${encodeURIComponent(guildId)}`, {
        method: file ? "PUT" : "DELETE", cache: "no-store", credentials: "same-origin",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
        ...(file ? { headers: { "Content-Type": file.type }, body: file } : {}),
      });
      const discordError = !response.ok ? await discordResponseError(response) : null;
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(discordError ?? libraryError(response.status, result?.error));
      if (!result || result.guildId !== guildId || result.slot !== slot.slot || result.status !== (file ? "ready" : "deleted")) throw new Error("Respons perubahan library tidak valid. Muat ulang untuk memeriksa hasilnya.");
      if (controller.signal.aborted) return;
      if (!file && slot.background) onDelete(slot.background.id);
      setConfirm(null);
      setMessage(file ? "Upload berhasil. Belum disimpan sebagai pilihan server. Pilih gambar lalu Simpan online." : result.cleanupPending ? "Gambar dihapus dari library. Pembersihan file masih menunggu server." : "Gambar dihapus. Jika sebelumnya dipakai, preferensi server kembali ke bawaan.");
      library.refresh();
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : libraryError(0));
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) { setBusy(null); onBusy(false); }
    }
  }

  return <section id="library" className="private-library" aria-labelledby="library-title" aria-busy={library.state === "loading" || busy !== null}>
    <div className="section-heading"><h2 id="library-title">Library pribadi</h2>{library.data && <span className="muted">Level {library.data.level}</span>}</div>
    <p className="muted">Khusus akun dan server ini. PNG, JPG, WebP statis, maksimal 3 MiB. Hasil dipotong tengah ke 1000 × 560. Hapus gambar lama sebelum upload pengganti.</p>
    {library.state === "loading" && <p role="status">Memuat library pribadi…</p>}
    {library.state === "error" && <div role="alert"><p>{library.error}</p><Button variant="outline" onClick={library.refresh}>Coba lagi library</Button></div>}
    {library.state === "ready" && library.data && <>
      {!library.data.slots.some((slot) => slot.background) && <p className="muted">Belum ada gambar pribadi di server ini.</p>}
      <div className="library-slots">{library.data.slots.map((slot) => {
        const item = slot.background;
        const usable = slot.unlocked && item?.status === "ready" && item.isActive;
        return <article className="library-slot" key={slot.slot} aria-labelledby={`slot-${slot.slot}`}>
          <h3 id={`slot-${slot.slot}`}>Slot {slot.slot} <small>· Level {slot.requiredLevel}</small></h3>
          <p className="muted">{!slot.unlocked ? "Terkunci. Gambar tetap disimpan, tetapi tidak dapat dipilih atau dipreview." : !item ? "Kosong, siap untuk upload." : item.status === "processing" ? "Gambar sedang diproses." : item.status === "failed" ? "Pemrosesan gagal. Hapus sebelum mencoba upload lagi." : !item.isActive ? "Gambar tidak aktif." : "Siap dipilih."}</p>
          {item && <p>{item.name}</p>}
          <div className="library-actions">
            {usable && <Button variant="outline" aria-pressed={selectedId === item.id} disabled={!canSelect || disabled || busy !== null} onClick={() => onSelect(item.id)}>{selectedId === item.id ? `Dipilih slot ${slot.slot}` : `Pilih slot ${slot.slot}`}</Button>}
            {!item && slot.unlocked && <label className="upload-field">Upload slot {slot.slot}<input aria-label={`Upload slot ${slot.slot}`} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy !== null} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void mutate(slot, file); }} /></label>}
            {item && <Button variant="outline" disabled={disabled || busy !== null} onClick={() => setConfirm(slot.slot)}>Hapus slot {slot.slot}</Button>}
          </div>
          {confirm === slot.slot && <div className="delete-confirm" onKeyDown={(event) => { if (event.key === "Escape") setConfirm(null); }}><p>Hapus gambar slot {slot.slot}? Pilihan server yang memakai gambar ini akan direset.</p><div className="library-actions"><Button disabled={disabled || busy !== null} onClick={() => void mutate(slot)}>Ya, hapus slot {slot.slot}</Button><Button variant="outline" disabled={busy !== null} onClick={() => setConfirm(null)}>Batal hapus</Button></div></div>}
        </article>;
      })}</div>
      <Button variant="outline" disabled={busy !== null} onClick={library.refresh}>Muat ulang library</Button>
    </>}
    <p className="library-status" role="status">{message}</p>
  </section>;
}
