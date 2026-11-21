"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "../components/ui/button";
import { BackgroundLibrary, privateMedia, useBackgroundLibrary } from "../components/background-library";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { defaultBackgroundId, draftStorageKey, filterBackgrounds, findBackground, isCatalog, parseDraft, serializeDraft, type Background } from "../lib/catalog";

function preferenceError(status: number) {
  if (status === 401) return "Sesi berakhir. Login ulang sebelum mencoba lagi.";
  if (status === 403) return "Akses server ditolak. Periksa keanggotaan dan minta operator mendaftarkan server pada registry bot.";
  if (status === 503) return "Layanan cloud belum tersedia. Operator perlu memeriksa konfigurasi Supabase/database dan registry bot.";
  if (status === 400) return "Pilihan atau server tidak valid. Background mungkin tidak aktif; muat ulang katalog sebelum mencoba lagi.";
  if (status === 429) return "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.";
  return "Permintaan cloud gagal. Periksa koneksi lalu coba lagi.";
}

export function ProfileEditor({ guildId, userId }: { guildId: string | null; userId: string | null | undefined }) {
  const reduceMotion = useReducedMotion();
  const [catalog, setCatalog] = useState<Background[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ready" | "error">("idle");
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState(defaultBackgroundId);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [message, setMessage] = useState("Memuat draft...");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Semua");
  const [syncAttempt, setSyncAttempt] = useState(0);
  const [writing, setWriting] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [preferenceRead, setPreferenceRead] = useState(false);
  const unresolvedRetryId = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const anonymous = userId === null;
  const remote = typeof userId === "string" && !!guildId;
  const library = useBackgroundLibrary(guildId, remote);
  const [unresolvedId, setUnresolvedId] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [failedMedia, setFailedMedia] = useState<string | null>(null);
  const custom = remote && library.state === "ready" ? library.data?.slots.find((slot) => slot.unlocked && slot.background?.id === selectedId && slot.background.status === "ready" && slot.background.isActive)?.background : null;
  const mediaSrc = custom && guildId ? privateMedia(custom, guildId) : null;

  useEffect(() => {
    const id = unresolvedId ?? unresolvedRetryId.current;
    if (!id || (library.state !== "ready" && library.state !== "error")) return;
    let active = true;
    const item = library.state === "ready" && library.data?.guildId === guildId ? library.data.slots.find((slot) => slot.unlocked && slot.background?.id === id && slot.background.status === "ready" && slot.background.isActive)?.background : null;
    queueMicrotask(() => {
      if (!active) return;
      setUnresolvedId(null);
      if (item) {
        unresolvedRetryId.current = null;
        setSelectedId(item.id);
        setSavedId(item.id);
        setRemoteLoaded(true);
        setSyncState("ready");
        setMessage("Pilihan pribadi dimuat dari cloud. Preview hanya perkiraan.");
      } else {
        setSelectedId(defaultBackgroundId);
        setSavedId(id);
        setRemoteLoaded(false);
        setSyncState("error");
        setMessage("Preferensi online tidak dikenal atau tidak valid. Preview memakai sampel awal, bukan pilihan tersimpan. Muat ulang library, reset pilihan, atau pilih pengganti untuk disimpan online.");
      }
    });
    return () => { active = false; };
  }, [unresolvedId, library.state, library.data, guildId]);

  function deleted(id: string) {
    if (selectedId === id) setSelectedId(defaultBackgroundId);
    if (savedId === id) setSavedId(null);
    setMessage("Gambar dihapus. Pilihan yang memakai gambar ini direset oleh server; preview memakai sampel awal.");
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { controller.abort(); };
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (remote) return;
      if (!anonymous) {
        setMessage(userId === undefined ? "Memuat identitas akun…" : "Pilih server untuk memuat preferensi online. Draft demo tidak diunggah.");
        return;
      }
      try {
        const raw = localStorage.getItem(draftStorageKey);
        const id = parseDraft(raw);
        if (id) {
          setSelectedId(id);
          setSavedId(id);
          setMessage("Draft dimuat dari browser.");
        } else {
          setMessage(raw === null ? "Belum ada draft di browser." : "Draft lama tidak valid.");
        }
      } catch {
        setMessage("Gagal membaca penyimpanan browser.");
      }
      setStorageReady(true);
    });
    return () => { active = false; };
  }, [anonymous, userId, remote]);

  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let active = true;
    async function sync() {
      setSyncState("syncing");
      setPreferenceRead(false);
      setRemoteLoaded(false);
      unresolvedRetryId.current = null;
      setUnresolvedId(null);
      try {
        setMessage("Memuat preferensi online…");
        const response = await fetch(`/api/preferences?guildId=${encodeURIComponent(guildId!)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(preferenceError(response.status));
        const data: unknown = await response.json();
        if (!active) return;
        if (typeof data !== "object" || data === null || !("status" in data) || data.status !== "ready" || !("backgroundId" in data) || (data.backgroundId !== null && (typeof data.backgroundId !== "string" || (!findBackground(data.backgroundId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.backgroundId))))) {
          setSelectedId(defaultBackgroundId);
          setSavedId(null);
          setRemoteLoaded(false);
          throw new Error("Preferensi online tidak dikenal atau tidak valid. Preview memakai sampel awal, bukan pilihan tersimpan. Coba muat ulang preferensi.");
        }
        const id = data.backgroundId as string | null;
        setPreferenceRead(true);
        setWriteFailed(false);
        if (id !== null && !findBackground(id)) {
          unresolvedRetryId.current = id;
          setUnresolvedId(id);
          setRemoteLoaded(false);
          setMessage("Memuat library untuk memeriksa pilihan pribadi…");
          return;
        }
        setUnresolvedId(null);
        setSelectedId(id ?? defaultBackgroundId);
        setSavedId(id);
        setRemoteLoaded(true);
        setWriteFailed(false);
        setMessage(id === null ? "Belum ada pilihan online. Preview memakai sampel awal, bukan default bot." : "Pilihan dimuat dari Supabase/cloud. Integrasi bot nyata belum diuji.");
        setSyncState("ready");
      } catch (error) {
        if (active) {
          setSyncState("error");
          setMessage(error instanceof Error ? error.message : "Gagal memuat preferensi online. Coba lagi.");
        }
      }
    }
    void sync().finally(() => window.clearTimeout(timeout));
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [remote, guildId, syncAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    let active = true;
    async function load() {
      setLoadState("loading");
      try {
        const response = await fetch("/api/catalog", { signal: controller.signal });
        if (!response.ok) throw new Error("Katalog gagal dimuat");
        const data: unknown = await response.json();
        if (!isCatalog(data)) throw new Error("Katalog tidak valid");
        if (active) {
          setCatalog(data.backgrounds);
          setLoadState("ready");
        }
      } catch {
        if (active) setLoadState("error");
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void load();
    return () => { active = false; controller.abort(); window.clearTimeout(timeout); };
  }, [attempt]);

  const selected = findBackground(selectedId) ?? findBackground(defaultBackgroundId)!;
  const filtered = filterBackgrounds(catalog, query, category);
  const available = !!custom || (loadState === "ready" && catalog.some((item) => item.id === selectedId));
  const dirty = selectedId !== savedId;
  const busy = writing || libraryBusy || (remote && (syncState === "syncing" || syncState === "idle"));
  const canEdit = !busy && (anonymous ? storageReady : remote && (remoteLoaded || preferenceRead));
  const canReset = !busy && (anonymous ? storageReady : remote && (remoteLoaded || preferenceRead));

  function select(id: string) {
    if (!canEdit || (!findBackground(id) && !(library.state === "ready" && library.data?.guildId === guildId && library.data.slots.some((slot) => slot.unlocked && slot.background?.id === id && slot.background.status === "ready" && slot.background.isActive)))) return;
    unresolvedRetryId.current = null;
    setUnresolvedId(null);
    if (remote) setRemoteLoaded(true);
    setSelectedId(id);
    setMessage(remote ? "Pilihan berubah. Simpan online untuk server ini." : "Pilihan berubah. Simpan untuk menyimpan draft di browser ini.");
  }

  async function persistRemote(backgroundId: string | null) {
    const controller = lifetime.current;
    if (!remote || !(backgroundId === null ? remoteLoaded || preferenceRead : remoteLoaded) || !controller || controller.signal.aborted || pending.current) return;
    unresolvedRetryId.current = null;
    setUnresolvedId(null);
    pending.current = true;
    setWriting(true);
    setMessage(backgroundId === null ? "Mereset pilihan online…" : "Menyimpan pilihan online…");
    try {
      const response = await fetch("/api/preferences", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, backgroundId }),
      });
      if (!response.ok) throw new Error(preferenceError(response.status));
      const data = await response.json();
      if (data.status !== (backgroundId === null ? "reset" : "saved")) throw new Error("Respons penyimpanan cloud tidak valid. Coba lagi.");
      if (controller.signal.aborted) return;
      setSavedId(backgroundId);
      setRemoteLoaded(true);
      setSyncState("ready");
      setSelectedId(backgroundId ?? defaultBackgroundId);
      setWriteFailed(false);
      setMessage(backgroundId === null ? "Pilihan online direset. Perubahan berlaku pada fetch bot berikutnya yang berhasil; preview bukan default bot." : "Pilihan disimpan di Supabase/cloud. Perubahan berlaku pada fetch bot berikutnya yang berhasil; integrasi nyata belum diuji.");
    } catch (error) {
      if (!controller.signal.aborted) {
        setWriteFailed(true);
        setMessage(`Belum berhasil ${backgroundId === null ? "mereset" : "menyimpan"} online. ${error instanceof Error ? error.message : "Coba lagi."}`);
      }
    } finally {
      pending.current = false;
      if (!controller.signal.aborted) setWriting(false);
    }
  }

  async function save() {
    if (!available || !canEdit) return;
    if (remote) return persistRemote(selectedId);
    try {
      localStorage.setItem(draftStorageKey, serializeDraft(selectedId));
      setSavedId(selectedId);
      setMessage("Draft berhasil disimpan hanya di browser ini. Bot tidak berubah.");
    } catch {
      setMessage("Draft gagal disimpan. Penyimpanan browser diblokir atau penuh. Izinkan penyimpanan lalu coba lagi.");
      return;
    }
  }

  async function reset() {
    if (!canReset) return;
    if (remote) return persistRemote(null);
    try {
      localStorage.removeItem(draftStorageKey);
      setSelectedId(defaultBackgroundId);
      setSavedId(null);
      setMessage("Draft lokal dihapus. Preview kembali ke pilihan awal demo, bukan default bot.");
    } catch {
      setSelectedId(defaultBackgroundId);
      setMessage("Preview kembali ke pilihan awal, tetapi draft tersimpan gagal dihapus. Izinkan penyimpanan lalu reset lagi.");
      return;
    }
  }

  function clearFilters() { setQuery(""); setCategory("Semua"); }

  return (
    <div className="workspace">
      <section className="preview-section" aria-labelledby="preview-title">
        <div className="section-heading"><h2 id="preview-title">Preview lokal</h2><span className="sample-label">Data contoh</span></div>
        <div className="preview-stage">
          {mediaSrc && (failedMedia === mediaSrc ? <p className="media-fallback" role="status">Gambar pribadi gagal dimuat. Sampel solid di bawah bukan gambar tersimpan. Muat ulang library untuk memeriksa akses.</p> : <Image unoptimized className="private-preview-image" src={mediaSrc} width={1000} height={560} alt={`Perkiraan background pribadi: ${custom!.name}`} onError={() => setFailedMedia(mediaSrc)} />)}
          <motion.div className="profile-preview" initial={false} animate={{ backgroundColor: selected.color }} transition={{ duration: reduceMotion === false ? 0.12 : 0 }}>
            <span className="preview-caption">Contoh kartu profil</span>
            <div className="preview-identity"><h3>Nama pengguna</h3><p>Identitas contoh, bukan data akun</p></div>
            <div className="preview-bottom"><span>{custom?.name ?? selected.name}</span><span>{custom ? "Identitas contoh, gambar terpisah di atas" : "Warna solid sampel"}</span></div>
          </motion.div>
        </div>
        <p className="preview-disclaimer">Perkiraan tampilan saja, bukan hasil renderer bot. Tidak memakai avatar, statistik member, atau aset default bot.</p>
        <div className="draft-summary"><span>Pilihan sekarang</span><strong>{custom?.name ?? selected.name} <small>{custom ? "· Pribadi" : "· Sampel"}</small></strong></div>
        <p className="muted">{anonymous ? "Demo anonim: draft hanya di browser ini, tidak diunggah saat login." : "Preferensi akun/server disimpan online, tidak memakai draft browser anonim."}</p>
        <div className="save-actions"><Button onClick={save} disabled={!canEdit || !available || (remote && !remoteLoaded) || (!dirty && !writeFailed)}>{writing ? "Memproses…" : remote ? "Simpan online" : "Simpan draft lokal"}</Button><Button variant="outline" onClick={reset} disabled={!canReset}>{remote ? "Reset pilihan" : "Reset draft"}</Button></div>
        <p className="save-status" role="status">{message}</p>
        {remote && syncState === "error" && <Button variant="outline" disabled={busy} onClick={() => { library.refresh(); setSyncAttempt((value) => value + 1); }}>Muat ulang preferensi</Button>}
        {savedId !== null && dirty && <p className="muted">Ada perubahan yang belum disimpan.</p>}
      </section>
      <div className="background-options">
      {remote && <BackgroundLibrary guildId={guildId!} library={library} selectedId={selectedId} canSelect={canEdit} disabled={writing || syncState === "syncing" || syncState === "idle"} onSelect={select} onDelete={deleted} onBusy={setLibraryBusy} />}
      <section className="catalog-section" aria-labelledby="catalog-title" aria-busy={loadState === "loading"}>
        <div className="section-heading"><h2 id="catalog-title">Pilih background</h2><span className="muted">Katalog demo</span></div>
        <p className="catalog-intro">Swatch solid untuk mencoba alur pemilihan. Aset admin akan ditambahkan saat integrasi tersedia.</p>
        <label className="field-label" htmlFor="search">Cari background</label>
        <div className="search-row"><Input id="search" type="search" placeholder="Cari nama warna…" value={query} onChange={(event) => setQuery(event.target.value)} /><Button variant="outline" onClick={clearFilters} disabled={!query && category === "Semua"}>Bersihkan</Button></div>
        <label className="field-label" htmlFor="category">Kategori</label>
        <NativeSelect id="category" value={category} onChange={(event) => setCategory(event.target.value)}><NativeSelectOption>Semua</NativeSelectOption><NativeSelectOption>Netral</NativeSelectOption><NativeSelectOption>Ungu</NativeSelectOption></NativeSelect>
        {loadState === "loading" && <p className="catalog-state" role="status">Memuat katalog sampel…</p>}
        {loadState === "error" && <div className="catalog-state" role="alert"><p>Katalog gagal dimuat. Periksa koneksi lalu coba lagi.</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Coba lagi</Button></div>}
        {loadState === "ready" && filtered.length === 0 && <div className="catalog-state" role="status"><p>{catalog.length === 0 ? "Katalog belum berisi background. Coba muat ulang katalog." : "Tidak ada warna yang cocok. Bersihkan pencarian atau ubah kategori."}</p>{catalog.length === 0 ? <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Muat ulang katalog</Button> : <Button variant="outline" onClick={clearFilters}>Hapus filter</Button>}</div>}
        {loadState === "ready" && <div className="swatch-grid">{filtered.map((item) => <Button variant="outline" size="swatch" className="swatch" key={item.id} disabled={!canEdit} aria-pressed={selectedId === item.id} onClick={() => select(item.id)}><span className="swatch-color" style={{ backgroundColor: item.color }} aria-hidden="true" /><span className="swatch-description"><strong>{item.name}</strong><span>{selectedId === item.id ? "Dipilih · Sampel" : "Solid · Sampel"}</span></span></Button>)}</div>}
      </section>
      </div>
    </div>
  );
}
