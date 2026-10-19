"use client";

import { useEffect, useRef, type RefObject } from "react";

export type LoginFaceApi = {
  error: () => void;
  success: (done: () => void) => void;
};

const noop: LoginFaceApi = { error() {}, success(done) { done(); } };

/** 96px login bot. State machine matches the wireframe `LF` object. */
export function LoginFace({
  apiRef,
  userRef,
  passRef,
}: {
  apiRef: RefObject<LoginFaceApi>;
  userRef: RefObject<HTMLInputElement | null>;
  passRef: RefObject<HTMLInputElement | null>;
}) {
  const faceRef = useRef<HTMLDivElement>(null);
  const lookRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const face = faceRef.current;
    const look = lookRef.current;
    const user = userRef.current;
    const pass = passRef.current;
    if (!face || !look || !user || !pass) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const max = 3.4;
    let mode: "idle" | "user" | "pw" | "happy" = "idle";
    let blinkTimer = 0;
    const still = () => media.matches;
    const setLook = (x: number, y: number) => {
      look.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    };
    const onMove = (event: PointerEvent) => {
      if (still() || mode !== "idle" || !face.isConnected || !face.offsetParent) return;
      const box = face.getBoundingClientRect();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 260) * max;
      setLook((dx / distance) * reach, (dy / distance) * reach * 0.8);
    };
    const scheduleBlink = () => {
      window.clearTimeout(blinkTimer);
      if (still()) return;
      blinkTimer = window.setTimeout(() => {
        if (mode === "idle" || mode === "user") {
          face.classList.add("blink");
          window.setTimeout(() => face.classList.remove("blink"), 140);
        }
        scheduleBlink();
      }, 3000 + Math.random() * 3000);
    };
    const setMode = (next: typeof mode) => {
      mode = next;
      face.classList.toggle("pw", next === "pw");
      face.classList.toggle("happy", next === "happy");
      if (next === "user") setLook(0, still() ? 0 : 3);
      else if (next !== "idle") setLook(0, 0);
    };
    const onUser = () => setMode("user");
    const onPass = () => setMode("pw");
    const once = (cls: string, ms: number) => {
      if (still()) return;
      face.classList.remove(cls);
      void face.offsetWidth;
      face.classList.add(cls);
      window.setTimeout(() => face.classList.remove(cls), ms);
    };
    const onBlur = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (mode !== "happy" && active !== user && active !== pass) setMode("idle");
      }, 0);
    };
    apiRef.current = {
      error() { once("shake", 520); },
      success(done) {
        setMode("happy");
        once("hop", 460);
        window.setTimeout(() => { setMode("idle"); done(); }, still() ? 400 : 750);
      },
    };
    document.addEventListener("pointermove", onMove);
    user.addEventListener("focus", onUser);
    pass.addEventListener("focus", onPass);
    user.addEventListener("blur", onBlur);
    pass.addEventListener("blur", onBlur);
    const onReduce = () => { setLook(0, 0); scheduleBlink(); };
    media.addEventListener("change", onReduce);
    scheduleBlink();
    return () => {
      window.clearTimeout(blinkTimer);
      apiRef.current = noop;
      document.removeEventListener("pointermove", onMove);
      user.removeEventListener("focus", onUser);
      pass.removeEventListener("focus", onPass);
      user.removeEventListener("blur", onBlur);
      pass.removeEventListener("blur", onBlur);
      media.removeEventListener("change", onReduce);
    };
  }, [apiRef, userRef, passRef]);

  return (
    <div className="login-face" ref={faceRef} aria-hidden>
      <svg className="lf-svg" width="96" height="96" viewBox="0 0 64 64" focusable="false">
        <g className="lf-body">
          <path fill="#0A0A0A" d="M33 5C49 5 59.5 15.5 59.5 31.5C59.5 48 48.5 59.5 31.5 59.5C15.5 59.5 4.5 49 4.5 32.5C4.5 15.5 17 5 33 5Z" />
          <ellipse fill="#30B0C7" cx="46.5" cy="15.5" rx="4.2" ry="2.4" transform="rotate(35 46.5 15.5)" />
          <g className="lf-look" ref={lookRef}>
            <g className="lf-open" fill="#fff">
              <ellipse cx="24.5" cy="32" rx="5" ry="8.2" />
              <ellipse cx="40.5" cy="32" rx="5" ry="8.2" />
            </g>
            <g className="lf-shut" stroke="#fff" strokeWidth="3" strokeLinecap="round">
              <path d="M20 33H29" />
              <path d="M36 33H45" />
            </g>
            <g className="lf-happy" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round">
              <path d="M19.5 35C19.5 28 29.5 28 29.5 35" />
              <path d="M35.5 35C35.5 28 45.5 28 45.5 35" />
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
