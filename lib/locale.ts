export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "locale";

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

/**
 * Explicit locale from the client. zh / zh-CN / zh-Hans and en / en-US collapse
 * to the two locales this app ships. Anything else is unsupported.
 */
export function canonicalLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return null;
  const primary = tag.split("-")[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en";
  return null;
}

/**
 * Browser default only. A saved choice (cookie or account) overrides this.
 * The highest-quality tag that we understand wins: en* → en, everything else → zh-CN.
 * Tags we do not offer (for example fr) are skipped so a later en* can still match.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  const ranked = String(header ?? "")
    .split(",")
    .map((part, index) => {
      const [tagRaw, ...params] = part.trim().split(";");
      const qRaw = params.map((item) => item.trim()).find((item) => item.startsWith("q="));
      const q = qRaw ? Number(qRaw.slice(2)) : 1;
      return { tag: tagRaw.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((item) => item.tag)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const item of ranked) {
    if (item.tag.startsWith("zh")) return "zh-CN";
    if (item.tag.startsWith("en")) return "en";
  }
  return "zh-CN";
}

/** Saved choice first. Otherwise en* from Accept-Language, and every other language is zh-CN. */
export function resolveLocale(saved: unknown, acceptLanguage: string | null | undefined): Locale {
  return isLocale(saved) ? saved : negotiateLocale(acceptLanguage);
}

export function localeCookieHeader(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
