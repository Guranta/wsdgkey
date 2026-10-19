import { normalizeBaseUrl } from "./url";
import { maskToken } from "./format";
import { scrubSecrets } from "./redact";
import { decryptSecret, encryptSecret } from "./secret-box";
import { dbAll, dbGet, dbRun } from "./db";
import type { Connection, ConnectionStatus, SessionUser } from "./types";

const STATUSES = new Set<ConnectionStatus>(["unknown", "ok", "expiring", "failing", "expired"]);

type ConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  site_base: string;
  openai_base: string;
  token_cipher: string;
  demo: number;
  status: string;
  status_detail: string | null;
  last_validated_at: number | null;
  quota_available: number | null;
  quota_used: number | null;
  unlimited_quota: number | null;
  expires_at: number | null;
  credential_updated_at: number;
  created_at: number;
  updated_at: number;
  owner_username: string;
  owner_name: string;
};

function num(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function masked(cipher: string): string {
  try {
    return maskToken(decryptSecret(cipher));
  } catch {
    return "—";
  }
}

function toConnection(row: ConnectionRow, actor: SessionUser): Connection {
  const status = STATUSES.has(row.status as ConnectionStatus) ? (row.status as ConnectionStatus) : "unknown";
  return {
    id: row.id,
    userId: row.user_id,
    ownerUsername: row.owner_username,
    ownerName: row.owner_name,
    owned: row.user_id === actor.id,
    name: row.name,
    siteBase: row.site_base,
    openaiBase: row.openai_base,
    tokenMasked: masked(row.token_cipher),
    demo: Number(row.demo) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    credentialUpdatedAt: Number(row.credential_updated_at),
    lastValidatedAt: num(row.last_validated_at ?? undefined),
    status,
    statusDetail: row.status_detail ?? undefined,
    quotaAvailable: num(row.quota_available ?? undefined),
    quotaUsed: num(row.quota_used ?? undefined),
    unlimitedQuota: row.unlimited_quota === null || row.unlimited_quota === undefined ? undefined : Number(row.unlimited_quota) === 1,
    expiresAt: num(row.expires_at ?? undefined),
  };
}

const SELECT = `SELECT c.*, u.username AS owner_username, u.name AS owner_name
  FROM connections c JOIN users u ON u.id = c.user_id`;

export async function listConnections(actor: SessionUser): Promise<Connection[]> {
  const rows =
    actor.role === "admin"
      ? ((await dbAll(`${SELECT} ORDER BY c.created_at DESC`)) as ConnectionRow[])
      : ((await dbAll(`${SELECT} WHERE c.user_id = ? ORDER BY c.created_at DESC`, [actor.id])) as ConnectionRow[]);
  return rows.map((row) => toConnection(row, actor));
}

export async function getConnection(id: string, actor: SessionUser): Promise<Connection | null> {
  const row = (await dbGet(`${SELECT} WHERE c.id = ?`, [id])) as ConnectionRow | undefined;
  if (!row) return null;
  if (actor.role !== "admin" && row.user_id !== actor.id) return null;
  return toConnection(row, actor);
}

async function getRow(id: string): Promise<ConnectionRow | undefined> {
  return (await dbGet(`${SELECT} WHERE c.id = ?`, [id])) as ConnectionRow | undefined;
}

export async function revealToken(id: string, actor: SessionUser): Promise<string | null> {
  const row = await getRow(id);
  if (!row || row.user_id !== actor.id) return null;
  return decryptSecret(row.token_cipher);
}

export type ConnectionTarget = { siteBase: string; token: string; demo: boolean };

export async function connectionTarget(id: string, actor: SessionUser): Promise<ConnectionTarget | null> {
  const row = await getRow(id);
  if (!row) return null;
  if (actor.role !== "admin" && row.user_id !== actor.id) return null;
  try {
    return { siteBase: row.site_base, token: decryptSecret(row.token_cipher), demo: Number(row.demo) === 1 };
  } catch {
    return null;
  }
}

function cleanToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > 512 || /\s/.test(token)) return null;
  return token;
}

export async function createConnection(
  actor: SessionUser,
  input: { name?: unknown; siteBase?: unknown; token?: unknown; demo?: unknown },
): Promise<{ ok: true; connection: Connection } | { ok: false; error: string }> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  if (!name) return { ok: false, error: "请填写备注名称" };
  const token = cleanToken(input.token);
  if (!token) return { ok: false, error: "请填写令牌" };
  const demo = input.demo === true;
  let siteBase = "demo";
  let openaiBase = "demo/v1";
  if (!demo) {
    if (typeof input.siteBase !== "string") return { ok: false, error: "请填写 New API 地址" };
    const normalized = normalizeBaseUrl(input.siteBase);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    siteBase = normalized.siteBase;
    openaiBase = normalized.openaiBase;
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await dbRun(
    `INSERT INTO connections (
      id, user_id, name, site_base, openai_base, token_cipher, demo, status,
      credential_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`,
    [id, actor.id, name, siteBase, openaiBase, encryptSecret(token), demo ? 1 : 0, now, now, now],
  );
  const connection = await getConnection(id, actor);
  if (!connection) return { ok: false, error: "连接没有保存成功" };
  return { ok: true, connection };
}

export type ConnectionPatch = {
  name?: unknown;
  siteBase?: unknown;
  token?: unknown;
  demo?: unknown;
  status?: unknown;
  statusDetail?: unknown;
  quotaAvailable?: unknown;
  quotaUsed?: unknown;
  unlimitedQuota?: unknown;
  expiresAt?: unknown;
  touchValidated?: unknown;
};

export async function updateConnection(
  id: string,
  actor: SessionUser,
  patch: ConnectionPatch,
): Promise<{ ok: true; connection: Connection } | { ok: false; error: string; status: number }> {
  const row = await getRow(id);
  if (!row || (actor.role !== "admin" && row.user_id !== actor.id)) return { ok: false, error: "连接不存在", status: 404 };
  const owner = row.user_id === actor.id;
  const wantsCredential =
    patch.name !== undefined || patch.siteBase !== undefined || patch.token !== undefined || patch.demo !== undefined;
  if (wantsCredential && !owner) return { ok: false, error: "只能修改自己的连接", status: 403 };

  let name = row.name;
  let siteBase = row.site_base;
  let openaiBase = row.openai_base;
  let cipher = row.token_cipher;
  let demo = Number(row.demo) === 1;
  let credentialUpdatedAt = Number(row.credential_updated_at);
  const now = Date.now();

  if (owner && patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) return { ok: false, error: "请填写备注名称", status: 400 };
    name = patch.name.trim().slice(0, 80);
  }
  if (owner && patch.demo !== undefined) demo = patch.demo === true;
  if (owner && demo) {
    siteBase = "demo";
    openaiBase = "demo/v1";
  } else if (owner && patch.siteBase !== undefined) {
    if (typeof patch.siteBase !== "string") return { ok: false, error: "请填写 New API 地址", status: 400 };
    const normalized = normalizeBaseUrl(patch.siteBase);
    if (!normalized.ok) return { ok: false, error: normalized.error, status: 400 };
    siteBase = normalized.siteBase;
    openaiBase = normalized.openaiBase;
  }
  if (owner && patch.token !== undefined && patch.token !== "") {
    const token = cleanToken(patch.token);
    if (!token) return { ok: false, error: "令牌格式不正确", status: 400 };
    cipher = encryptSecret(token);
    credentialUpdatedAt = now;
  }
  if (owner && (patch.siteBase !== undefined || patch.demo !== undefined || patch.name !== undefined)) {
    if (siteBase !== row.site_base || demo !== (Number(row.demo) === 1) || name !== row.name) credentialUpdatedAt = now;
  }

  let status = row.status;
  let statusDetail = row.status_detail;
  let lastValidatedAt = row.last_validated_at;
  let quotaAvailable = row.quota_available;
  let quotaUsed = row.quota_used;
  let unlimitedQuota = row.unlimited_quota;
  let expiresAt = row.expires_at;

  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status as ConnectionStatus)) return { ok: false, error: "状态不正确", status: 400 };
    status = patch.status as string;
    lastValidatedAt = now;
  }
  if (patch.statusDetail !== undefined) {
    const detail = typeof patch.statusDetail === "string" ? patch.statusDetail : "";
    let plain = "";
    try {
      plain = decryptSecret(cipher);
    } catch {
      plain = "";
    }
    statusDetail = scrubSecrets(detail, plain ? [plain] : []).slice(0, 180) || null;
  }
  if (patch.quotaAvailable !== undefined) quotaAvailable = typeof patch.quotaAvailable === "number" ? patch.quotaAvailable : null;
  if (patch.quotaUsed !== undefined) quotaUsed = typeof patch.quotaUsed === "number" ? patch.quotaUsed : null;
  if (patch.unlimitedQuota !== undefined) unlimitedQuota = patch.unlimitedQuota === true ? 1 : patch.unlimitedQuota === false ? 0 : null;
  if (patch.expiresAt !== undefined) expiresAt = typeof patch.expiresAt === "number" ? patch.expiresAt : null;

  await dbRun(
    `UPDATE connections SET
      name = ?, site_base = ?, openai_base = ?, token_cipher = ?, demo = ?, status = ?, status_detail = ?,
      last_validated_at = ?, quota_available = ?, quota_used = ?, unlimited_quota = ?, expires_at = ?,
      credential_updated_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      name,
      siteBase,
      openaiBase,
      cipher,
      demo ? 1 : 0,
      status,
      statusDetail,
      lastValidatedAt,
      quotaAvailable,
      quotaUsed,
      unlimitedQuota,
      expiresAt,
      credentialUpdatedAt,
      now,
      id,
    ],
  );
  const connection = await getConnection(id, actor);
  if (!connection) return { ok: false, error: "连接不存在", status: 404 };
  return { ok: true, connection };
}

export async function deleteConnection(id: string, actor: SessionUser): Promise<boolean> {
  const row = await getRow(id);
  if (!row || row.user_id !== actor.id) return false;
  await dbRun("DELETE FROM connections WHERE id = ?", [id]);
  return true;
}
