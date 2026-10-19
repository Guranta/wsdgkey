const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 5;

type Hit = { at: number };
const byIp = new Map<string, Hit[]>();
const byUser = new Map<string, Hit[]>();

function prune(list: Hit[] | undefined, now: number): Hit[] {
  return (list ?? []).filter((hit) => now - hit.at < WINDOW_MS);
}

function retryAfter(hits: Hit[], now: number): number {
  const oldest = Math.min(...hits.map((hit) => hit.at));
  return Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

export type RateDecision = { limited: false } | { limited: true; retryAfter: number };

function decision(ipHits: Hit[], userHits: Hit[], now: number): RateDecision {
  const ipBlocked = ipHits.length >= LIMIT;
  const userBlocked = userHits.length >= LIMIT;
  if (!ipBlocked && !userBlocked) return { limited: false };
  const relevant = [...(ipBlocked ? ipHits : []), ...(userBlocked ? userHits : [])];
  return { limited: true, retryAfter: retryAfter(relevant, now) };
}

export function resetLoginRateForTests(): void {
  byIp.clear();
  byUser.clear();
}

export function loginRateLimited(ip: string, username: string, now = Date.now()): RateDecision {
  return decision(prune(byIp.get(ip), now), username ? prune(byUser.get(username), now) : [], now);
}

export function recordLoginFailure(ip: string, username: string, now = Date.now()): RateDecision {
  const ipHits = prune(byIp.get(ip), now);
  ipHits.push({ at: now });
  byIp.set(ip, ipHits);
  let userHits: Hit[] = [];
  if (username) {
    userHits = prune(byUser.get(username), now);
    userHits.push({ at: now });
    byUser.set(username, userHits);
  }
  return decision(ipHits, userHits, now);
}

export function clearUsernameFailures(username: string): void {
  if (username) byUser.delete(username);
}

export function clientIp(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (forwarded) return forwarded.slice(0, 80);
  const real = headers.get("x-real-ip")?.trim() ?? "";
  if (real) return real.slice(0, 80);
  return "unknown";
}

export function loginUsernameKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().slice(0, 200);
}
