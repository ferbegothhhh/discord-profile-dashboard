"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent, ReactNode } from "react";
import { FOOTER_DURATION, footerMotion, makeRope, nearestFree, restPath, scrollProgress, smoothPath, tiePath } from "./string-tie-footer-geometry";
import type { Point, RopePoint } from "./string-tie-footer-geometry";
import "./string-tie-footer.css";

export { hash, clamp01, polyLength, resample, tiePath, restPath, smoothPath, scrollProgress, stepWind, makeRope, stepRope, nearestFree } from "./string-tie-footer-geometry";

type StringTieFooterProps = {
  legalLinks?: ReactNode;
  signatureText?: string;
  signatureLabel?: string;
  email?: string;
  phone?: string;
  note?: { heading?: string; body?: string; href?: string; linkLabel?: string };
};

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

export function StringTieFooter({ legalLinks, signatureText = "", signatureLabel = "Universality", email = "", phone = "", note = {} }: StringTieFooterProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const cord = useRef<SVGPathElement>(null);
  const letter = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const rope = useRef<RopePoint[]>(makeRope(tiePath()));
  const pointer = useRef<Point | null>(null);
  const held = useRef(-1);
  const wake = useRef<() => void>(() => {});
  const playhead = useRef(0);
  const offsets = useRef<Point[]>(tiePath().map(() => ({ x: 0, y: 0 })));
  const [phase, setPhase] = useState<"closed" | "untying" | "open">("closed");
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const reduced = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);
  const expanded = phase !== "closed";

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: .01 });
    observer.observe(element);
    const intro = () => element.style.setProperty("--stt-intro", String(scrollProgress(element.getBoundingClientRect().top, window.innerHeight, element.offsetHeight)));
    intro();
    window.addEventListener("scroll", intro, { passive: true });
    window.addEventListener("resize", intro);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", intro);
      window.removeEventListener("resize", intro);
    };
  }, []);

  useEffect(() => {
    const path = cord.current;
    const element = root.current;
    if (!path || !element) return;
    const tied = tiePath();
    const loose = restPath();
    const destination = expanded ? FOOTER_DURATION : 0;
    const paint = () => {
      const motion = footerMotion(playhead.current);
      element.style.setProperty("--stt-flap", String(1 - motion.flap * 2));
      element.style.setProperty("--stt-flap-layer", motion.flap < .5 ? "4" : "1");
      element.style.setProperty("--stt-note", String(motion.note));
      element.style.setProperty("--stt-note-visibility", playhead.current > 0 ? "visible" : "hidden");
      rope.current = makeRope(tied.map((p, i) => ({
        x: p.x + (loose[i].x - p.x) * motion.cord + offsets.current[i].x,
        y: p.y + (loose[i].y - p.y) * motion.cord + offsets.current[i].y,
      })));
      path.setAttribute("d", smoothPath(rope.current));
    };
    if (reduced || !visible) {
      playhead.current = destination;
      offsets.current = tied.map(() => ({ x: 0, y: 0 }));
      pointer.current = null;
      held.current = -1;
      paint();
      wake.current = () => {};
      const completion = expanded ? window.setTimeout(() => setPhase("open"), 0) : undefined;
      return () => window.clearTimeout(completion);
    }
    let frame = 0;
    let previous = performance.now();
    let disposed = false;
    const tick = (time: number) => {
      frame = 0;
      if (disposed) return;
      const delta = Math.max(0, Math.min(32, time - previous));
      previous = time;
      playhead.current += Math.sign(destination - playhead.current) * Math.min(delta, Math.abs(destination - playhead.current));
      const motion = footerMotion(playhead.current);
      const blend = 1 - Math.exp(-delta / 65);
      let settling = false;
      offsets.current = offsets.current.map((offset, i) => {
        const base = { x: tied[i].x + (loose[i].x - tied[i].x) * motion.cord, y: tied[i].y + (loose[i].y - tied[i].y) * motion.cord };
        const cursor = expanded && i > 0 ? pointer.current : null;
        const brush = cursor ? Math.max(0, 1 - Math.hypot(base.x - cursor.x, base.y - cursor.y) / 65) : 0;
        const x = cursor ? held.current === i ? cursor.x - base.x : (base.x - cursor.x) * brush * .45 : 0;
        const y = cursor ? held.current === i ? cursor.y - base.y : (base.y - cursor.y) * brush * .45 : 0;
        const next = { x: offset.x + (x - offset.x) * blend, y: offset.y + (y - offset.y) * blend };
        if (Math.hypot(x - next.x, y - next.y) > .01) settling = true;
        else return { x, y };
        return next;
      });
      paint();
      if (playhead.current !== destination || settling) frame = requestAnimationFrame(tick);
      else if (expanded) setPhase("open");
    };
    wake.current = () => {
      if (!frame && !disposed) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };
    wake.current();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      wake.current = () => {};
    };
  }, [expanded, reduced, visible]);

  function close() {
    if (letter.current?.contains(document.activeElement)) toggle.current?.focus();
    setPhase("closed");
    pointer.current = null;
    held.current = -1;
  }

  function open() {
    toggle.current?.focus({ preventScroll: true });
    setPhase(reduced ? "open" : "untying");
  }

  function position(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(600, (event.clientX - bounds.left) / bounds.width * 600)), y: Math.max(0, Math.min(360, (event.clientY - bounds.top) / bounds.height * 360)) };
  }

  return (
    <footer ref={root} className="stt" data-phase={phase} onKeyDown={event => { if (event.key === "Escape" && expanded) { event.preventDefault(); close(); } }}>
      <div className="stt-layout">
        <div className="stt-intro">
          <p className="stt-meta">Universality / Discord / Profil personal</p>
          <h2>Sampai<br /><em>jumpa.</em></h2>
          <p>see you<br />Sampai ketemu di Discord.</p>
          <span className="stt-tape">Universality</span>
        </div>
        <div className="stt-stage">
          <div className="stt-envelope">
            <svg className="stt-back" viewBox="0 0 600 360" aria-hidden="true">
              <defs>
                <filter id={`${id}-paper`}><feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" seed="7" /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope=".09" /></feComponentTransfer><feComposite in2="SourceAlpha" operator="in" /><feBlend in="SourceGraphic" mode="multiply" /></filter>
              </defs>
              <rect x="25" y="60" width="550" height="275" rx="5" fill="#e5e3e0" />
              <path d="M25 65 300 235 575 65" fill="none" stroke="#bbb8b3" />
            </svg>
            <div ref={letter} id={`${id}-note`} className="stt-note" role="region" aria-label="Pesan Universality" inert={phase !== "open"} aria-hidden={phase !== "open"}>
              <span className="stt-note-meta">Untuk profil yang terasa seperti kamu</span>
              <h3>{note.heading ?? "Terima kasih sudah mampir."}</h3>
              <p>{note.body ?? "Butuh bantuan mengatur profil? Temui kami di server dukungan Discord."}</p>
              <a href={note.href ?? "https://discord.gg/ruv"} target="_blank" rel="noopener noreferrer">{note.linkLabel ?? "Dukungan Discord (tab baru)"}</a>
              {email && <div className="stt-contact"><a href={`mailto:${email}`}>{email}</a><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(email); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Tersalin" : "Salin email"}</button><span role="status">{copied ? "Email disalin." : ""}</span></div>}
              {phone && <p className="stt-contact">{phone}</p>}
              {signatureText && <svg className="stt-signature" viewBox="0 0 300 55" role="img" aria-label={signatureLabel}><text x="3" y="38">{signatureText}</text><path d="M4 47 Q140 35 290 46" /></svg>}
            </div>
            <svg className="stt-front" viewBox="0 0 600 360" aria-hidden="true">
              <path d="M25 65 300 235 575 65V330Q575 335 570 335H30Q25 335 25 330Z" fill="#f3f1ec" filter={`url(#${id}-paper)`} />
              <path d="M25 330 220 205M575 330 380 205" fill="none" stroke="#cbc8c2" />
              <text x="65" y="296" fill="#101013" fontSize="16">see you</text>
              <g transform="translate(480 260) rotate(-12)"><rect width="56" height="48" fill="none" stroke="#7740d6" strokeDasharray="3 2" /><text x="28" y="32" textAnchor="middle" fill="#7740d6" fontSize="27" fontFamily="Georgia">U</text></g>
              <circle cx="300" cy="259" r="17" fill="#e2ded7" stroke="#aaa49b" /><circle cx="300" cy="259" r="4" fill="#7740d6" />
            </svg>
            <svg className="stt-flap" viewBox="0 0 600 360" aria-hidden="true"><path d="M25 60H575L320 177Q300 189 280 177Z" fill="#faf9f6" stroke="#cbc8c2" filter={`url(#${id}-paper)`} /><circle cx="300" cy="119" r="18" fill="#e2ded7" stroke="#aaa49b" /><circle cx="300" cy="119" r="4" fill="#7740d6" /></svg>
            <svg className="stt-cord" viewBox="0 0 600 360" aria-hidden="true"
              onPointerDown={event => {
                if (!expanded || reduced) return;
                pointer.current = position(event);
                held.current = nearestFree(rope.current, pointer.current);
                if (held.current >= 0) event.currentTarget.setPointerCapture(event.pointerId);
                wake.current();
              }}
              onPointerMove={event => { if (expanded && !reduced) { pointer.current = position(event); wake.current(); } }}
              onPointerUp={event => { held.current = -1; pointer.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); wake.current(); }}
              onPointerCancel={() => { held.current = -1; pointer.current = null; wake.current(); }}
              onPointerLeave={() => { if (held.current < 0) { pointer.current = null; wake.current(); } }}>
              <path ref={cord} d={smoothPath(tiePath())} fill="none" stroke="#7740d6" strokeWidth="3.2" strokeLinecap="round" />
            </svg>
            <button className="stt-seal" type="button" aria-label="Buka amplop" aria-controls={`${id}-note`} aria-expanded={expanded} tabIndex={expanded ? -1 : 0} inert={expanded} onClick={open}><span aria-hidden="true">U</span></button>
          </div>
          <button ref={toggle} className="stt-toggle" type="button" aria-expanded={expanded} aria-controls={`${id}-note`} onClick={() => expanded ? close() : open()}>{expanded ? "Tutup amplop" : "Buka amplop"}<span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
        </div>
      </div>
      <div className="stt-bottom"><span>Universality</span><div className="stt-links">{legalLinks ?? <a href="https://discord.gg/ruv" target="_blank" rel="noopener noreferrer">Dukungan Discord (tab baru)</a>}</div></div>
    </footer>
  );
}
