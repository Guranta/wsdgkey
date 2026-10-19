const TZ = "Asia/Shanghai";

export function shanghaiClock(date = new Date()): { day: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  return {
    day: `${read("year")}-${read("month")}-${read("day")}`,
    hour,
    minute: Number(read("minute")),
  };
}

export function addDays(day: string, delta: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

/** 00:00 Asia/Shanghai for a calendar day, as a unix ms timestamp. */
export function shanghaiMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}

/** The next 00:00 Asia/Shanghai at or after `now`. */
export function nextShanghaiMidnight(now = Date.now()): number {
  const day = shanghaiClock(new Date(now)).day;
  const start = shanghaiMidnight(day);
  return now <= start ? start : shanghaiMidnight(addDays(day, 1));
}

export function formatShanghaiMidnight(ms: number): string {
  return `${shanghaiClock(new Date(ms)).day}T00:00:00+08:00`;
}

/**
 * Log-stat window for a billed span. New API treats `created_at <= end` as inclusive,
 * so the end stamp is one second before the next midnight.
 */
export function logWindow(startDay: string, endDay: string): { start: number; end: number } {
  return {
    start: shanghaiMidnight(startDay),
    end: shanghaiMidnight(addDays(endDay, 1)) - 1000,
  };
}

export function formatShanghaiTime(ts?: number | null, locale = "zh-CN"): string {
  if (!ts) return "—";
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
  return parts.replace("24:", "00:");
}
