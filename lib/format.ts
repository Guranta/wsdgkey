export const QUOTA_PER_DOLLAR = 500_000;
export const HEARTBEAT_MS = 45_000;

export function formatQuota(value: number, locale = "zh-CN"): string {
  return value.toLocaleString(locale);
}

export function formatUsd(value: number, locale = "zh-CN"): string {
  return (value / QUOTA_PER_DOLLAR).toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  });
}

export function formatDollars(value: number, locale = "zh-CN"): string {
  return value.toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
  });
}

export function formatExpiry(expiresAt: number, locale = "zh-CN"): string {
  if (!expiresAt) return "—";
  const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  return formatTimestamp(ms, locale);
}

export function formatTimestamp(ts?: number | null, locale = "zh-CN"): string {
  if (!ts) return "—";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(locale, { hour12: false });
}

export function formatUnix(seconds?: number, locale = "zh-CN"): string {
  if (!seconds) return "—";
  return formatTimestamp(seconds > 1e12 ? seconds : seconds * 1000, locale);
}

export function formatRelative(ts?: number, now = Date.now(), locale = "zh-CN"): string {
  if (!ts) return "—";
  const diff = now - ts;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? -1 : 1;
  if (abs < 60_000) return rtf.format(sign * Math.round(abs / 1000), "second");
  if (abs < 3_600_000) return rtf.format(sign * Math.round(abs / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(sign * Math.round(abs / 3_600_000), "hour");
  return formatTimestamp(ts, locale);
}

export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "—";
  if (trimmed.length <= 8) return "•".repeat(Math.max(4, trimmed.length));
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}

export function formatModelLimits(limits: string[], enabled: boolean): string {
  if (!enabled || limits.length === 0) return "";
  return limits.join(", ");
}

export function siteLabel(demo: boolean, siteBase: string): string {
  return demo ? "demo" : siteBase;
}

export function formatDuration(seconds: number, locale = "zh-CN"): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const whole = Math.round(seconds);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  if (whole < 60) return rtf.format(whole, "second").replace(/^\+/, "");
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const minuteText = rtf.format(minutes, "minute").replace(/^\+/, "");
  if (!rest) return minuteText;
  return `${minuteText} ${rtf.format(rest, "second").replace(/^\+/, "")}`;
}
