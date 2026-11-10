import { dbAll, dbGet, dbRun } from "./db";
import { maskToken } from "./format";
import { decryptSecret, encryptSecret } from "./secret-box";
import type { SellerCapabilities } from "./seller-payload";
import type { SellerSession } from "./seller-auth";
import { takeProbe, probeSellerLogin } from "./seller-auth";
import { DEFAULT_SELLER_GATEWAY_NAME } from "./seller-name";
import { assertCanManageGateways, scopeOwnerId } from "./scope";
import type { SessionUser } from "./types";
import { isBlockedHost, normalizeBaseUrl } from "./url";

export type GatewayKind = "newapi_admin" | "newapi_seller" | "newapi_supplier";

export type GatewayPublic = {
  id: string;
  name: string;
  baseUrl: string;
  adminUserId: string;
  demo: boolean;
  tokenSet: boolean;
  tokenMasked: string;
  createdAt: number;
  disabled: boolean;
  channelCount: number;
  lastSyncAt: number | null;
  kind: GatewayKind;
  username: string;
  authStatus: string;
  authError: string;
  authCheckedAt: number | null;
  accessExpiresAt: number | null;
  ownerUserId: string | null;
  canWrite: boolean;
  canToggle: boolean;
  canEditRouting: boolean;
  maxChannels: number;
  siteChannelTotal: number;
};

export type GatewaySecret = GatewayPublic & { token: string };

type GatewayRow = {
  id: string;
  name: string;
  base_url: string;
  token_cipher: string;
  admin_user_id: string;
  demo: number;
  disabled?: number;
  channel_count?: number;
  last_sync_at?: number | null;
  created_at: number;
  updated_at: number;
  kind?: string;
  username?: string;
  password_cipher?: string;
  auth_status?: string;
  auth_error?: string;
  auth_checked_at?: number | null;
  access_expires_at?: number | null;
  owner_user_id?: string | null;
  can_write?: number;
  can_toggle?: number;
  can_edit_routing?: number;
  max_channels?: number;
  site_channel_total?: number;
};

function kindOf(row: GatewayRow): GatewayKind {
  if (row.kind === "newapi_seller") return "newapi_seller";
  if (row.kind === "newapi_supplier") return "newapi_supplier";
  return "newapi_admin";
}

function present(row: GatewayRow): GatewayPublic {
  const kind = kindOf(row);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    adminUserId: row.admin_user_id,
    demo: Number(row.demo) === 1,
    tokenSet: kind === "newapi_admin" ? Boolean(row.token_cipher) : Boolean(row.password_cipher),
    tokenMasked: kind === "newapi_seller" ? "" : maskedToken(row),
    createdAt: Number(row.created_at),
    disabled: Number(row.disabled ?? 0) === 1,
    channelCount: Number(row.channel_count ?? 0),
    lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
    kind,
    username: kind === "newapi_seller" ? String(row.username ?? "") : "",
    authStatus: String(row.auth_status ?? ""),
    authError: String(row.auth_error ?? ""),
    authCheckedAt: row.auth_checked_at ? Number(row.auth_checked_at) : null,
    accessExpiresAt: row.access_expires_at ? Number(row.access_expires_at) : null,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    canWrite: Number(row.can_write ?? 1) !== 0,
    canToggle: Number(row.can_toggle ?? 1) !== 0,
    canEditRouting: Number(row.can_edit_routing ?? 0) === 1,
    maxChannels: Number(row.max_channels ?? 0),
    siteChannelTotal: Number(row.site_channel_total ?? 0),
  };
}

function maskedToken(row: GatewayRow): string {
  if (Number(row.demo) === 1 || !row.token_cipher) return "";
  try {
    return maskToken(decryptSecret(row.token_cipher));
  } catch {
    return "";
  }
}

/** Drop the decrypted token before any HTTP response. */
export function publicGateway(gateway: GatewaySecret): GatewayPublic {
  const kind = kindOf(gateway as unknown as GatewayRow);
  return {
    id: gateway.id,
    name: gateway.name,
    baseUrl: gateway.baseUrl,
    adminUserId: kind === "newapi_seller" ? "" : gateway.adminUserId,
    demo: gateway.demo,
    tokenSet: gateway.tokenSet,
    tokenMasked: kind === "newapi_seller" || gateway.demo || !gateway.token ? "" : maskToken(gateway.token),
    createdAt: gateway.createdAt,
    disabled: gateway.disabled,
    channelCount: gateway.channelCount,
    lastSyncAt: gateway.lastSyncAt,
    kind,
    username: kind === "newapi_seller" ? gateway.username ?? "" : "",
    authStatus: gateway.authStatus ?? "",
    authError: gateway.authError ?? "",
    authCheckedAt: gateway.authCheckedAt ?? null,
    accessExpiresAt: gateway.accessExpiresAt ?? null,
    ownerUserId: gateway.ownerUserId ?? null,
    canWrite: gateway.canWrite !== false,
    canToggle: gateway.canToggle !== false,
    canEditRouting: gateway.canEditRouting === true,
    maxChannels: Number(gateway.maxChannels ?? 0),
    siteChannelTotal: Number(gateway.siteChannelTotal ?? 0),
  };
}

export async function listGateways(): Promise<GatewayPublic[]> {
  const rows = (await dbAll(
    `SELECT g.*,
       (SELECT COUNT(*) FROM channels c WHERE c.gateway_id = g.id AND c.created_here = 1) AS channel_count,
       (SELECT MAX(last_sync_at) FROM channels c WHERE c.gateway_id = g.id AND c.created_here = 1) AS last_sync_at
     FROM gateways g ORDER BY g.created_at ASC`,
  )) as GatewayRow[];
  return rows.map(present);
}

export async function setGatewayDisabled(id: string, disabled: boolean): Promise<GatewayPublic | null> {
  const existing = await getGateway(id);
  if (!existing) return null;
  await dbRun("UPDATE gateways SET disabled = ?, updated_at = ? WHERE id = ?", [disabled ? 1 : 0, Date.now(), id]);
  const rows = await listGateways();
  return rows.find((item) => item.id === id) ?? null;
}

export async function getGateway(id: string): Promise<GatewaySecret | null> {
  const row = (await dbGet("SELECT * FROM gateways WHERE id = ?", [id])) as GatewayRow | undefined;
  if (!row) return null;
  return {
    ...present(row),
    token: Number(row.demo) === 1 || !row.token_cipher ? "" : decryptSecret(row.token_cipher),
  };
}

export function validateGatewayInput(input: { name: string; baseUrl: string; adminUserId: string; token?: string; requireToken: boolean }):
  | { ok: true; name: string; baseUrl: string; adminUserId: string; token: string }
  | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name || name.length > 40) return { ok: false, error: "gatewayName" };
  const normalized = normalizeBaseUrl(input.baseUrl);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const host = new URL(normalized.siteBase).hostname;
  if (isBlockedHost(host)) return { ok: false, error: "gatewayBlocked" };
  const adminUserId = input.adminUserId.trim();
  if (!/^\d+$/.test(adminUserId)) return { ok: false, error: "gatewayUserId" };
  const token = (input.token ?? "").trim();
  if (input.requireToken && token.length < 8) return { ok: false, error: "gatewayToken" };
  return { ok: true, name, baseUrl: normalized.siteBase, adminUserId, token };
}

export async function createGateway(input: { name: string; baseUrl: string; adminUserId: string; token: string }): Promise<GatewayPublic> {
  const parsed = validateGatewayInput({ ...input, requireToken: true });
  if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });
  const now = Date.now();
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO gateways (id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [id, parsed.name, parsed.baseUrl, encryptSecret(parsed.token), parsed.adminUserId, now, now],
  );
  const created = await getGateway(id);
  if (!created) throw Object.assign(new Error("gatewaySaveFailed"), { status: 500 });
  return publicGateway(created);
}

export async function updateGateway(
  id: string,
  input: { name: string; baseUrl: string; adminUserId: string; token?: string },
): Promise<GatewayPublic | null> {
  const existing = await getGateway(id);
  if (!existing) return null;
  if (existing.demo) throw Object.assign(new Error("demoGatewayLocked"), { status: 400 });
  const parsed = validateGatewayInput({ ...input, requireToken: false });
  if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });
  const cipher = parsed.token ? encryptSecret(parsed.token) : undefined;
  if (cipher) {
    await dbRun(
      "UPDATE gateways SET name = ?, base_url = ?, admin_user_id = ?, token_cipher = ?, updated_at = ? WHERE id = ?",
      [parsed.name, parsed.baseUrl, parsed.adminUserId, cipher, Date.now(), id],
    );
  } else {
    await dbRun("UPDATE gateways SET name = ?, base_url = ?, admin_user_id = ?, updated_at = ? WHERE id = ?", [
      parsed.name,
      parsed.baseUrl,
      parsed.adminUserId,
      Date.now(),
      id,
    ]);
  }
  const updated = await getGateway(id);
  return updated ? publicGateway(updated) : null;
}

function assertUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized.ok) throw Object.assign(new Error(normalized.error), { status: 400 });
  const host = new URL(normalized.siteBase).hostname;
  if (isBlockedHost(host)) throw Object.assign(new Error("gatewayBlocked"), { status: 400 });
  return normalized.siteBase;
}

export async function saveSellerCapabilities(id: string, caps: SellerCapabilities): Promise<void> {
  await dbRun(
    "UPDATE gateways SET can_write = ?, can_toggle = ?, can_edit_routing = ?, max_channels = ?, site_channel_total = ?, updated_at = ? WHERE id = ?",
    [caps.canWrite ? 1 : 0, caps.canToggle ? 1 : 0, caps.canEditRouting ? 1 : 0, caps.maxChannels, caps.total, Date.now(), id],
  );
}

async function persistSeller(id: string, session: SellerSession, now: number): Promise<void> {
  const { encryptSecret: pack } = await import("./secret-box");
  await dbRun(
    `UPDATE gateways SET access_token_cipher = ?, access_expires_at = ?, refresh_cookie_cipher = ?, session_sid_cipher = ?,
      seller_user_id = ?, auth_status = 'ok', auth_error = '', auth_checked_at = ? WHERE id = ?`,
    [
      session.accessToken ? pack(session.accessToken) : "",
      session.accessExpiresAt,
      session.refreshCookie ? pack(session.refreshCookie) : "",
      session.sid ? pack(session.sid) : "",
      session.userId,
      now,
      id,
    ],
  );
}

export async function createSupplierGateway(
  actor: SessionUser,
  input: { name: string; baseUrl: string; username: string; password: string; probeId?: string; tlsExceptionHost?: string },
): Promise<GatewayPublic> {
  assertCanManageGateways(actor);
  const baseUrl = assertUrl(input.baseUrl);
  const host = new URL(baseUrl).hostname;
  const name = input.name.trim() || `jwt-${host.replace(/[^a-z0-9]+/gi, "-")}`;
  if (name.length > 40) throw Object.assign(new Error("gatewayName"), { status: 400 });
  const username = input.username.trim();
  const password = input.password;
  if (!username || username.length > 80) throw Object.assign(new Error("sellerCredentials"), { status: 400 });
  if (password.length < 1) throw Object.assign(new Error("sellerPassword"), { status: 400 });
  // 单主机 TLS 例外只接受等于 base_url host 的值（计划 §5）；其余输入一律忽略
  const tlsHost = String(input.tlsExceptionHost ?? "").trim().toLowerCase() === host.toLowerCase() ? host : "";
  const { passwordLogin } = await import("./seller-auth");
  const session = await passwordLogin(baseUrl, username, password);
  const now = Date.now();
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO gateways (
      id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, username, password_cipher, owner_user_id, auth_status, tls_exception_host
    ) VALUES (?, ?, ?, '', '', 0, ?, ?, 'newapi_supplier', ?, ?, ?, 'ok', ?)`,
    [id, name, baseUrl, now, now, username, encryptSecret(password), actor.id, tlsHost || null],
  );
  await persistSeller(id, session, now);
  const created = await getGateway(id);
  if (created) {
    // 拉一次 profile：填 supplier_label（创建认领的前缀匹配与设置页展示都靠它）
    await import("./gateway-adapter")
      .then(({ fetchSupplierProfile }) => fetchSupplierProfile(created))
      .catch(() => undefined);
  }
  const fresh = await getGateway(id);
  if (!fresh) throw Object.assign(new Error("gatewaySaveFailed"), { status: 500 });
  return publicGateway(fresh);
}

export async function createSellerGateway(
  actor: SessionUser,
  input: { name: string; baseUrl: string; username: string; password: string; probeId?: string },
): Promise<GatewayPublic> {
  assertCanManageGateways(actor);
  const name = input.name.trim() || DEFAULT_SELLER_GATEWAY_NAME;
  if (name.length > 40) throw Object.assign(new Error("gatewayName"), { status: 400 });
  const baseUrl = assertUrl(input.baseUrl);
  const username = input.username.trim();
  const password = input.password;
  if (!username || username.length > 80) throw Object.assign(new Error("sellerCredentials"), { status: 400 });
  if (password.length < 1) throw Object.assign(new Error("sellerPassword"), { status: 400 });
  const probed = input.probeId ? await takeProbe(input.probeId, { baseUrl, username, password }) : null;
  let session = probed;
  if (!session) {
    const { passwordLogin } = await import("./seller-auth");
    session = await passwordLogin(baseUrl, username, password);
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO gateways (
      id, name, base_url, token_cipher, admin_user_id, demo, created_at, updated_at, kind, username, password_cipher, owner_user_id, auth_status
    ) VALUES (?, ?, ?, '', '', 0, ?, ?, 'newapi_seller', ?, ?, ?, 'ok')`,
    [id, name, baseUrl, now, now, username, encryptSecret(password), actor.id],
  );
  await persistSeller(id, session, now);
  const created = await getGateway(id);
  if (!created) throw Object.assign(new Error("gatewaySaveFailed"), { status: 500 });
  return publicGateway(created);
}

export async function updateSellerGateway(
  actor: SessionUser,
  id: string,
  input: { name: string; baseUrl: string; username: string; password: string; probeId?: string },
): Promise<GatewayPublic | null> {
  assertCanManageGateways(actor);
  const existing = await getGateway(id);
  if (!existing || existing.kind !== "newapi_seller") return null;
  if (actor.role !== "admin" && existing.ownerUserId !== scopeOwnerId(actor)) return null;
  const name = input.name.trim() || existing.name;
  if (!name || name.length > 40) throw Object.assign(new Error("gatewayName"), { status: 400 });
  const baseUrl = assertUrl(input.baseUrl);
  const username = input.username.trim();
  if (!username) throw Object.assign(new Error("sellerCredentials"), { status: 400 });
  const password = input.password;
  if (!password) throw Object.assign(new Error("sellerPassword"), { status: 400 });
  const probed = input.probeId ? await takeProbe(input.probeId, { baseUrl, username, password }) : null;
  let session = probed;
  if (!session) {
    const { passwordLogin } = await import("./seller-auth");
    session = await passwordLogin(baseUrl, username, password);
  }
  const now = Date.now();
  await dbRun(
    `UPDATE gateways SET name = ?, base_url = ?, username = ?, password_cipher = ?,
      access_token_cipher = '', refresh_cookie_cipher = '', session_sid_cipher = '', access_expires_at = NULL, updated_at = ? WHERE id = ?`,
    [name, baseUrl, username, encryptSecret(password), now, id],
  );
  await persistSeller(id, session, now);
  const updated = await getGateway(id);
  return updated ? publicGateway(updated) : null;
}

export async function renewalAlertsFor(actor: SessionUser): Promise<{ id: string; name: string; checkedAt: number | null; expiresAt: number | null; detail: string }[]> {
  if (actor.parentUserId) return [];
  const rows = (await dbAll(
    `SELECT id, name, auth_checked_at, access_expires_at, auth_error FROM gateways
     WHERE kind = 'newapi_seller' AND auth_status = 'failed' AND disabled = 0 AND (? = 'admin' OR owner_user_id = ?)`,
    [actor.role, actor.id],
  )) as { id: string; name: string; auth_checked_at?: number | null; access_expires_at?: number | null; auth_error?: string }[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    checkedAt: row.auth_checked_at ? Number(row.auth_checked_at) : null,
    expiresAt: row.access_expires_at ? Number(row.access_expires_at) : null,
    detail: String(row.auth_error ?? ""),
  }));
}

/** Same gateway list a parent supplier sees. A sub-account uses the parent id in that check. */
export function gatewayVisibleTo(
  actor: Pick<SessionUser, "role" | "id" | "parentUserId">,
  gateway: { kind: string; ownerUserId: string | null },
): boolean {
  if (actor.role === "admin") return true;
  const ownerId = actor.parentUserId || actor.id;
  return gateway.kind !== "newapi_seller" || gateway.ownerUserId === ownerId;
}

export async function listVisibleGateways(actor: SessionUser): Promise<GatewayPublic[]> {
  const all = await listGateways();
  return all.filter((item) => gatewayVisibleTo(actor, item));
}

export async function listOwnSellerGateways(actor: SessionUser): Promise<GatewayPublic[]> {
  const all = await listGateways();
  return all.filter((item) => item.kind === "newapi_seller" && (actor.role === "admin" || item.ownerUserId === actor.id));
}

export async function probeGatewayLogin(input: { baseUrl: string; username: string; password: string }): Promise<{ probeId: string; expiresAt: number; latencyMs: number }> {
  const baseUrl = assertUrl(input.baseUrl);
  const username = input.username.trim();
  if (!username || !input.password) throw Object.assign(new Error("sellerCredentials"), { status: 400 });
  return probeSellerLogin({ baseUrl, username, password: input.password });
}
