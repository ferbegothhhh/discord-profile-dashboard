"use client";

import { useEffect, useState, useMemo } from "react";
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
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

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

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchQuery = searchQuery.trim() === "" || item.ownerUserId.toLowerCase().includes(searchQuery.trim().toLowerCase()) || item.slot.toString() === searchQuery.trim();
      const matchStatus = statusFilter === "all" || (statusFilter === "active" && item.active) || (statusFilter === "inactive" && !item.active);
      return matchQuery && matchStatus;
    });
  }, [items, searchQuery, statusFilter]);

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

  return <section id="moderation" className="moderation-panel" aria-labelledby="moderation-title" aria-busy={loading || busy}>
    <h3 id="moderation-title">Moderasi background server</h3>
    <p>Hanya pemilik server atau Administrator Discord. Periksa gambar pribadi di server ini sebelum menonaktifkan. Gambar nonaktif tidak dapat dipakai; penghapusan slot tetap melalui pemilik dan cleanup terjadwal.</p>
    {message && <p role="status">{message}</p>}

    <div className="moderation-toolbar">
      <Button variant="outline" disabled={loading || busy} onClick={() => setAttempt((value) => value + 1)}>Muat ulang moderasi</Button>
      <div className="moderation-filters">
        <input
          type="search"
          placeholder="Cari User ID / Slot..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="moderation-search-input"
          aria-label="Cari User ID atau Slot"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as "all" | "active" | "inactive")}
          className="moderation-status-select"
          aria-label="Filter status background"
        >
          <option value="all">Semua Status</option>
          <option value="active">Aktif</option>
          <option value="inactive">Nonaktif</option>
        </select>
      </div>
    </div>

    {loading ? <p role="status">Memuat background server…</p> : !message && items.length === 0 ? <p>Belum ada background siap ditinjau pada halaman ini.</p> : null}

    {!loading && items.length > 0 && (
      <div className="moderation-table-wrapper">
        <table className="moderation-table">
          <thead>
            <tr>
              <th>Pemilik (User ID)</th>
              <th>Slot</th>
              <th>Status</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td colSpan={4} className="moderation-empty">Tidak ada background yang cocok dengan pencarian atau filter.</td>
              </tr>
            ) : (
              filteredItems.map((item) => (
                <tr key={item.id} className={review === item.id ? "moderation-row-expanded" : ""}>
                  <td><code>{item.ownerUserId}</code></td>
                  <td>Slot {item.slot}</td>
                  <td>
                    <span className={`moderation-badge ${item.active ? "badge-active" : "badge-inactive"}`}>
                      {item.active ? "Aktif" : "Nonaktif"}
                    </span>
                  </td>
                  <td>
                    <div className="moderation-actions">
                      <Button variant="outline" disabled={busy} onClick={() => { setPreview(""); setPreviewError(""); setReview(review === item.id ? null : item.id); }}>
                        {review === item.id ? "Tutup preview" : "Tinjau gambar"}
                      </Button>
                    </div>
                    {review === item.id && <div className="moderation-preview-box">
                      {previewError ? <p role="alert">{previewError}</p> : preview ? <Image unoptimized width={1000} height={560} src={preview} alt={`Background pribadi slot ${item.slot} untuk ditinjau`} style={{ maxWidth: "100%", height: "auto" }} /> : <p role="status">Memuat preview pribadi…</p>}
                      {item.active && <Button variant="outline" disabled={busy || !preview} onClick={() => void disable(item)}>{busy ? "Menonaktifkan…" : "Nonaktifkan gambar"}</Button>}
                    </div>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )}

    <div className="moderation-pagination">
      {after && <Button variant="outline" disabled={loading || busy} onClick={() => setAfter("")}>Halaman pertama</Button>}
      {next && <Button variant="outline" disabled={loading || busy} onClick={() => setAfter(next)}>Halaman berikutnya</Button>}
    </div>
  </section>;
}
