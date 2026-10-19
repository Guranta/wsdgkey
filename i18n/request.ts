import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, resolveLocale, type Locale } from "@/lib/locale";

export default getRequestConfig(async () => {
  let saved: Locale | null = null;
  try {
    const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (isLocale(chosen)) saved = chosen;
  } catch {
    saved = null;
  }
  if (!saved) {
    try {
      const { currentUser } = await import("@/lib/current-user");
      const user = await currentUser();
      if (isLocale(user?.locale)) saved = user.locale;
    } catch {
      saved = null;
    }
  }
  let locale: Locale = "zh-CN";
  try {
    locale = resolveLocale(saved, (await headers()).get("accept-language"));
  } catch {
    locale = saved ?? "zh-CN";
  }
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
