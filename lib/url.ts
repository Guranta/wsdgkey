export type NormalizedBase = {
  siteBase: string;
  openaiBase: string;
};

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.google",
  "fd00:ec2::254",
]);

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return BLOCKED_HOSTS.has(host);
}

export function normalizeBaseUrl(
  input: string,
): ({ ok: true } & NormalizedBase) | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "gatewayBaseRequired" };
  if (trimmed.length > 500) return { ok: false, error: "baseUrlTooLong" };
  if (/[\s\r\n]/.test(trimmed)) return { ok: false, error: "baseUrlSpaces" };

  let withProto = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(withProto)) {
    withProto = `https://${withProto}`;
  }

  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return { ok: false, error: "baseUrlInvalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "baseUrlProtocol" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "gatewayCredentials" };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "gatewayQuery" };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, error: "gatewayBlocked" };
  }

  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";
  if (path.endsWith("/v1")) {
    path = path.slice(0, -3).replace(/\/+$/, "");
  }

  const siteBase = `${url.protocol}//${url.host}${path}`;
  return { ok: true, siteBase, openaiBase: `${siteBase}/v1` };
}

export function joinUpstream(siteBaseInput: string, proxyPath: string, search = ""): URL {
  const normalized = normalizeBaseUrl(siteBaseInput);
  if (!normalized.ok) throw new Error(normalized.error);
  const suffix = proxyPath.replace(/^\/+/, "");
  const url = new URL(`${normalized.siteBase}/${suffix}`);
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of params) {
    if (/token|key|secret|password|auth/i.test(key)) continue;
    url.searchParams.append(key, value);
  }
  return url;
}

export function hostAllowed(hostname: string, configured: string | undefined): boolean {
  if (isBlockedHost(hostname)) return false;
  const raw = configured?.trim();
  if (!raw) return true;
  const allow = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(hostname.toLowerCase());
}
