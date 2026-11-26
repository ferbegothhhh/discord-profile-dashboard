"use client";

import { useEffect, useRef, useState } from "react";
import type { AchievementSnapshot } from "../lib/profile-achievements-bot";
import { ExactProfilePreview } from "./exact-profile-preview";
import { motion, useReducedMotion } from "motion/react";
import { Check, Eye, RotateCcw, Save, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { BackgroundLibrary, discordResponseError, useBackgroundLibrary } from "../components/background-library";
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
  const retryDraft = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const anonymous = userId === null;
  const remote = typeof userId === "string" && !!guildId;
  const library = useBackgroundLibrary(guildId, remote);
  const [unresolvedId, setUnresolvedId] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [previewDefault, setPreviewDefault] = useState(false);
  const [bio, setBio] = useState("");
  const [savedBio, setSavedBio] = useState("");
  const [bioState, setBioState] = useState<"loading" | "ready" | "error">("loading");
  const [bioBusy, setBioBusy] = useState(false);
  const [bioMessage, setBioMessage] = useState("");
  const [achievements, setAchievements] = useState<AchievementSnapshot | null>(null);
  const [achievementState, setAchievementState] = useState<"loading" | "ready" | "error">("loading");
  const [achievementMessage, setAchievementMessage] = useState("");
  const [achievementBusy, setAchievementBusy] = useState(false);
  const [achievementRetry, setAchievementRetry] = useState(0);
  const [bioRetry, setBioRetry] = useState(0);
  const custom = remote && library.state === "ready" ? library.data?.slots.find((slot) => slot.unlocked && slot.background?.id === selectedId && slot.background.status === "ready" && slot.background.isActive)?.background : null;

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
        setSelectedId(retryDraft.current ?? item.id);
        retryDraft.current = null;
        setSavedId(item.id);
        setRemoteLoaded(true);
        setSyncState("ready");
        setMessage("Pilihan pribadi dimuat dari cloud. Klik Perbarui preview untuk merender kartu bot.");
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
        if (!response.ok) throw new Error(await discordResponseError(response) ?? preferenceError(response.status));
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
        setSelectedId(retryDraft.current ?? id ?? defaultBackgroundId);
        retryDraft.current = null;
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

  useEffect(() => {
    if (typeof userId !== "string") return;
    const controller = new AbortController();
    async function loadBio() {
      setBioState("loading");
      try {
        const response = await fetch("/api/profile-bio", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(preferenceError(response.status));
        const data = await response.json();
        if (data.status !== "ready" || (data.bio !== null && typeof data.bio !== "string")) throw new Error("Respons bio tidak valid.");
        if (!controller.signal.aborted) { setBio(data.bio ?? ""); setSavedBio(data.bio ?? ""); setBioState("ready"); setBioMessage(""); }
      } catch (error) { if (!controller.signal.aborted) { setBioState("error"); setBioMessage(error instanceof Error ? error.message : "Bio gagal dimuat."); } }
    }
    void loadBio();
    return () => controller.abort();
  }, [userId, bioRetry]);

  useEffect(() => {
    if (!remote) return;
    const controller = new AbortController();
    async function loadAchievements() {
      try {
        const response = await fetch(`/api/profile-achievements?guildId=${encodeURIComponent(guildId!)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(preferenceError(response.status));
        const data: AchievementSnapshot = await response.json();
        if (data.status !== "ready" || data.guildId !== guildId || data.userId !== userId || !Array.isArray(data.achievements)) throw new Error("Respons pencapaian tidak valid.");
        if (!controller.signal.aborted) { setAchievements(data); setAchievementState("ready"); setAchievementMessage(""); }
      } catch (error) { if (!controller.signal.aborted) { setAchievementState("error"); setAchievementMessage(error instanceof Error ? error.message : "Pencapaian gagal dimuat."); } }
    }
    void loadAchievements();
    return () => controller.abort();
  }, [remote, guildId, userId, achievementRetry]);

  async function saveBio(method: "POST" | "DELETE") {
    if (bioState !== "ready" || bioBusy) return;
    setBioBusy(true);
    try {
      const response = await fetch("/api/profile-bio", { method, cache: "no-store", headers: method === "POST" ? { "Content-Type": "application/json" } : undefined, body: method === "POST" ? JSON.stringify({ bio }) : undefined });
      if (!response.ok) throw new Error(preferenceError(response.status));
      const data = await response.json();
      if (data.status !== (method === "POST" ? "saved" : "deleted")) throw new Error("Respons bio tidak valid.");
      setSavedBio(method === "POST" ? bio : "");
      if (method === "DELETE") setBio("");
      setBioMessage(method === "POST" ? "Bio tersimpan untuk semua server." : "Bio dihapus untuk semua server.");
    } catch (error) { setBioMessage(error instanceof Error ? error.message : "Gagal menyimpan bio."); }
    finally { setBioBusy(false); }
  }

  async function chooseTitle(id: string) {
    if (!remote || !achievements || achievementBusy) return;
    setAchievementBusy(true);
    try {
      const response = await fetch("/api/profile-achievements", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guildId, achievementId: id }) });
      if (!response.ok) throw new Error(preferenceError(response.status));
      const data = await response.json();
      if (data.status !== "saved" || data.achievementId !== id || data.guildId !== guildId || data.userId !== userId) throw new Error("Respons title tidak valid.");
      setAchievements({ ...achievements, selectedTitleId: id });
      setAchievementMessage("Title terpasang untuk server ini.");
    } catch (error) { setAchievementMessage(error instanceof Error ? error.message : "Gagal memilih title."); setAchievementRetry((value) => value + 1); }
    finally { setAchievementBusy(false); }
  }

  const achievementImages: Record<string, string> = {
    first_contact: "First Contact.png", signal_established: "Signal Established.png", never_silent: "Never Silent.png",
    voice_from_the_void: "Voice from the Void.png", first_fortune: "First Fortune.png", galactic_fortune: "Galactic Fortune.png",
    seven_day_orbit: "Seven-Day Orbit.png", unbroken_orbit: "Unbroken Orbit.png", a_star_is_born: "A Star Is Born.png",
    across_the_univers: "Across the Univers.png", beyond_the_horizon: "Beyond the Horizon.png", supernova: "Supernova.png",
  };
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
    setPreviewDefault(false);
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
      if (!response.ok) throw new Error(await discordResponseError(response) ?? preferenceError(response.status));
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
      <div className="background-options">
        <section id="catalog" className="catalog-section" aria-labelledby="catalog-title" aria-busy={loadState === "loading"}>
          <div className="section-heading"><h2 id="catalog-title">Pilih background</h2><span className="muted">Gambar bawaan</span></div>
          <p className="catalog-intro">Dua gambar bawaan untuk kartu profil. Pilihan lama tetap dapat dibaca sampai diganti.</p>
          <div className="catalog-filters">
            <div><label className="field-label" htmlFor="search">Cari background</label><div className="search-row"><div className="search-input"><Search aria-hidden="true" /><Input id="search" type="search" placeholder="Cari background…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><Button variant="outline" onClick={clearFilters} disabled={!query && category === "Semua"}>Bersihkan</Button></div></div>
            <div><label className="field-label" htmlFor="category">Kategori</label><NativeSelect id="category" value={category} onChange={(event) => setCategory(event.target.value)}><NativeSelectOption>Semua</NativeSelectOption><NativeSelectOption>Katalog</NativeSelectOption></NativeSelect></div>
          </div>
          {loadState === "loading" && <p className="catalog-state" role="status">Memuat katalog gambar…</p>}
          {loadState === "error" && <div className="catalog-state" role="alert"><p>Katalog gagal dimuat. Periksa koneksi lalu coba lagi.</p><Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Coba lagi</Button></div>}
          {loadState === "ready" && filtered.length === 0 && <div className="catalog-state" role="status"><p>{catalog.length === 0 ? "Katalog belum berisi background. Coba muat ulang katalog." : "Tidak ada background yang cocok. Bersihkan pencarian atau ubah kategori."}</p>{catalog.length === 0 ? <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Muat ulang katalog</Button> : <Button variant="outline" onClick={clearFilters}>Hapus filter</Button>}</div>}
          {loadState === "ready" && <div className="swatch-grid catalog-grid">{filtered.map((item) => <Button variant="outline" size="swatch" className="swatch" key={item.id} disabled={!canEdit} aria-pressed={selectedId === item.id} onClick={() => select(item.id)}><span className="swatch-color" style={{ backgroundImage: item.image ? `url(${item.image})` : undefined, backgroundColor: item.color }} aria-hidden="true">{selectedId === item.id && <span className="selection-check"><Check /></span>}</span><span className="swatch-description"><strong>{item.name}</strong><span>{selectedId === item.id ? "Dipilih" : "Bawaan"}</span></span></Button>)}</div>}
        </section>
        {remote ? <BackgroundLibrary guildId={guildId!} library={library} selectedId={selectedId} canSelect={canEdit} disabled={writing || syncState === "syncing" || syncState === "idle"} onSelect={select} onDelete={deleted} onBusy={setLibraryBusy} /> : <div className="library-invitation"><h2>Gunakan gambar milikmu</h2><p>Login dan pilih server untuk melihat slot library pribadi beserta persyaratan levelnya.</p><a href="#discord">Hubungkan akun Discord</a></div>}
      {remote && <section className="catalog-section bio-section" aria-labelledby="bio-title"><div className="section-heading"><h2 id="bio-title">Bio Profil Global</h2><span className="muted">Lintas server</span></div><p className="catalog-intro">Bio singkat yang berlaku di semua server. Maksimal 120 karakter.</p><div className="upload-field"><label htmlFor="bio-input">Teks bio</label><Input id="bio-input" value={bio} maxLength={120} disabled={bioState !== "ready" || bioBusy} onChange={(event) => setBio(event.target.value)} placeholder="Tulis bio singkat Anda…" /></div><div className="save-actions"><Button onClick={() => void saveBio("POST")} disabled={bioState !== "ready" || bioBusy || bio === savedBio}>Simpan Bio</Button><Button variant="outline" onClick={() => void saveBio("DELETE")} disabled={bioState !== "ready" || bioBusy || !savedBio}>Hapus Bio</Button></div><p className="section-status" role="status">{bioMessage || (bioState === "loading" ? "Memuat bio..." : bioState === "error" ? "Gagal memuat bio." : "Siap")}</p>{bioState === "error" && <Button variant="outline" onClick={() => setBioRetry((v) => v + 1)}>Coba lagi</Button>}</section>}
      {remote && <section className="catalog-section" aria-labelledby="achievements-title"><div className="section-heading"><h2 id="achievements-title">Pencapaian & Title Server</h2><span className="muted">Musim aktif</span></div><p className="catalog-intro">Pilih title untuk server ini dari pencapaian yang sudah terbuka.</p>{achievementState === "loading" && <p className="catalog-state" role="status">Memuat pencapaian…</p>}{achievementState === "error" && <div className="catalog-state" role="alert"><p>{achievementMessage}</p><Button variant="outline" onClick={() => setAchievementRetry((v) => v + 1)}>Coba lagi</Button></div>}{achievementState === "ready" && achievements && <div className="swatch-grid achievement-grid">{achievements.achievements.map((item) => <Button variant="outline" size="swatch" className="swatch" key={item.id} disabled={!item.unlocked || achievementBusy} aria-pressed={achievements.selectedTitleId === item.id} onClick={() => void chooseTitle(item.id)}><span className="swatch-color" style={{ backgroundImage: achievementImages[item.id] ? `url(/achievements/${encodeURIComponent(achievementImages[item.id])})` : undefined, backgroundColor: item.unlocked ? "#2d233c" : "#18181d" }} aria-hidden="true">{achievements.selectedTitleId === item.id && <span className="selection-check"><Check /></span>}</span><span className="swatch-description"><strong>{item.name}</strong><span>{item.unlocked ? achievements.selectedTitleId === item.id ? "Title Aktif" : "Terbuka · Klik pasang" : "Terkunci"}</span></span></Button>)}</div>}<p className="section-status" role="status">{achievementMessage}</p></section>}
      </div>
      <section className="preview-section" aria-labelledby="preview-title">
        <div className="section-heading"><h2 id="preview-title"><Eye aria-hidden="true" />{remote ? "Preview /profile" : "Preview lokal"}</h2><span className="sample-label">{remote ? "Renderer bot" : "Data contoh"}</span></div>
        {remote ? <>
          <Button variant="outline" disabled={!canEdit} aria-pressed={previewDefault} onClick={() => setPreviewDefault(value => !value)}>{previewDefault ? "Gunakan pilihan editor" : "Coba default bot"}</Button>
          <ExactProfilePreview key={JSON.stringify([userId, guildId, selectedId, previewDefault, custom?.revision, available, library.state])} guildId={guildId!} backgroundId={previewDefault ? null : selectedId} revision={previewDefault ? null : custom?.revision ?? null} available={canEdit && (previewDefault || available)} />
        </> : <><div className="preview-stage">
          <motion.div className="profile-preview" initial={false} animate={{ backgroundColor: selected.image ? undefined : selected.color, backgroundImage: selected.image ? `url(${selected.image})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }} transition={{ duration: reduceMotion === false ? 0.12 : 0 }}>
            <span className="preview-caption">Contoh kartu profil</span>
            <div className="preview-identity"><h3>Nama pengguna</h3><p>Identitas contoh, bukan data akun</p></div>
            <div className="preview-bottom"><span>{custom?.name ?? selected.name}</span><span>{selected.image ? "Gambar bawaan" : "Warna sampel"}</span></div>
          </motion.div>
        </div>
        <p className="preview-disclaimer">Perkiraan tampilan saja, bukan hasil renderer bot. Tidak memakai avatar, statistik member, atau aset default bot.</p></>}
        {remote && previewDefault && <p className="muted">Preview mencoba default bot. Pilihan editor di bawah dan preferensi tersimpan tidak berubah.</p>}
        <div className="draft-summary"><span>Pilihan sekarang</span><strong>{custom?.name ?? selected.name} <small>{custom ? "· Pribadi" : "· Sampel"}</small></strong></div>
        <p className="muted">{anonymous ? "Demo anonim: draft hanya di browser ini, tidak diunggah saat login." : "Preferensi akun/server disimpan online, tidak memakai draft browser anonim."}</p>
        <div className="save-actions"><Button onClick={save} disabled={!canEdit || !available || (remote && !remoteLoaded) || (!dirty && !writeFailed)}><Save aria-hidden="true" />{writing ? "Memproses…" : remote ? "Simpan online" : "Simpan draft lokal"}</Button><Button variant="outline" onClick={reset} disabled={!canReset}><RotateCcw aria-hidden="true" />{remote ? "Reset pilihan" : "Reset draft"}</Button></div>
        <p className="save-status" role="status">{message}</p>
        {remote && (syncState === "error" || writeFailed) && <Button variant="outline" disabled={busy} onClick={() => { retryDraft.current = selectedId; library.refresh(); setSyncAttempt((value) => value + 1); }}>Muat ulang preferensi</Button>}
        {savedId !== null && dirty && <p className="muted">Ada perubahan yang belum disimpan.</p>}
      </section>

    </div>
  );
}
