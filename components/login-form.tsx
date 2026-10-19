"use client";

import { AuthScreen } from "@/components/auth-screen";
import { LoginFace, type LoginFaceApi } from "@/components/login-face";
import { BrandWord } from "@/components/logo-mark";
import { buttonClass, fieldClass } from "@/components/ui";
import { isLocale } from "@/lib/locale";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(params.get("disabled") === "1" ? t("disabled") : "");
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const faceApi = useRef<LoginFaceApi>({ error() {}, success(done) { done(); } });

  async function onSubmit() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message || t("failed"));
        setBusy(false);
        faceApi.current.error();
        return;
      }
      const body = (await res.json().catch(() => null)) as { locale?: string } | null;
      if (isLocale(body?.locale)) window.localStorage.setItem("locale", body.locale);
      faceApi.current.success(() => {
        router.refresh();
        router.push("/channels");
      });
    } catch {
      setError(t("failed"));
      setBusy(false);
      faceApi.current.error();
    }
  }

  return (
    <AuthScreen>
      <section className="rounded-[20px] border-0 bg-card px-6 pb-7 pt-8 shadow-[var(--shadow-card)] md:px-8 md:pt-10">
        <LoginFace apiRef={faceApi} userRef={userRef} passRef={passRef} />
        <div className="mb-2.5 text-center">
          <BrandWord className="text-[18px] leading-6 tracking-[0.06em] text-secondary" />
        </div>
        <h1 className="mb-2 text-center text-[28px] font-bold leading-tight text-foreground">{t("title")}</h1>
        <p className="mb-7 text-center text-sm text-muted">{t("subtitle")}</p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1.5 block text-secondary">{t("username")}</span>
            <input ref={userRef} className={fieldClass} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-secondary">{t("password")}</span>
            <span className="relative block">
              <input
                ref={passRef}
                className={`${fieldClass} pr-14`}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-muted hover:text-foreground"
                aria-label={showPassword ? t("hide") : t("show")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? t("hide") : t("show")}
              </button>
            </span>
          </label>
          <button type="submit" className={buttonClass("primary", "w-full")} disabled={busy}>
            {busy ? t("submitting") : t("submit")}
          </button>
          {error ? <div role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] font-medium text-danger">{error}</div> : null}
        </form>
        <p className="mt-5 text-center text-[13px] text-muted">{t("contact")}</p>
      </section>
    </AuthScreen>
  );
}
