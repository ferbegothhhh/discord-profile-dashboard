"use client";

import { useState } from "react";
import { ProfileEditor } from "./profile-editor";
import { DiscordConnection } from "./discord-connection";
import { LegalLinks } from "@/components/legal-links";

export default function Home() {
  const [context, setContext] = useState<{ userId: string | null | undefined; guildId: string | null }>({ userId: undefined, guildId: null });

  return (
    <>
      <a className="skip-link" href="#editor">Lewati ke editor</a>
      <header className="site-header">
        <span className="wordmark">Profil / Studio</span>
        <span className="header-note">Katalog demo · Preferensi online</span>
      </header>
      <main id="editor">
        <div className="page-heading">
          <h1>Background profil</h1>
          <p>Coba background dengan draft lokal, atau login dan pilih server untuk menyimpan preferensi online.</p>
        </div>
        <ProfileEditor key={JSON.stringify([context.userId, context.guildId])} guildId={context.guildId} userId={context.userId} />
        <DiscordConnection onContextChange={setContext} />
      </main>
      <footer>
        <p>Katalog warna sampel. Integrasi Discord dan bot nyata masih perlu diuji.</p>
        <LegalLinks />
      </footer>
    </>
  );
}
