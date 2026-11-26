"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import { Barlow_Condensed } from "next/font/google";
import studioBackground from "@/assets/background/background.jpeg";
import studioLogo from "@/assets/logo/logo.png";
import { BookImage, CircleHelp, PanelsTopLeft, ShieldCheck, SlidersHorizontal, UserRound } from "lucide-react";
import { ProfileEditor } from "./profile-editor";
import { DiscordConnection } from "./discord-connection";
import { LegalLinks } from "@/components/legal-links";
import { StringTieFooter } from "@/components/ui/string-tie-footer";
import TechText from "@/components/TechText";
import Shuffle from "@/components/Shuffle";
import { SessionIntro } from "@/components/session-intro";

const headingFont = Barlow_Condensed({ subsets: ["latin"], weight: "800", display: "swap" });

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function RobloxUniversBrand() {
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);

  return (
    <span className="studio-brand">
      <span className="studio-brand-text">Roblox Univers</span>
      {!reducedMotion && <span className="studio-brand-effect" aria-hidden="true">
        <Shuffle text="Roblox Univers" tag="span" className="studio-brand-shuffle" textAlign="left" duration={0.3} stagger={0.015} animationMode="sequence" rootMargin="0px" shuffleTimes={1} triggerOnce triggerOnHover={false} loop={false} respectReducedMotion />
      </span>}
    </span>
  );
}

function UniversalityTitle() {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [fontSize, setFontSize] = useState(36);
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);

  useEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    const observer = new ResizeObserver(() => setFontSize(parseFloat(getComputedStyle(title).fontSize)));
    observer.observe(title);
    return () => observer.disconnect();
  }, []);

  return (
    <h1 ref={titleRef} className={`${headingFont.className} universality-title`}>
      <span className="universality-title-text">Universality</span>
      {!reducedMotion && <span className="universality-title-effect" aria-hidden="true">
        <TechText text="Universality" fontWeight={800} fontSize={fontSize} letterSpacing={-0.015} align="left" sweep={false} draggable={false} clickKick={false} selection={false} labels={false} specks={0} intro="none" />
      </span>}
    </h1>
  );
}

export default function Home() {
  const [context, setContext] = useState<{ userId: string | null | undefined; guildId: string | null; canModerate?: boolean }>({ userId: undefined, guildId: null });

  return (
    <div className="app-shell">
      <SessionIntro />
      <div className="studio-backdrop" aria-hidden="true">
        <Image src={studioBackground} alt="" fill sizes="100vw" preload />
      </div>
      <a className="skip-link" href="#editor">Lewati ke editor</a>
      <aside className="studio-sidebar">
        <a className="wordmark" href="#editor" aria-label="Ke editor profil"><Image className="studio-logo" src={studioLogo} alt="" width={112} height={112} /></a>
        <nav className="studio-nav" aria-label="Navigasi studio">
          <a className="nav-primary" href="#editor"><SlidersHorizontal aria-hidden="true" />Editor profil</a>
          <a href="#catalog"><PanelsTopLeft aria-hidden="true" />Katalog background</a>
          {context.userId && context.guildId && <a href="#library"><BookImage aria-hidden="true" />Library pribadi</a>}
          <a href="#discord"><UserRound aria-hidden="true" />Akun & server</a>
          {context.canModerate && <a href="#moderation"><ShieldCheck aria-hidden="true" />Moderasi server</a>}
        </nav>
        <div className="sidebar-support">
          <CircleHelp aria-hidden="true" />
          <strong>Butuh bantuan?</strong>
          <p>Tanyakan pengaturan profil di server dukungan.</p>
          <a href="https://discord.gg/ruv" target="_blank" rel="noopener noreferrer">Dukungan Discord (tab baru)</a>
        </div>
        <span className="sidebar-footnote">Background untuk profil Discord</span>
      </aside>
      <div className="studio-body">
        <header className="studio-topbar"><div className="studio-brand-group"><Image className="studio-logo" src={studioLogo} alt="" width={48} height={48} /><RobloxUniversBrand /></div><a href="#discord">{context.userId ? "Kelola akun & server" : "Hubungkan Discord"}<UserRound aria-hidden="true" /></a></header>
        <main id="editor" className="studio-main">
          <div className="page-heading">
            <div><UniversalityTitle /><p>Pilih suasana untuk kartu profilmu.</p></div>
            <span className="workspace-mode">{context.userId && context.guildId ? "Preferensi per server" : "Draft lokal"}</span>
          </div>
          <ProfileEditor key={JSON.stringify([context.userId, context.guildId])} guildId={context.guildId} userId={context.userId} />
          <DiscordConnection onContextChange={setContext} />
        </main>
        <StringTieFooter signatureText="Universality" signatureLabel="Universality" legalLinks={<LegalLinks />} />
      </div>
    </div>
  );
}
