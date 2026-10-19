import { requestOrigin } from "@/lib/forwarded";
import { isLocale, LOCALE_COOKIE, negotiateLocale, type Locale } from "@/lib/locale";
import { applySecurityHeaders } from "@/lib/security-headers";
import { sessionGate } from "@/lib/session-access";
import { getIronSession, nextProxyCookies } from "iron-session";
import { NextResponse, type NextRequest } from "next/server";
import { sessionOptions, type SessionData } from "@/lib/session";
import en from "./messages/en.json";
import zh from "./messages/zh-CN.json";

function redirectTo(request: NextRequest, pathname: string, search = ""): NextResponse {
  const url = new URL(pathname, requestOrigin(request));
  if (search) url.search = search;
  return NextResponse.redirect(url);
}

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/health", "/api/locale"]);

function proxyLocale(request: NextRequest, userLocale: string | null | undefined): Locale {
  const cookie = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;
  if (isLocale(userLocale)) return userLocale;
  return negotiateLocale(request.headers.get("accept-language"));
}

function message(locale: Locale, key: "noPublicRegister" | "accountDisabled" | "loginRequired" | "forbidden" | "pageForbidden"): string {
  return (locale === "en" ? en : zh).errors[key];
}

function withSecurity(response: NextResponse): NextResponse {
  applySecurityHeaders(response.headers);
  return response;
}

export async function proxy(request: NextRequest) {
  try {
    const { connection } = await import("next/server");
    await connection();
  } catch {
    // The proxy still has to decide auth when there is no render store.
  }
  const { pathname } = request.nextUrl;
  const locale = proxyLocale(request, null);
  if (pathname === "/register" || pathname === "/api/auth/register") {
    if (pathname.startsWith("/api/")) {
      return withSecurity(NextResponse.json({ error: { message: message(locale, "noPublicRegister") } }, { status: 404, headers: { "cache-control": "no-store" } }));
    }
    return withSecurity(redirectTo(request, "/login"));
  }

  const next = NextResponse.next();
  const session = await getIronSession<SessionData>(nextProxyCookies(request, next), sessionOptions(request.headers));
  const gate = await sessionGate(session.sessionId, session.credentialVersion);
  const user = gate.status === 200 ? gate.user : null;
  const spoken = proxyLocale(request, user?.locale);
  const authed = gate.status === 200;

  if (PUBLIC_PATHS.has(pathname)) {
    if (authed && pathname === "/login") {
      return withSecurity(redirectTo(request, "/channels"));
    }
    return withSecurity(next);
  }

  if (!authed) {
    session.destroy();
    if (pathname.startsWith("/api/")) {
      const denied = NextResponse.json(
        { error: { message: message(spoken, gate.status === 401 && gate.reason === "accountDisabled" ? "accountDisabled" : "loginRequired") } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
      const dying = await getIronSession<SessionData>(nextProxyCookies(request, denied), sessionOptions(request.headers));
      dying.destroy();
      return withSecurity(denied);
    }
    const redirect = redirectTo(request, "/login", gate.status === 401 && gate.reason === "accountDisabled" ? "disabled=1" : "");
    const dying = await getIronSession<SessionData>(nextProxyCookies(request, redirect), sessionOptions(request.headers));
    dying.destroy();
    return withSecurity(redirect);
  }

  if (pathname === "/reconcile") {
    return withSecurity(redirectTo(request, "/recon"));
  }

  const adminApi =
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/api/gateways") ||
    pathname.startsWith("/api/settings");
  if (adminApi && user?.role !== "admin") {
    return withSecurity(NextResponse.json({ error: { message: message(spoken, "forbidden") } }, { status: 403, headers: { "cache-control": "no-store" } }));
  }

  const adminPage = pathname === "/users" || pathname.startsWith("/admin");
  if (adminPage && user?.role !== "admin") {
    const htmlLang = spoken === "en" ? "en-US" : "zh-CN";
    const title = "万事大吉 v2.1";
    const html = `<!DOCTYPE html><html lang="${htmlLang}"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${message(spoken, "pageForbidden")}</h1></body></html>`;
    return withSecurity(new NextResponse(html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }));
  }

  return withSecurity(next);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webp)$).*)"],
};
