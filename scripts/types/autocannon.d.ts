declare module 'autocannon' {
  import { EventEmitter } from 'events';

  interface SummaryWithPercentiles {
    average: number;
    mean: number;
    stddev: number;
    min: number;
    max: number;
    p50?: number;
    p75?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  }

  interface Totals extends SummaryWithPercentiles {
    total: number;
  }

  export interface AutocannonResult {
    duration: number;
    errors: number;
    timeouts: number;
    disconnects?: number;
    mismatches: number;
    non2xx: number;
    throughput: Totals;
    requests: Totals;
    latency: SummaryWithPercentiles;
  }

  export interface RequestOptions {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }

  export interface RequestInit {
    method?: string;
    path?: string;
    setupRequest?: (req: RequestOptions, context: Record<string, unknown>) => RequestOptions | false | void;
  }

  export interface AutocannonOptions {
    url: string;
    method?: string;
    connections?: number;
    duration?: number;
    amount?: number;
    timeout?: number;
    maxConnectionRequests?: number;
    pipelining?: number;
    headers?: Record<string, string>;
    requests?: RequestInit[];
  }

  export interface AutocannonInstance extends EventEmitter {
    stop(): void;
  }

  export type Callback = (err: Error | null, result: AutocannonResult) => void;

  function autocannon(options: AutocannonOptions, callback?: Callback): AutocannonInstance;

  export = autocannon;
}
