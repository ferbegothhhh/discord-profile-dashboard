"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "./ui/button";

type Item = { id: string; ownerUserId: string; slot: number; active: boolean };

export function BackgroundModeration({ guildId }: { guildId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [after, setAfter] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [review, setReview] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setItems([]);
      setReview(null);
      setMessage("");
      try {
        const response = await fetch(`/api/moderation/backgrounds?guildId=${guildId}${after ? `&after=${after}` : ""}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok || data.guildId !== guildId || !Array.isArray(data.items)) throw new Error();
        if (active) { setItems(data.items); setNext(data.next); }
      } catch { if (active) setMessage("Daftar moderasi gagal dimuat. Izin mungkin berubah atau layanan belum tersedia. Coba muat ulang."); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [guildId, after, attempt]);

  useEffect(() => {
    let active = true;
    let url = "";
    const controller = new AbortController();
    queueMicrotask(() => { if (active) { setPreview(""); setPreviewError(""); } });
    if (review) void (async () => {
      try {
        const response = await fetch(`/api/moderation/backgrounds/${review}?guildId=${guildId}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok || response.headers.get("content-type") !== "image/png") throw new Error();
        const blob = await response.blob();
        if (active) { url = URL.createObjectURL(blob); setPreview(url); }
      } catch { if (active) setPreviewError("Preview gagal dimuat. Muat ulang daftar untuk memeriksa izin."); }
    })();
    return () => { active = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [guildId, review]);

  async function disable(item: Item) {
    if (!window.confirm(`Nonaktifkan background slot ${item.slot} milik ${item.ownerUserId}? Pilihan yang memakai gambar ini akan kembali ke default. Pemilik tetap dapat menghapus slotnya.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/moderation/backgrounds/${item.id}?guildId=${guildId}`, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || data.guildId !== guildId || data.id !== item.id || data.status !== "disabled") throw new Error();
      setItems((rows) => rows.map((row) => row.id === item.id ? { ...row, active: false } : row));
      setReview(null);
      setMessage("Background dinonaktifkan. Preferensi terkait kembali ke default.");
    } catch { setMessage("Penonaktifan belum dapat dipastikan. Muat ulang daftar sebelum mencoba lagi."); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="moderation-title" aria-busy={loading || busy}>
    <h3 id="moderation-title">Moderasi background server</h3>
    <p>Hanya pemilik server atau Administrator Discord. Periksa gambar pribadi di server ini sebelum menonaktifkan. Gambar nonaktif tidak dapat dipakai; penghapusan slot tetap melalui pemilik dan cleanup terjadwal.</p>
    {message && <p role="status">{message}</p>}
    <Button variant="outline" disabled={loading || busy} onClick={() => setAttempt((value) => value + 1)}>Muat ulang moderasi</Button>
    {loading ? <p role="status">Memuat background server…</p> : !message && items.length === 0 ? <p>Belum ada background siap ditinjau pada halaman ini.</p> : null}
    <ul>{items.map((item) => <li key={item.id}>
      <p>Pemilik {item.ownerUserId}, slot {item.slot}: {item.active ? "Aktif" : "Nonaktif"}</p>
      <Button variant="outline" disabled={busy} onClick={() => { setPreview(""); setPreviewError(""); setReview(review === item.id ? null : item.id); }}>{review === item.id ? "Tutup preview" : "Tinjau gambar"}</Button>
      {review === item.id && <div>
        {previewError ? <p role="alert">{previewError}</p> : preview ? <Image unoptimized width={1000} height={560} src={preview} alt={`Background pribadi slot ${item.slot} untuk ditinjau`} style={{ maxWidth: "100%", height: "auto" }} /> : <p role="status">Memuat preview pribadi…</p>}
        {item.active && <Button variant="outline" disabled={busy || !preview} onClick={() => void disable(item)}>{busy ? "Menonaktifkan…" : "Nonaktifkan gambar"}</Button>}
      </div>}
    </li>)}</ul>
    {after && <Button variant="outline" disabled={loading || busy} onClick={() => setAfter("")}>Halaman pertama</Button>}
    {next && <Button variant="outline" disabled={loading || busy} onClick={() => setAfter(next)}>Halaman berikutnya</Button>}
  </section>;
}
