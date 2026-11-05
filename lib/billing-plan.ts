/**
 * 账单基线拉取计划：结合网关每分钟配额与 04:00（上海）目标完成时刻，
 * 把缺基线渠道排成每 tick 的有限批次。纯函数，便于测试。
 *
 * 每渠道一次拉取的最坏上游请求：GET /api/channel/:id + 今日 log/stat + 两条测试
 * log/stat（Model test / 模型测试）= 4 次；今日日志为 0 时后两条可跳过。
 */

/** 列表同步的每分钟预留：一页/15s tick ≈ 4 次/分。 */
export const LIST_SYNC_RESERVE_PER_MIN = 4;
/** 单渠道一次基线拉取的最坏上游请求数。 */
export const CALLS_PER_CHANNEL = 4;
/** 目标完成时刻（上海小时）；06:00 是硬截止，这里留两小时缓冲。 */
export const TARGET_HOUR = 4;
export const TICK_MS = 15_000;

export type PlanChannel = {
  id: string;
  gatewayId: string;
  /** 渠道累计消费，用来近似「昨日有消耗」，大额优先。 */
  usedQuota: number;
  createdAt: number;
  consecutiveFailures: number;
  /** billing_attempts 最近一次失败的时间戳；null = 今天还没试过。 */
  lastFailedAt: number | null;
};

/** 连续失败后的重试退避：30s 起指数翻倍，封顶 15 分钟。首败也等 30s，避免每 tick 重发烧配额。 */
export function failureBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 30_000;
  return Math.min(15 * 60_000, 30_000 * 2 ** (consecutiveFailures - 1));
}

export type BillingTickPlan = { dispatch: string[]; etaMinutes: number };

export function planBillingTick(input: {
  now: number;
  shanghaiHour: number;
  shanghaiMinute: number;
  channels: PlanChannel[];
  gatewayPerMin: number;
  /** gatewayId → 本分钟已用的网关配额（含列表同步）。 */
  queueHits: Record<string, number>;
}): BillingTickPlan {
  const due = input.channels.filter((channel) => {
    if (!channel.lastFailedAt) return true;
    return input.now - channel.lastFailedAt >= failureBackoffMs(channel.consecutiveFailures);
  });
  // 昨日有消耗的先拉（影响账单准确性最大），同量级新渠道靠前，最后是无消耗的老渠道
  const ordered = [...due].sort((a, b) => {
    const aActive = a.usedQuota > 0 ? 1 : 0;
    const bActive = b.usedQuota > 0 ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    if (aActive === 1 && b.usedQuota !== a.usedQuota) return b.usedQuota - a.usedQuota;
    return b.createdAt - a.createdAt;
  });

  const effectivePerMin = Math.max(1, input.gatewayPerMin - LIST_SYNC_RESERVE_PER_MIN);
  const remainingByGateway = new Map<string, number>();
  const countByGateway = new Map<string, number>();
  for (const channel of ordered) {
    const hits = input.queueHits[channel.gatewayId] ?? 0;
    const capacityCalls = Math.max(0, effectivePerMin - hits);
    remainingByGateway.set(channel.gatewayId, Math.max(remainingByGateway.get(channel.gatewayId) ?? 0, capacityCalls));
    countByGateway.set(channel.gatewayId, (countByGateway.get(channel.gatewayId) ?? 0) + 1);
  }

  // 每 tick 可派渠道数：按网关有效配额换算（默认 60rpm → ~4 个渠道/tick）。
  // 批次过大时队列里的任务会超过 45 秒截止时间整批失败，所以按分钟容量匀速派发。
  const ticksPerMinute = Math.max(1, 60_000 / TICK_MS);
  const perTickChannels = Math.max(1, Math.ceil(effectivePerMin / CALLS_PER_CHANNEL / ticksPerMinute));

  const quotaByGateway = new Map<string, number>();
  for (const [gatewayId, count] of countByGateway) {
    const capacityChannels = Math.ceil((remainingByGateway.get(gatewayId) ?? 0) / CALLS_PER_CHANNEL);
    quotaByGateway.set(gatewayId, Math.max(0, Math.min(count, perTickChannels, capacityChannels)));
  }

  const dispatch: string[] = [];
  for (const channel of ordered) {
    const left = quotaByGateway.get(channel.gatewayId) ?? 0;
    if (left <= 0) continue;
    dispatch.push(channel.id);
    quotaByGateway.set(channel.gatewayId, left - 1);
  }

  let etaMinutes = 0;
  for (const [, count] of countByGateway) {
    etaMinutes = Math.max(etaMinutes, Math.ceil((count * CALLS_PER_CHANNEL) / effectivePerMin));
  }
  return { dispatch, etaMinutes };
}
