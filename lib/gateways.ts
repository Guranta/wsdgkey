import { dbAll, dbGet, dbRun } from "./db";
import { maskToken } from "./format";
import { decryptSecret, encryptSecret } from "./secret-box";
import { isBlockedHost, normalizeBaseUrl } from "./url";

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
};

function present(row: GatewayRow): GatewayPublic {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    adminUserId: row.admin_user_id,
    demo: Number(row.demo) === 1,
    tokenSet: Boolean(row.token_cipher),
    tokenMasked: maskedToken(row),
    createdAt: Number(row.created_at),
    disabled: Number(row.disabled ?? 0) === 1,
    channelCount: Number(row.channel_count ?? 0),
    lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
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
  return {
    id: gateway.id,
    name: gateway.name,
    baseUrl: gateway.baseUrl,
    adminUserId: gateway.adminUserId,
    demo: gateway.demo,
    tokenSet: gateway.tokenSet,
    tokenMasked: gateway.demo || !gateway.token ? "" : maskToken(gateway.token),
    createdAt: gateway.createdAt,
    disabled: gateway.disabled,
    channelCount: gateway.channelCount,
    lastSyncAt: gateway.lastSyncAt,
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
    token: Number(row.demo) === 1 ? "" : decryptSecret(row.token_cipher),
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
