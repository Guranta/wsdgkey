"use client";

import { canonicalLocale, type Locale } from "@/lib/locale";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LocaleToggle() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const router = useRouter();

  async function choose(next: Locale) {
    if (next === locale) return;
    window.localStorage.setItem("shq-lang", next === "en" ? "en-US" : "zh-CN");
    await fetch("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: next }),
    });
    router.refresh();
  }

  return (
    <div className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-input px-1 py-0.5 text-xs" role="group" aria-label={t("label")}>
      <button type="button" className={locale === "zh-CN" ? "rounded-full bg-card px-2 py-1 font-semibold text-foreground shadow-sm" : "rounded-full px-2 py-1 text-secondary"} aria-pressed={locale === "zh-CN"} onClick={() => void choose("zh-CN")}>
        {t("zh")}
      </button>
      <span className="px-0.5 text-muted" aria-hidden>|</span>
      <button type="button" className={locale === "en" ? "rounded-full bg-card px-2 py-1 font-semibold text-foreground shadow-sm" : "rounded-full px-2 py-1 text-secondary"} aria-pressed={locale === "en"} onClick={() => void choose("en")}>
        {t("en")}
      </button>
    </div>
  );
}

/** A saved choice in localStorage overrides Accept-Language when no cookie is set yet. */
export function LocaleSync() {
  const locale = useLocale();
  const router = useRouter();
  useEffect(() => {
    const htmlLang = locale === "en" ? "en-US" : "zh-CN";
    document.documentElement.lang = htmlLang;
    window.localStorage.setItem("shq-lang", htmlLang);
  }, [locale]);
  useEffect(() => {
    const stored = canonicalLocale(window.localStorage.getItem("shq-lang") ?? window.localStorage.getItem("locale"));
    if (!stored) return;
    const hasCookie = document.cookie.split("; ").some((item) => item.startsWith("locale="));
    if (hasCookie) return;
    void fetch("/api/locale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: stored }),
    }).then(() => router.refresh());
  }, [router]);
  return null;
}
