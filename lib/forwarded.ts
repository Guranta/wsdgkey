type HeaderStore = { get(name: string): string | null };

function first(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

/** First forwarded protocol, when the header is http or https. */
export function forwardedProto(headers: HeaderStore): "http" | "https" | null {
  const proto = first(headers.get("x-forwarded-proto")).toLowerCase();
  if (proto === "https" || proto === "http") return proto;
  return null;
}

function safeHost(value: string | null): string {
  const host = first(value);
  if (!host || /[\s/\\@]/.test(host)) return "";
  return host;
}

/**
 * Public origin for redirects behind a reverse proxy.
 * Prefers X-Forwarded-Proto and X-Forwarded-Host, then Host.
 */
export function requestOrigin(request: {
  headers: HeaderStore;
  nextUrl: { protocol: string; host: string; origin: string };
}): string {
  const host = safeHost(request.headers.get("x-forwarded-host")) || safeHost(request.headers.get("host"));
  // TLS ends at nginx. Without X-Forwarded-Proto the client spoke HTTP to this process.
  const proto = forwardedProto(request.headers) ?? "http";
  if (host) return `${proto}://${host}`;
  return request.nextUrl.origin;
}

/**
 * Secure cookies when the browser connection is HTTPS.
 * COOKIE_SECURE=1 forces the flag on. COOKIE_SECURE=0 forces it off.
 * Otherwise X-Forwarded-Proto: https (set by nginx) turns it on.
 */
export function cookieSecure(headers: HeaderStore): boolean {
  const flag = process.env.COOKIE_SECURE?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return forwardedProto(headers) === "https";
}
