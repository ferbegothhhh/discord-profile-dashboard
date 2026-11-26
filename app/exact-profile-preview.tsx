"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Eye } from "lucide-react";
import { Button } from "../components/ui/button";

type Props = { guildId: string; backgroundId: string | null; revision: number | null; available: boolean };

export function ExactProfilePreview({ guildId, backgroundId, revision, available }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => () => {
    pending.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  async function update() {
    if (!available || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setUrl(null);
    setState("loading");
    try {
      const response = await fetch("/api/profile-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(22000)]),
        body: JSON.stringify({ guildId, backgroundId, revision }),
      });
      if (!response.ok || response.headers.get("content-type") !== "image/png") {
        throw new Error(response.status === 429 ? "Batas preview tercapai. Tunggu satu menit lalu coba lagi." : response.status === 403 ? "Akses server atau slot berubah. Muat ulang library dan periksa keanggotaan." : "Render bot belum tersedia. Coba lagi; pilihan tidak disimpan.");
      }
      const blob = await response.blob();
      if (blob.size > 2305536 || blob.size < 33) throw new Error("Hasil render tidak valid. Coba lagi.");
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      objectUrl.current = next;
      setUrl(next);
      setState("ready");
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error && failure.name !== "TimeoutError" ? failure.message : "Render bot melewati batas waktu. Coba lagi.");
        setState("error");
      }
    } finally { if (pending.current === controller) pending.current = null; }
  }

  return <>
    <div className="preview-stage exact-preview-stage" aria-busy={state === "loading"}>
      {url ? <Image unoptimized className="private-preview-image" src={url} width={1000} height={560} alt="Hasil renderer bot untuk akun dan server terpilih" onError={() => { setState("error"); setUrl(null); setError("Gambar gagal ditampilkan. Perbarui preview untuk mencoba lagi."); }} /> : <p className="catalog-state" role="status">{state === "loading" ? "Bot sedang merender kartu profil…" : "Belum ada hasil untuk pilihan ini. Klik Perbarui preview."}</p>}
    </div>
    <Button variant="outline" onClick={update} disabled={!available || state === "loading"}><Eye aria-hidden="true" />{state === "loading" ? "Merender preview…" : "Perbarui preview"}</Button>
    {state === "error" && <p role="alert">{error}</p>}
    <p className="preview-disclaimer">PNG dari renderer /profile. Statistik adalah snapshot saat render, bukan pembaruan otomatis. Mencoba background tidak menyimpan preferensi.</p>
  </>;
}
