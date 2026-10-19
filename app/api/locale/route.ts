import { apiError } from "@/lib/api-error";
import { currentUser } from "@/lib/current-user";
import { readJson } from "@/lib/http";
import { canonicalLocale, localeCookieHeader } from "@/lib/locale";
import { setUserLocale } from "@/lib/users";

export async function POST(req: Request) {
  const body = (await readJson(req)) as { locale?: unknown } | null;
  const locale = canonicalLocale(body?.locale);
  if (!locale) return apiError("localeUnsupported", 400);
  const user = await currentUser();
  if (user) await setUserLocale(user.id, locale);
  return Response.json(
    { locale },
    { headers: { "cache-control": "no-store", "set-cookie": localeCookieHeader(locale) } },
  );
}
