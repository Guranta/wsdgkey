import { closeOldSegment } from "./billing-math";
import { dbAll, dbGet, dbRun } from "./db";
import { shanghaiClock, shanghaiMidnight } from "./shanghai";
import type { SessionUser } from "./types";

export type RebindDeps = {
  fetchChannel: (gatewayId: string, upstreamId: number) => Promise<{ usedQuota: number } | null>;
  logQuota: (gatewayId: string, upstreamId: number, startMs: number, endMs: number) => Promise<number | null>;
  now?: () => number;
};

export type RebindResult = {
  recordId: string;
  from: number;
  to: number;
  snapshot: number;
  closeQuota: number | null;
  closeStatus: "amount" | "unsynced";
};

type Holder = { record_id: string; name: string; owner: string };

function fail(message: string, status: number, values?: Record<string, string | number>): Error {
  return Object.assign(new Error(message), { status, values });
}

async function audit(actor: SessionUser, channelId: string, upstreamId: number, action: string, detail: string): Promise<void> {
  await dbRun(
    `INSERT INTO channel_audits (id, actor_user_id, channel_id, upstream_id, action, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, 'ok', ?, ?)`,
    [crypto.randomUUID(), actor.id, channelId, upstreamId, action, detail.slice(0, 300), Date.now()],
  );
}

export async function ensureBinding(recordId: string, gatewayId: string, upstreamId: number, snapshot: number, now = Date.now()): Promise<void> {
  const active = await dbGet("SELECT id FROM channel_bindings WHERE record_id = ? AND unbound_at IS NULL", [recordId]);
  if (active) return;
  await dbRun(
    `INSERT INTO channel_bindings (id, record_id, gateway_id, newapi_channel_id, bound_at, reason, bind_snapshot)
     VALUES (?, ?, ?, ?, ?, 'create', ?)`,
    [crypto.randomUUID(), recordId, gatewayId, upstreamId, now, snapshot],
  );
}

async function holderOf(gatewayId: string, upstreamId: number): Promise<Holder | undefined> {
  return (await dbGet(
    `SELECT b.record_id, c.name, COALESCE(u.name, '') AS owner
     FROM channel_bindings b
     JOIN channels c ON c.id = b.record_id
     LEFT JOIN users u ON u.id = c.creator_user_id
     WHERE b.gateway_id = ? AND b.newapi_channel_id = ? AND b.unbound_at IS NULL`,
    [gatewayId, upstreamId],
  )) as Holder | undefined;
}

/**
 * Point one local channel record at a different new-api channel id on the same gateway.
 * The local id and its supplier stay put. A new-api id can have only one active binding.
 */
export async function rebindChannel(actor: SessionUser, recordId: string, newapiChannelId: number, deps: RebindDeps): Promise<RebindResult> {
  if (actor.role !== "admin") throw fail("forbidden", 403);
  if (!Number.isInteger(newapiChannelId) || newapiChannelId <= 0) throw fail("bindingTargetMissing", 404);
  const row = (await dbGet(
    `SELECT c.*, u.name AS owner_name FROM channels c LEFT JOIN users u ON u.id = c.creator_user_id WHERE c.id = ?`,
    [recordId],
  )) as Record<string, unknown> | undefined;
  if (!row || Number(row.created_here) !== 1) throw fail("notFound", 404);
  const gatewayId = String(row.gateway_id);
  const from = Number(row.upstream_id);
  const now = deps.now?.() ?? Date.now();
  if (from === newapiChannelId && Number(row.upstream_missing) !== 1) throw fail("bindingSame", 409);

  const fetched = await deps.fetchChannel(gatewayId, newapiChannelId);
  if (!fetched || !Number.isFinite(fetched.usedQuota)) throw fail("bindingTargetMissing", 404);

  const holder = await holderOf(gatewayId, newapiChannelId);
  if (holder && holder.record_id !== recordId) {
    throw fail("bindingHeld", 409, { record: holder.name, owner: holder.owner || holder.record_id, upstreamId: newapiChannelId });
  }
  const other = (await dbGet(
    `SELECT c.id, c.name, COALESCE(u.name, '') AS owner FROM channels c LEFT JOIN users u ON u.id = c.creator_user_id
     WHERE c.gateway_id = ? AND c.upstream_id = ? AND c.id <> ?`,
    [gatewayId, newapiChannelId, recordId],
  )) as Holder | undefined;
  if (other) throw fail("bindingHeld", 409, { record: String(other.name), owner: String(other.owner || other.record_id), upstreamId: newapiChannelId });

  const active = (await dbGet(
    "SELECT id, bound_at FROM channel_bindings WHERE record_id = ? AND unbound_at IS NULL",
    [recordId],
  )) as { id: string; bound_at: number } | undefined;
  const lastBaseline = (await dbGet(
    "SELECT day FROM channel_baselines WHERE channel_id = ? ORDER BY day DESC LIMIT 1",
    [recordId],
  )) as { day: string } | undefined;
  const startMs = lastBaseline?.day ? shanghaiMidnight(lastBaseline.day) : Number(active?.bound_at ?? row.created_at ?? now);
  const logged = await deps.logQuota(gatewayId, from, startMs, now);
  const closed = closeOldSegment(logged);
  if (active) {
    await dbRun(
      `UPDATE channel_bindings SET unbound_at = ?, reason = ?, close_quota = ?, close_status = ? WHERE id = ?`,
      [now, "rebind", closed.quota, closed.status, active.id],
    );
  } else {
    await dbRun(
      `INSERT INTO channel_bindings (
        id, record_id, gateway_id, newapi_channel_id, bound_at, unbound_at, reason, close_quota, close_status
      ) VALUES (?, ?, ?, ?, ?, ?, 'rebind', ?, ?)`,
      [crypto.randomUUID(), recordId, gatewayId, from, Number(row.created_at ?? now), now, closed.quota, closed.status],
    );
  }
  await audit(actor, recordId, from, "unbind", `unbound #${from} ${closed.status}`);

  const day = shanghaiClock(new Date(now)).day;
  await dbRun(
    `INSERT INTO channel_baselines (channel_id, day, baseline, cumulative, today_quota, source, pulled_at)
     VALUES (?, ?, ?, ?, 0, 'bind', ?)
     ON CONFLICT(channel_id, day) DO UPDATE SET baseline = excluded.baseline, cumulative = excluded.cumulative, source = 'bind', pulled_at = excluded.pulled_at`,
    [recordId, day, fetched.usedQuota, fetched.usedQuota, now],
  );
  await dbRun(
    `UPDATE channels SET upstream_id = ?, used_quota = ?, upstream_missing = 0, missing_handled = 0, sync_status = 'ok', sync_error = NULL, updated_at = ? WHERE id = ?`,
    [newapiChannelId, fetched.usedQuota, now, recordId],
  );
  await dbRun(
    `INSERT INTO channel_bindings (
      id, record_id, gateway_id, newapi_channel_id, previous_newapi_id, bound_at, reason, bind_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?, 'rebind', ?)`,
    [crypto.randomUUID(), recordId, gatewayId, newapiChannelId, from, now, fetched.usedQuota],
  );
  await audit(actor, recordId, newapiChannelId, "bind", `bound #${from} -> #${newapiChannelId}`);
  return {
    recordId,
    from,
    to: newapiChannelId,
    snapshot: fetched.usedQuota,
    closeQuota: closed.quota,
    closeStatus: closed.status,
  };
}

export async function markMissingHandled(actor: SessionUser, recordId: string): Promise<void> {
  if (actor.role !== "admin") throw fail("forbidden", 403);
  const row = await dbGet("SELECT upstream_id FROM channels WHERE id = ? AND created_here = 1", [recordId]);
  if (!row) throw fail("notFound", 404);
  await dbRun("UPDATE channels SET missing_handled = 1, updated_at = ? WHERE id = ?", [Date.now(), recordId]);
  await audit(actor, recordId, Number(row.upstream_id), "mark-missing", "handled");
}

export async function rebindMarkers(channelIds: string[], billDay: string): Promise<Map<string, { from: number; to: number; closeQuota: number | null; closeStatus: string }>> {
  if (!channelIds.length) return new Map();
  const rows = await dbAll(
    `SELECT record_id, newapi_channel_id, previous_newapi_id, bound_at, close_quota, close_status
     FROM channel_bindings WHERE previous_newapi_id IS NOT NULL AND record_id IN (${channelIds.map(() => "?").join(",")})`,
    channelIds,
  );
  const map = new Map<string, { from: number; to: number; closeQuota: number | null; closeStatus: string }>();
  for (const row of rows as Record<string, unknown>[]) {
    if (shanghaiClock(new Date(Number(row.bound_at))).day !== billDay) continue;
    map.set(String(row.record_id), {
      from: Number(row.previous_newapi_id),
      to: Number(row.newapi_channel_id),
      closeQuota: row.close_quota === null || row.close_quota === undefined ? null : Number(row.close_quota),
      closeStatus: String(row.close_status ?? ""),
    });
  }
  return map;
}
