import { AppError } from "../shared/app-error";

interface RateLimitEntry {
  startedAt: number;
  count: number;
}

/** 单进程请求限流；多实例部署时应在网关或共享存储层配置同等规则。 */
export class InMemoryRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  public constructor(
    private readonly maximumRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  public check(key: string): void {
    const current = this.now();
    const entry = this.entries.get(key);
    if (!entry || current - entry.startedAt >= this.windowMs) {
      this.entries.set(key, { startedAt: current, count: 1 });
      this.prune(current);
      return;
    }
    if (entry.count >= this.maximumRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (current - entry.startedAt)) / 1_000));
      throw new AppError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试", { retryAfterSeconds });
    }
    entry.count += 1;
  }

  private prune(current: number): void {
    for (const [key, entry] of this.entries) {
      if (current - entry.startedAt >= this.windowMs) this.entries.delete(key);
    }
  }
}
