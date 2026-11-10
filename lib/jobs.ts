import { ensureBillingRun, missingBaselineChannels, pullChannelBaseline } from "./billing-service";
import { planBillingTick } from "./billing-plan";
import { gatewayIds, syncGatewayPage } from "./channel-service";
import { ensureDemoGateway } from "./demo-gateway";
import { dbGet } from "./db";
import { beginSweepTick, finishSweepTick, type SweepBook } from "./list-sweep";
import { upstreamQueue } from "./rate-queue";
import { rateLimits } from "./settings";
import { formatShanghaiMidnight, nextShanghaiMidnight, shanghaiClock } from "./shanghai";
import { runSupplierSnapshots } from "./supplier-billing";

const pulling = new Set<string>();
let sweep: SweepBook = { lastListSync: 0, pages: new Map() };
let started = false;

async function tick(): Promise<void> {
  const limits = await rateLimits();
  if (process.env.DEMO_GATEWAY === "1") {
    const admin = await dbGet("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
    if (admin?.id) await ensureDemoGateway(String(admin.id));
  }
  const run = await ensureBillingRun();
  if (run) {
    // 有限批次派发：按网关剩余配额匀速，失败渠道退避，大额消耗优先（发布后继续 backfill）
    const missing = await missingBaselineChannels(run.baselineDay);
    if (missing.length) {
      const queueHits: Record<string, number> = {};
      for (const gatewayId of new Set(missing.map((channel) => channel.gatewayId))) {
        queueHits[gatewayId] = upstreamQueue.snapshot(gatewayId).hitsThisMinute;
      }
      const clock = shanghaiClock();
      const plan = planBillingTick({
        now: Date.now(),
        shanghaiHour: clock.hour,
        shanghaiMinute: clock.minute,
        channels: missing,
        gatewayPerMin: limits.gatewayPerMin,
        queueHits,
      });
      for (const channelId of plan.dispatch) {
        if (pulling.has(channelId)) continue;
        pulling.add(channelId);
        void pullChannelBaseline(channelId, run.baselineDay).finally(() => pulling.delete(channelId));
      }
    }
  }
  await runSupplierSnapshots();
  const interval = Math.max(30_000, Number(process.env.SYNC_INTERVAL_MS ?? 300_000) || 300_000);
  const planned = beginSweepTick(sweep, Date.now(), interval, await gatewayIds());
  sweep = planned.book;
  if (planned.next) {
    const result = await syncGatewayPage(planned.next.id, planned.next.page);
    sweep = finishSweepTick(sweep, planned.next.id, result.done);
  }
}

export function startJobs(): void {
  if (started) return;
  started = true;
  const next = nextShanghaiMidnight();
  console.log(`[billing] scheduler registered; next 00:00 Asia/Shanghai run at ${formatShanghaiMidnight(next)}`);
  void tick();
  setInterval(() => {
    void tick().catch((error: unknown) => {
      console.info(`job ${error instanceof Error ? error.message : "failed"}`);
    });
  }, 15_000);
}
