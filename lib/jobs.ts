import { channelsMissingBaseline, ensureBillingRun, pullChannelBaseline } from "./billing-service";
import { gatewayIds, syncGatewayPage } from "./channel-service";
import { ensureDemoGateway } from "./demo-gateway";
import { dbGet } from "./db";
import { rateLimits } from "./settings";
import { formatShanghaiMidnight, nextShanghaiMidnight } from "./shanghai";

const pulling = new Set<string>();
const pages = new Map<string, number>();
let lastListSync = 0;
let started = false;

async function tick(): Promise<void> {
  await rateLimits();
  if (process.env.DEMO_GATEWAY === "1") {
    const admin = await dbGet("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
    if (admin?.id) await ensureDemoGateway(String(admin.id));
  }
  const run = await ensureBillingRun();
  if (run) {
    const missing = await channelsMissingBaseline(run.baselineDay);
    for (const channelId of missing) {
      if (pulling.has(channelId)) continue;
      pulling.add(channelId);
      void pullChannelBaseline(channelId, run.baselineDay).finally(() => pulling.delete(channelId));
    }
  }
  const interval = Math.max(30_000, Number(process.env.SYNC_INTERVAL_MS ?? 300_000) || 300_000);
  const now = Date.now();
  if (now - lastListSync >= interval) {
    lastListSync = now;
    for (const id of await gatewayIds()) pages.set(id, 1);
  }
  for (const [gatewayId, page] of pages) {
    const result = await syncGatewayPage(gatewayId, page);
    if (result.done) pages.delete(gatewayId);
    else pages.set(gatewayId, page + 1);
    break;
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
