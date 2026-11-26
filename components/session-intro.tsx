"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const SESSION_KEY = "roblox-univers:dashboard-intro:seen:v2";
const INTRO_HOLD_MS = 4300;
const FADE_MS = 150;

export function SessionIntro() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const eligible = useRef<boolean | null>(null);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);
  const [fading, setFading] = useState(false);
  const [mountKey, setMountKey] = useState(1);

  const dismiss = useCallback(() => {
    if (!dialogRef.current?.open || fadeTimer.current) return;
    setFading(true);
    fadeTimer.current = setTimeout(() => dialogRef.current?.close(), FADE_MS);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data === "intro-ended") {
        dismiss();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [dismiss]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!dialog || motion.matches) return;
    if (eligible.current === null) {
      eligible.current = false;
      try {
        if (!sessionStorage.getItem(SESSION_KEY)) {
          sessionStorage.setItem(SESSION_KEY, "1");
          eligible.current = true;
        }
      } catch {
        return;
      }
    }
    if (!eligible.current) return;
    setMountKey(Date.now());
    setActive(false);
    setFading(false);
    dialog.showModal();
    const frame = requestAnimationFrame(() => setActive(dialog.open && !motion.matches));
    holdTimer.current = setTimeout(dismiss, INTRO_HOLD_MS);
    const stopMotion = () => { if (motion.matches) dialog.close(); };
    motion.addEventListener("change", stopMotion);
    return () => {
      cancelAnimationFrame(frame);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = null;
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      fadeTimer.current = null;
      motion.removeEventListener("change", stopMotion);
      dialog.close();
    };
  }, [dismiss]);

  return (
    <dialog
      ref={dialogRef}
      className={`session-intro${fading ? " session-intro-fading" : ""}`}
      aria-modal="true"
      aria-labelledby="session-intro-title"
      onCancel={event => { event.preventDefault(); dismiss(); }}
      onClose={event => {
        if (!event.currentTarget.open) {
          setActive(false);
          setFading(false);
        }
      }}
    >
      {active && <div className="session-intro-content" style={{ padding: 0 }}>
        <iframe
          src={`/intro/index.html?t=${mountKey}`}
          title="Roblox Univers Winter Intro"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
          sandbox="allow-scripts allow-same-origin"
        />
        <button
          className="session-intro-skip"
          ref={button => { button?.focus({ preventScroll: true }); }}
          type="button"
          onClick={dismiss}
        >
          Lewati intro
        </button>
      </div>}
    </dialog>
  );
}
