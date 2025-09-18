import Bottleneck from 'bottleneck';
import { Logger } from '../utils/logger';

export class RateLimiter {
  private limiters: Map<string, Bottleneck>;
  private logger: Logger;
  private maxRequests: number;
  private timeWindow: number;

  constructor(maxRequests: number, timeWindow: number) {
    this.logger = new Logger('RateLimiter');
    this.limiters = new Map();
    this.maxRequests = maxRequests;
    this.timeWindow = timeWindow;
  }

  private getLimiterForProxy(proxyUrl: string): Bottleneck {
    if (!this.limiters.has(proxyUrl)) {
      this.limiters.set(proxyUrl, new Bottleneck({
        maxConcurrent: 5,
        reservoir: this.maxRequests,
        reservoirRefreshAmount: this.maxRequests,
        reservoirRefreshInterval: this.timeWindow,
      }));

      const limiter = this.limiters.get(proxyUrl)!;
      limiter.on('failed', (error, jobInfo) => {
        this.logger.error('Rate limit job failed', { error, jobInfo, proxyUrl });
      });

      limiter.on('retry', (error, jobInfo) => {
        this.logger.warn('Rate limit job retrying', { error, jobInfo, proxyUrl });
      });
    }
    return this.limiters.get(proxyUrl)!;
  }

  public async schedule<T>(fn: () => Promise<T>, proxyUrl: string): Promise<T> {
    const limiter = this.getLimiterForProxy(proxyUrl);
    return limiter.schedule(fn);
  }

  public getRemainingRequests(proxyUrl: string): number {
    const limiter = this.limiters.get(proxyUrl);
    return limiter ? limiter.queued() : this.maxRequests;
  }

  public getNextAvailableTime(proxyUrl: string): number {
    const limiter = this.limiters.get(proxyUrl);
    return limiter ? limiter.counts().EXECUTING : 0;
  }
} 