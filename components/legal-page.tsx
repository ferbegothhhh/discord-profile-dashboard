import Link from "next/link";
import type { ReactNode } from "react";
import { LegalLinks } from "./legal-links";

export function LegalPage({ title, introduction, children }: { title: string; introduction: string; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#dokumen">Lewati ke dokumen</a>
      <header className="site-header">
        <span className="wordmark">Universality</span>
        <Link className="legal-home" href="/">Kembali ke editor</Link>
      </header>
      <main id="dokumen" className="legal-main" tabIndex={-1}>
        <article aria-labelledby="legal-title">
          <div className="page-heading">
            <h1 id="legal-title">{title}</h1>
            <p>{introduction}</p>
          </div>
          <div className="legal-prose">{children}</div>
        </article>
      </main>
      <footer className="legal-footer">
        <p>Universality · Bot komunitas dan dashboard profil</p>
        <LegalLinks />
      </footer>
    </>
  );
}
