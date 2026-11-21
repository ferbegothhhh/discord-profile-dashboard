import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Background profil | Dashboard Discord",
  description: "Draft lokal pilihan background profil. Integrasi Discord dan bot belum aktif.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body>{children}</body></html>;
}
