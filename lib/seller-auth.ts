import { Agent, fetch as undiciFetch } from "undici";
import { dbAll, dbRun } from "./db";
import { scrubSecrets } from "./redact";
import { decryptSecret, encryptSecret } from "./secret-box";

/** Renew while more than this remains. Shorter than that, refresh before the call. */
export const SELLER_RENEW_WITHIN_MS = 60_000;
/** Password logins per gateway per hour. Refresh does not count. */
export const SELLER_LOGIN_LIMIT = 3;
const LOGIN_WINDOW_MS = 60 * 60 * 1000;
const PROBE_TTL_MS = 10 * 60 * 1000;

export type SellerSession = {
  accessToken: string;
  accessExpiresAt: number;
  sid: string;
  refreshCookie: string;
  userId: string;
};

export type AuthClass = "ok" | "mfa" | "captcha" | "credentials" | "unauthorized" | "other";

type Fetcher = typeof fetch;

let laxTlsAgent: Agent | null = null;

/** 单主机 TLS 例外（docs/plans/2026-11-05-supplier-jwt-gateway.md §5）：仅当请求 URL 的
 *  host 等于例外主机时注入忽略证书校验的 dispatcher；其他主机仍严格校验。
 *  禁止全局 NODE_TLS_REJECT_UNAUTHORIZED=0。例外主机与 base_url 不一致时不会命中任何请求。 */
export function tlsExceptionFetcher(host: string | null | undefined): Fetcher {
  const target = String(host ?? "").trim().toLowerCase();
  if (!target) return fetch;
  if (!laxTlsAgent) laxTlsAgent = new Agent({ connect: { rejectUnauthorized: false } });
  const agent = laxTlsAgent;
  const wrapped: Fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    if (url.hostname.toLowerCase() !== target) return fetch(input, init);
    // 命中例外主机时整条请求走 npm undici 的 fetch + 同源 Agent；
    // Node 内置 fetch 不认另一份 undici 的 dispatcher，会报 network 错。
    const response = await undiciFetch(url.toString(), { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  }) as Fetcher;
  return wrapped;
}

async function gatewayFetcher(gatewayId: string): Promise<Fetcher> {
  const row = await loadRow(gatewayId);
  return tlsExceptionFetcher(String(row?.tls_exception_host ?? ""));
}

const locks = new Map<string, Promise<unknown>>();
const probes = new Map<string, { baseUrl: string; username: string; passwordHash: string; session: SellerSession; expiresAt: number }>();

export function withGatewayLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(task, task);
  locks.set(id, run.then(() => undefined, () => undefined));
  return run;
}

export function tokenNeedsRefresh(expiresAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return expiresAt - now < SELLER_RENEW_WITHIN_MS;
}

export function refreshCookieFromHeaders(headers: Headers): string | null {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const blob = lines.length ? lines.join("\n") : headers.get("set-cookie") ?? "";
  const match = /(?:^|[\n,]\s*)new_api_refresh=([^;\n]+)/i.exec(blob);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
}

function dataOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const data = (body as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function messageOf(body: unknown): string {
  if (!body || typeof body !== "object" || !("message" in body)) return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message.slice(0, 300) : "";
}

/** MFA and captcha are not wrong-password. Callers must not retry them as credentials. */
export function classifyAuthBody(status: number, body: unknown): AuthClass {
  const data = dataOf(body);
  const message = messageOf(body);
  if (data.mfa_setup_required === true || data.require_2fa === true || data.need_2fa === true || data.two_factor_required === true) return "mfa";
  if (/turnstile|captcha|recaptcha|验证码/i.test(message)) return "captcha";
  if (/2fa|mfa|两步|二次验证|totp|authenticator/i.test(message)) return "mfa";
  const token = typeof data.access_token === "string" ? data.access_token : "";
  if (token && status < 400) return "ok";
  if (/密码|password|credential|用户名或密码|invalid username/i.test(message) || status === 401 || status === 403) return "credentials";
  return status === 401 ? "unauthorized" : "other";
}

export function authErrorKey(kind: AuthClass): string {
  if (kind === "mfa" || kind === "captcha") return "sellerMfa";
  if (kind === "credentials" || kind === "unauthorized") return "sellerCredentials";
  return "sellerAuthFailed";
}

function expiryMs(value: unknown, now: number): number {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return now + 15 * 60 * 1000;
  return raw > 1e12 ? raw : raw * 1000;
}

export function sessionFromLogin(body: unknown, cookie: string | null, now = Date.now()): SellerSession | null {
  const data = dataOf(body);
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) return null;
  const session = data.session && typeof data.session === "object" ? (data.session as Record<string, unknown>) : {};
  const sid = typeof session.sid === "string" ? session.sid : "";
  const user = data.user && typeof data.user === "object" ? (data.user as Record<string, unknown>) : {};
  const userId = user.id === undefined || user.id === null ? "" : String(user.id);
  return {
    accessToken,
    accessExpiresAt: expiryMs(data.access_expires_at, now),
    sid,
    refreshCookie: cookie ?? "",
    userId,
  };
}

function pack(value: string): string {
  return value ? encryptSecret(value) : "";
}

function unpack(value: string): string {
  if (!value) return "";
  try {
    return decryptSecret(value);
  } catch {
    return "";
  }
}

async function hashPassword(password: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(password).digest("hex");
}

export async function countPasswordLogins(gatewayKey: string, now = Date.now()): Promise<number> {
  const row = await dbAll(
    "SELECT COUNT(*) AS n FROM seller_login_attempts WHERE gateway_key = ? AND attempted_at >= ?",
    [gatewayKey, now - LOGIN_WINDOW_MS],
  );
  return Number(row[0]?.n ?? 0);
}

async function recordPasswordLogin(gatewayKey: string, now: number): Promise<void> {
  await dbRun("INSERT INTO seller_login_attempts (gateway_key, attempted_at) VALUES (?, ?)", [gatewayKey, now]);
}

export function loginKey(baseUrl: string, username: string): string {
  return `${baseUrl}|${username}`.slice(0, 300);
}

type SellerRow = {
  id: string;
  base_url: string;
  username: string;
  password_cipher: string;
  refresh_cookie_cipher: string;
  session_sid_cipher: string;
  access_token_cipher: string;
  access_expires_at: number | null;
  tls_exception_host?: string | null;
};

async function loadRow(id: string): Promise<SellerRow | null> {
  const { dbGet } = await import("./db");
  const row = await dbGet("SELECT * FROM gateways WHERE id = ?", [id]);
  if (!row) return null;
  return row as SellerRow;
}

async function storeSession(id: string, session: SellerSession, now: number): Promise<void> {
  await dbRun(
    `UPDATE gateways SET access_token_cipher = ?, access_expires_at = ?, refresh_cookie_cipher = ?, session_sid_cipher = ?,
      seller_user_id = ?, auth_status = 'ok', auth_error = '', auth_checked_at = ?, updated_at = ? WHERE id = ?`,
    [pack(session.accessToken), session.accessExpiresAt, pack(session.refreshCookie), pack(session.sid), session.userId, now, now, id],
  );
}

async function markFailed(id: string, errorKey: string, now: number): Promise<void> {
  await dbRun(
    "UPDATE gateways SET auth_status = 'failed', auth_error = ?, auth_checked_at = ?, updated_at = ? WHERE id = ?",
    [errorKey.slice(0, 300), now, now, id],
  );
}

function safeMessage(message: string, secrets: string[]): string {
  return scrubSecrets(message, secrets).replace(/[\r\n]/g, " ").slice(0, 200);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function siteFetch(baseUrl: string, path: string, init: RequestInit, fetcher: Fetcher): Promise<{ response: Response; body: unknown }> {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl.replace(/\/$/, "")}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: controller.signal, cache: "no-store", redirect: "manual" });
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    console.info(`upstream ${aborted ? "timeout" : "network"} ${url.pathname}`);
    throw Object.assign(new Error(aborted ? "上游超时" : "无法连接网关"), { status: 0, retryable: true });
  } finally {
    clearTimeout(timer);
  }
  console.info(`upstream ${response.status} ${url.pathname}`);
  if (response.status >= 300 && response.status < 400) {
    throw Object.assign(new Error("网关返回了重定向"), { status: response.status, retryable: false });
  }
  const body = await readJson(response);
  return { response, body };
}

export async function passwordLogin(baseUrl: string, username: string, password: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<SellerSession> {
  const key = loginKey(baseUrl, username);
  const used = await countPasswordLogins(key, now);
  if (used >= SELLER_LOGIN_LIMIT) {
    throw Object.assign(new Error("sellerLoginCapped"), { status: 429 });
  }
  await recordPasswordLogin(key, now);
  const { response, body } = await siteFetch(
    baseUrl,
    "/api/user/login",
    { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ username, password }) },
    fetcher,
  );
  const kind = classifyAuthBody(response.status, body);
  if (kind === "mfa" || kind === "captcha") throw Object.assign(new Error("sellerMfa"), { status: 400 });
  const cookie = refreshCookieFromHeaders(response.headers);
  const session = kind === "ok" ? sessionFromLogin(body, cookie, now) : null;
  if (!session) {
    const keyName = authErrorKey(kind);
    const site = safeMessage(messageOf(body), [password]);
    throw Object.assign(new Error(keyName === "sellerAuthFailed" && site ? site : keyName), { status: response.ok ? 400 : response.status || 400 });
  }
  return session;
}

async function refreshLogin(baseUrl: string, cookie: string, sid: string, fetcher: Fetcher, now: number): Promise<SellerSession> {
  const headers = new Headers({ accept: "application/json" });
  if (cookie) headers.set("cookie", `new_api_refresh=${cookie}`);
  if (sid) headers.set("x-auth-session", sid);
  // 供应商 JWT 站的刷新要求站点自身 Origin（缺省会 403 AUTH_ORIGIN_FORBIDDEN）；带上站点自己的 origin 对所有站点都是浏览器同站行为
  const origin = baseUrl.replace(/\/+$/, "");
  headers.set("origin", origin);
  headers.set("referer", `${origin}/`);
  const { response, body } = await siteFetch(baseUrl, "/api/user/auth/refresh", { method: "POST", headers }, fetcher);
  if (response.status === 401) throw Object.assign(new Error("refreshUnauthorized"), { status: 401 });
  const kind = classifyAuthBody(response.status, body);
  if (kind === "mfa" || kind === "captcha") throw Object.assign(new Error("sellerMfa"), { status: 400 });
  const nextCookie = refreshCookieFromHeaders(response.headers) ?? cookie;
  const session = sessionFromLogin(body, nextCookie, now);
  if (!session) throw Object.assign(new Error(authErrorKey(kind)), { status: response.status || 400 });
  return session;
}

export async function ensureSellerAccess(gatewayId: string, options: { now?: number; force?: boolean; fetcher?: Fetcher } = {}): Promise<string> {
  const now = options.now ?? Date.now();
  return withGatewayLock(gatewayId, async () => {
    const row = await loadRow(gatewayId);
    if (!row) throw Object.assign(new Error("gatewayMissing"), { status: 404 });
    const fetcher = options.fetcher ?? tlsExceptionFetcher(String(row.tls_exception_host ?? ""));
    const cached = unpack(String(row.access_token_cipher ?? ""));
    const expiresAt = Number(row.access_expires_at ?? 0);
    if (!options.force && cached && !tokenNeedsRefresh(expiresAt, now)) return cached;
    const cookie = unpack(String(row.refresh_cookie_cipher ?? ""));
    const sid = unpack(String(row.session_sid_cipher ?? ""));
    const password = unpack(String(row.password_cipher ?? ""));
    try {
      if (cookie && sid) {
        const session = await refreshLogin(row.base_url, cookie, sid, fetcher, now);
        await storeSession(gatewayId, session, now);
        return session.accessToken;
      }
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 0;
      const message = error instanceof Error ? error.message : "";
      if (message === "sellerMfa" || message === "sellerLoginCapped") {
        await markFailed(gatewayId, message, now);
        throw error;
      }
      // 401 未授权、403 Access denied（含 Origin 被拒/会话被新登录顶掉）都回退密码重登（计划 §4）；
      // 其余（网络等）也交给 passwordLogin 再试一次，失败由小时级登录上限兜底
      if (status === 0 || status >= 500) {
        const text = safeMessage(message, [password, cached, cookie, sid]);
        await markFailed(gatewayId, text || "sellerAuthFailed", now);
        throw error;
      }
    }
    try {
      const session = await passwordLogin(row.base_url, String(row.username ?? ""), password, fetcher, now);
      await storeSession(gatewayId, session, now);
      return session.accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : "sellerAuthFailed";
      await markFailed(gatewayId, safeMessage(message, [password]), now);
      throw error;
    }
  });
}

export async function sellerRequest(gatewayId: string, baseUrl: string, path: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<unknown> {
  if (fetcher === fetch) fetcher = await gatewayFetcher(gatewayId);
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    const { response, body } = await siteFetch(baseUrl, path, { ...init, headers }, fetcher);
    if (response.status === 429 || response.status >= 500) {
      throw Object.assign(new Error("网关繁忙"), { status: response.status, retryable: true, retryAfter: null });
    }
    if (response.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
    if (response.status === 403) {
      const message = safeMessage(messageOf(body) || "Access denied", [token]);
      throw Object.assign(new Error(message), { status: 403, retryable: false });
    }
    if (!response.ok) {
      const message = safeMessage(messageOf(body) || "网关拒绝了请求", [token]);
      throw Object.assign(new Error(message), { status: response.status, retryable: false });
    }
    const success = body && typeof body === "object" && "success" in body ? (body as { success?: boolean }).success : true;
    if (success === false) {
      const message = safeMessage(messageOf(body) || "网关返回失败", [token]);
      throw Object.assign(new Error(message), { status: 400, retryable: false });
    }
    return body;
  };
  const token = await ensureSellerAccess(gatewayId, { fetcher });
  try {
    return await send(token);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) : 0;
    if (status !== 401 && status !== 403) throw error;
    const next = await ensureSellerAccess(gatewayId, { fetcher, force: true });
    try {
      return await send(next);
    } catch (again) {
      const againStatus = typeof again === "object" && again && "status" in again ? Number((again as { status?: number }).status) : 0;
      if (againStatus === 401) throw Object.assign(new Error("sellerAuthFailed"), { status: 401 });
      if (againStatus === 403) {
        const message = again instanceof Error && again.message ? again.message : "sellerAuthFailed";
        throw Object.assign(new Error(message), { status: 403 });
      }
      throw again;
    }
  }
}

export async function probeSellerLogin(input: { baseUrl: string; username: string; password: string }, fetcher: Fetcher = fetch, now = Date.now()): Promise<{ probeId: string; expiresAt: number; latencyMs: number }> {
  const started = now;
  const session = await passwordLogin(input.baseUrl, input.username, input.password, fetcher, now);
  const probeId = crypto.randomUUID();
  probes.set(probeId, {
    baseUrl: input.baseUrl,
    username: input.username,
    passwordHash: await hashPassword(input.password),
    session,
    expiresAt: now + PROBE_TTL_MS,
  });
  return { probeId, expiresAt: session.accessExpiresAt, latencyMs: Math.max(1, Date.now() - started) };
}

export async function takeProbe(probeId: string, input: { baseUrl: string; username: string; password: string }, now = Date.now()): Promise<SellerSession | null> {
  const probe = probes.get(probeId);
  if (!probe || probe.expiresAt < now) return null;
  if (probe.baseUrl !== input.baseUrl || probe.username !== input.username) return null;
  if (probe.passwordHash !== (await hashPassword(input.password))) return null;
  probes.delete(probeId);
  return probe.session;
}

export function resetSellerAuthForTests(): void {
  locks.clear();
  probes.clear();
}
