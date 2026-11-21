import Link from "next/link";

export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Informasi Universality">
      <Link href="/terms">Ketentuan Layanan</Link>
      <Link href="/privacy">Kebijakan Privasi</Link>
      <a href="https://discord.gg/ruv" target="_blank" rel="noopener noreferrer">Dukungan Discord (tab baru)</a>
    </nav>
  );
}
