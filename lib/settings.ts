import { BRAND_NAME } from "./brand";
import { dbGet, dbRun } from "./db";
import { upstreamQueue, type RateLimits } from "./rate-queue";

const DEFAULTS: Record<string, string> = {
  site_name: BRAND_NAME,
  gateway_rpm: "60",
  channel_rpm: "5",
  concurrency: "3",
  test_cooldown_min: "10",
  quota_per_unit: "500000",
  recon_tolerance_pct: "1",
  recon_zero_days: "3",
  recon_manual_tolerance_pct: "2",
};

async function readRaw(key: string): Promise<string> {
  const row = await dbGet("SELECT value FROM app_settings WHERE key = ?", [key]);
  const value = row?.value;
  if (typeof value === "string" && value.trim()) return value;
  const fallback = DEFAULTS[key] ?? "";
  await dbRun("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [key, fallback]);
  return fallback;
}

function clamp(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export async function rateLimits(): Promise<RateLimits> {
  const limits = {
    gatewayPerMin: clamp(await readRaw("gateway_rpm"), 60, 1, 10_000),
    channelPerMin: clamp(await readRaw("channel_rpm"), 5, 1, 1_000),
    concurrency: clamp(await readRaw("concurrency"), 3, 1, 50),
  };
  upstreamQueue.setLimits(limits);
  return limits;
}

export async function saveRateLimits(input: RateLimits): Promise<RateLimits> {
  const limits = {
    gatewayPerMin: clamp(String(input.gatewayPerMin), 60, 1, 10_000),
    channelPerMin: clamp(String(input.channelPerMin), 5, 1, 1_000),
    concurrency: clamp(String(input.concurrency), 3, 1, 50),
  };
  const pairs: [string, number][] = [
    ["gateway_rpm", limits.gatewayPerMin],
    ["channel_rpm", limits.channelPerMin],
    ["concurrency", limits.concurrency],
  ];
  for (const [key, value] of pairs) {
    await dbRun(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, String(value)],
    );
  }
  upstreamQueue.setLimits(limits);
  return limits;
}

export async function testCooldownMs(): Promise<number> {
  return clamp(await readRaw("test_cooldown_min"), 10, 0, 24 * 60) * 60 * 1000;
}

export type DeskSettings = RateLimits & {
  siteName: string;
  testCooldownMin: number;
  quotaPerUnit: number;
  reconTolerancePct: number;
  zeroDays: number;
  manualTolerancePct: number;
};

export async function siteName(): Promise<string> {
  const value = (await readRaw("site_name")).trim().slice(0, 40);
  return value || BRAND_NAME;
}

async function writeSetting(key: string, value: string): Promise<void> {
  await dbRun("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

export async function quotaPerUnit(): Promise<number> {
  return clamp(await readRaw("quota_per_unit"), 500_000, 1, 1_000_000_000);
}

export async function reconPolicy(): Promise<{ tolerance: number; zeroDays: number; quotaPerUnit: number; manualTolerance: number }> {
  const percent = clamp(await readRaw("recon_tolerance_pct"), 1, 0, 100);
  const manual = clamp(await readRaw("recon_manual_tolerance_pct"), 2, 0, 100);
  return {
    tolerance: percent / 100,
    zeroDays: clamp(await readRaw("recon_zero_days"), 3, 1, 90),
    quotaPerUnit: await quotaPerUnit(),
    manualTolerance: manual / 100,
  };
}

export async function readAppSettings(): Promise<DeskSettings> {
  const limits = await rateLimits();
  const policy = await reconPolicy();
  return {
    ...limits,
    siteName: await siteName(),
    testCooldownMin: Math.round((await testCooldownMs()) / 60_000),
    quotaPerUnit: policy.quotaPerUnit,
    reconTolerancePct: Math.round(policy.tolerance * 1000) / 10,
    zeroDays: policy.zeroDays,
    manualTolerancePct: Math.round(policy.manualTolerance * 1000) / 10,
  };
}

function cleanSiteName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return text || fallback || BRAND_NAME;
}

export async function saveAppSettings(input: Partial<DeskSettings> & RateLimits): Promise<DeskSettings> {
  const limits = await saveRateLimits(input);
  const current = await reconPolicy();
  const minutes = clamp(String(input.testCooldownMin ?? Math.round((await testCooldownMs()) / 60_000)), 10, 0, 24 * 60);
  const unit = clamp(String(input.quotaPerUnit ?? current.quotaPerUnit), 500_000, 1, 1_000_000_000);
  const tolerance = clamp(String(input.reconTolerancePct ?? current.tolerance * 100), 1, 0, 100);
  const zeroDays = clamp(String(input.zeroDays ?? current.zeroDays), 3, 1, 90);
  const manual = clamp(String(input.manualTolerancePct ?? current.manualTolerance * 100), 2, 0, 100);
  const name = cleanSiteName(input.siteName, await siteName());
  await writeSetting("site_name", name);
  await writeSetting("test_cooldown_min", String(minutes));
  await writeSetting("quota_per_unit", String(unit));
  await writeSetting("recon_tolerance_pct", String(tolerance));
  await writeSetting("recon_zero_days", String(zeroDays));
  await writeSetting("recon_manual_tolerance_pct", String(manual));
  return { ...limits, siteName: name, testCooldownMin: minutes, quotaPerUnit: unit, reconTolerancePct: tolerance, zeroDays, manualTolerancePct: manual };
}
