import { retryDelayMs } from "./billing-math";

export type RateLimits = {
  gatewayPerMin: number;
  channelPerMin: number;
  concurrency: number;
};

export class UpstreamBusy extends Error {
  pending = true;
  constructor() {
    super("upstreamBusy");
  }
}

type Job = {
  gatewayId: string;
  lane: string;
  attempt: number;
  notBefore: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  deadline: number;
};

export type Retryable = Error & { retryable?: boolean; retryAfter?: number | null };

const WINDOW_MS = 60_000;

function fresh(stamps: number[], now: number): number[] {
  return stamps.filter((stamp) => now - stamp < WINDOW_MS);
}

export class UpstreamQueue {
  private jobs: Job[] = [];
  private inflight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gatewayHits = new Map<string, number[]>();
  private laneHits = new Map<string, number[]>();
  limits: RateLimits = { gatewayPerMin: 60, channelPerMin: 5, concurrency: 3 };
  now = () => Date.now();

  snapshot(gatewayId?: string): { inflight: number; queued: number; hitsThisMinute: number; limits: RateLimits } {
    const now = this.now();
    const queued = gatewayId ? this.jobs.filter((job) => job.gatewayId === gatewayId).length : this.jobs.length;
    const stamps = gatewayId ? fresh(this.gatewayHits.get(gatewayId) ?? [], now) : [...this.gatewayHits.values()].flatMap((hits) => fresh(hits, now));
    return { inflight: this.inflight, queued, hitsThisMinute: stamps.length, limits: this.limits };
  }

  setLimits(limits: RateLimits): void {
    this.limits = {
      gatewayPerMin: Math.max(1, limits.gatewayPerMin),
      channelPerMin: Math.max(1, limits.channelPerMin),
      concurrency: Math.max(1, limits.concurrency),
    };
  }

  enqueue<T>(input: { gatewayId: string; lane: string; run: () => Promise<T>; timeoutMs?: number }): Promise<T> {
    const timeoutMs = input.timeoutMs ?? 45_000;
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        gatewayId: input.gatewayId,
        lane: input.lane,
        attempt: 0,
        notBefore: 0,
        run: input.run,
        resolve: (value) => resolve(value as T),
        reject,
        deadline: this.now() + timeoutMs,
      });
      this.pump();
    });
  }

  pump(): void {
    const now = this.now();
    while (this.inflight < this.limits.concurrency) {
      const index = this.jobs.findIndex((job) => job.notBefore <= now && this.allowed(job, now));
      if (index < 0) {
        this.arm(now);
        break;
      }
      const job = this.jobs.splice(index, 1)[0];
      if (!job) break;
      this.mark(job, now);
      this.inflight += 1;
      void this.execute(job);
    }
  }

  private arm(now: number): void {
    if (this.timer || this.jobs.length === 0) return;
    let wake = now + WINDOW_MS;
    for (const job of this.jobs) wake = Math.min(wake, Math.max(now, job.notBefore));
    for (const stamps of [...this.gatewayHits.values(), ...this.laneHits.values()]) {
      if (stamps[0] !== undefined) wake = Math.min(wake, stamps[0] + WINDOW_MS);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(20, wake - now));
  }

  private allowed(job: Job, now: number): boolean {
    const gateway = fresh(this.gatewayHits.get(job.gatewayId) ?? [], now);
    this.gatewayHits.set(job.gatewayId, gateway);
    const laneKey = `${job.gatewayId}:${job.lane}`;
    const lane = fresh(this.laneHits.get(laneKey) ?? [], now);
    this.laneHits.set(laneKey, lane);
    return gateway.length < this.limits.gatewayPerMin && lane.length < this.limits.channelPerMin;
  }

  private mark(job: Job, now: number): void {
    const gateway = this.gatewayHits.get(job.gatewayId) ?? [];
    gateway.push(now);
    this.gatewayHits.set(job.gatewayId, gateway);
    const laneKey = `${job.gatewayId}:${job.lane}`;
    const lane = this.laneHits.get(laneKey) ?? [];
    lane.push(now);
    this.laneHits.set(laneKey, lane);
  }

  private async execute(job: Job): Promise<void> {
    try {
      const value = await job.run();
      job.resolve(value);
    } catch (error) {
      const retryable = Boolean((error as Retryable)?.retryable);
      const now = this.now();
      if (retryable && now < job.deadline) {
        job.attempt += 1;
        const retryAfter = (error as Retryable).retryAfter ?? null;
        job.notBefore = now + retryDelayMs(job.attempt - 1, retryAfter);
        this.jobs.push(job);
      } else if (retryable) {
        job.reject(new UpstreamBusy());
      } else {
        job.reject(error);
      }
    } finally {
      this.inflight -= 1;
      this.pump();
    }
  }
}

export const upstreamQueue = new UpstreamQueue();
