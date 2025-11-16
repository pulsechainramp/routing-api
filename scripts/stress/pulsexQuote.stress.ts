import { config as loadEnv } from 'dotenv';
import axios from 'axios';
import autocannon, { AutocannonResult, RequestOptions } from 'autocannon';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

loadEnv();

type QuotePayload = Record<string, string | number>;

interface TickMetrics {
  counter?: number;
  bytes?: number;
}

interface StressContext {
  targetUrlRaw: string;
  parsedUrl: URL;
  buildPath: (payload: QuotePayload) => string;
  payloads: QuotePayload[];
}

interface ThinkRunStats {
  latencies: number[];
  totalRequests: number;
  non2xxResponses: number;
  transportErrors: number;
}

const parseNumericEnv = (key: string, defaultValue: number, options?: { allowZero?: boolean }): number => {
  const raw = process.env[key];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    return defaultValue;
  }

  if (parsed === 0 && options?.allowZero) {
    return 0;
  }

  return parsed > 0 ? parsed : defaultValue;
};

const resolvePayloadFile = (): string => {
  const candidates = [
    path.resolve(__dirname, 'pulsexQuote.payloads.json'),
    path.resolve(process.cwd(), 'scripts/stress/pulsexQuote.payloads.json')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Unable to find pulsexQuote.payloads.json. Looked in: ${candidates.join(', ')}`);
};

const loadPayloads = (): QuotePayload[] => {
  const payloadFile = resolvePayloadFile();
  const content = readFileSync(payloadFile, 'utf8');
  const parsed: unknown = JSON.parse(content);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`No payloads found in ${payloadFile}`);
  }

  return parsed as QuotePayload[];
};

const cloneSearchParams = (params: URLSearchParams): URLSearchParams => {
  const clone = new URLSearchParams();
  params.forEach((value, key) => {
    clone.set(key, value);
  });
  return clone;
};

const buildPathFactory = (basePath: string, baseParams: URLSearchParams) => {
  return (payload: QuotePayload): string => {
    const params = cloneSearchParams(baseParams);
    Object.entries(payload).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      params.set(key, String(value));
    });
    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
  };
};

const pickRandomPayload = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

const summarizeHammerResult = (result: AutocannonResult): void => {
  const { latency, requests, throughput, non2xx, errors, timeouts, mismatches, duration } = result;

  const safeValue = (value?: number) => (typeof value === 'number' ? value.toFixed(2) : 'n/a');
  console.log('\n=== PulseX Hammer Stress Summary ===');
  console.log(`Duration: ${duration}s`);
  console.log(
    `Latency p50/p90/p95/p99/max (ms): ${safeValue(latency.p50)} / ${safeValue(latency.p90)} / ${safeValue(
      latency.p95
    )} / ${safeValue(latency.p99)} / ${safeValue(latency.max)}`
  );
  console.log(
    `Requests/sec avg: ${safeValue(requests.average)} | Total requests: ${requests.total} | Throughput (bytes/sec avg): ${safeValue(
      throughput.average
    )}`
  );
  console.log(
    `Errors: ${errors} | Timeouts: ${timeouts} | Non-2xx: ${non2xx} | Mismatches: ${mismatches}`
  );
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min: number, max: number): number => {
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const computePercentiles = (values: number[]) => {
  if (values.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const pick = (percentile: number): number => {
    if (sorted.length === 1) {
      return sorted[0];
    }
    const rank = (percentile / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    const weight = rank - lowerIndex;
    if (lowerIndex === upperIndex) {
      return sorted[lowerIndex];
    }
    return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
  };

  return {
    p50: pick(50),
    p90: pick(90),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1]
  };
};

const createStressContext = (): StressContext => {
  const targetUrlRaw = process.env.PULSEX_QUOTE_URL;
  if (!targetUrlRaw) {
    throw new Error('PULSEX_QUOTE_URL is required.');
  }

  const payloads = loadPayloads();
  const parsedUrl = new URL(targetUrlRaw);
  const buildPath = buildPathFactory(parsedUrl.pathname || '/', new URLSearchParams(parsedUrl.search));

  console.log('[PulseX Stress] Loaded payloads:', payloads.length);
  console.log('[PulseX Stress] Target URL:', targetUrlRaw);

  return { targetUrlRaw, parsedUrl, buildPath, payloads };
};

const runHammerMode = async (context: StressContext): Promise<void> => {
  const baseConcurrency = parseNumericEnv('PULSEX_STRESS_CONCURRENCY', 20);
  const durationSec = parseNumericEnv('PULSEX_STRESS_DURATION_SEC', 60);
  const maxRequestsPerConnection = parseNumericEnv('PULSEX_STRESS_MAX_REQUESTS_PER_CONN', 0);
  const connectionCap = parseNumericEnv('PULSEX_STRESS_CONNECTIONS', 100);
  const activeConnections = Math.max(1, Math.min(baseConcurrency, connectionCap));

  console.log('[PulseX Stress] Target concurrency (PULSEX_STRESS_CONCURRENCY):', baseConcurrency);
  console.log('[PulseX Stress] Connection cap (PULSEX_STRESS_CONNECTIONS):', connectionCap);
  console.log('[PulseX Stress] Active HTTP connections:', activeConnections);
  if (baseConcurrency > connectionCap) {
    console.log('[PulseX Stress] Note: Clamped to connection cap. Increase PULSEX_STRESS_CONNECTIONS to allow more concurrency.');
  }
  console.log('[PulseX Stress] Duration (seconds):', durationSec);
  if (maxRequestsPerConnection > 0) {
    console.log('[PulseX Stress] Max requests per connection:', maxRequestsPerConnection);
  }

  const { parsedUrl, buildPath, payloads } = context;

  await new Promise<void>((resolve, reject) => {
    const instance = autocannon({
      url: parsedUrl.origin,
      method: 'GET',
      connections: activeConnections,
      duration: durationSec,
      pipelining: 1,
      maxConnectionRequests: maxRequestsPerConnection > 0 ? maxRequestsPerConnection : undefined,
      headers: {
        accept: 'application/json'
      },
      requests: [
        {
          method: 'GET',
          path: buildPath(pickRandomPayload(payloads)),
          setupRequest: (req: RequestOptions) => {
            const payload = pickRandomPayload(payloads);
            req.method = 'GET';
            req.path = buildPath(payload);
            req.headers = {
              ...(req.headers ?? {}),
              accept: 'application/json'
            };
            return req;
          }
        }
      ]
    });

    let tickCount = 0;
    instance.on('tick', (tick: TickMetrics) => {
      tickCount += 1;
      if (tickCount % 5 === 0 && typeof tick.counter === 'number') {
        console.log(`[PulseX Stress] Recent interval completed ~${tick.counter} requests`);
      }
    });

    instance.once('error', (error: Error) => {
      console.error('[PulseX Stress] Benchmark failed:', error.message);
      process.exitCode = 1;
      reject(error);
    });

    instance.once('done', (result: AutocannonResult) => {
      summarizeHammerResult(result);
      process.exitCode = 0;
      resolve();
    });

    const stopHandler = () => {
      console.log('\n[PulseX Stress] Caught SIGINT, stopping load...');
      instance.stop();
    };

    process.once('SIGINT', stopHandler);
  });
};

const runVirtualUser = async (
  endTime: number,
  thinkMinMs: number,
  thinkMaxMs: number,
  buildFullUrl: (payload: QuotePayload) => string,
  payloadPicker: () => QuotePayload,
  stopRequested: () => boolean
): Promise<ThinkRunStats> => {
  const stats: ThinkRunStats = {
    latencies: [],
    totalRequests: 0,
    non2xxResponses: 0,
    transportErrors: 0
  };

  while (!stopRequested() && Date.now() < endTime) {
    const delay = randomInt(thinkMinMs, thinkMaxMs);
    await sleep(delay);

    if (stopRequested() || Date.now() >= endTime) {
      break;
    }

    const payload = payloadPicker();
    const url = buildFullUrl(payload);
    const start = Date.now();
    stats.totalRequests += 1;

    try {
      const response = await axios.get(url, {
        validateStatus: () => true
      });
      const latencyMs = Date.now() - start;
      stats.latencies.push(latencyMs);
      if (response.status < 200 || response.status >= 300) {
        stats.non2xxResponses += 1;
      }
    } catch (error) {
      stats.transportErrors += 1;
    }
  }

  return stats;
};

const runThinkTimeMode = async (context: StressContext): Promise<void> => {
  const concurrency = parseNumericEnv('PULSEX_STRESS_CONCURRENCY', 50);
  const durationSec = parseNumericEnv('PULSEX_STRESS_DURATION_SEC', 300);
  const thinkMinMs = parseNumericEnv('PULSEX_THINK_MIN_MS', 2000);
  const thinkMaxMs = parseNumericEnv('PULSEX_THINK_MAX_MS', 10000);

  if (thinkMaxMs < thinkMinMs) {
    throw new Error('PULSEX_THINK_MAX_MS must be greater than or equal to PULSEX_THINK_MIN_MS');
  }

  console.log('[PulseX Think] Virtual users:', concurrency);
  console.log('[PulseX Think] Duration (seconds):', durationSec);
  console.log('[PulseX Think] Think time min/max (ms):', thinkMinMs, '/', thinkMaxMs);

  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;

  const { parsedUrl, buildPath, payloads } = context;
  const buildFullUrl = (payload: QuotePayload) => `${parsedUrl.origin}${buildPath(payload)}`;
  const stopSignal = { value: false };

  const handleSigint = () => {
    if (!stopSignal.value) {
      console.log('\n[PulseX Think] Caught SIGINT, finishing up...');
      stopSignal.value = true;
    }
  };

  process.once('SIGINT', handleSigint);

  const workers: Promise<ThinkRunStats>[] = [];
  for (let i = 0; i < concurrency; i += 1) {
    workers.push(runVirtualUser(endTime, thinkMinMs, thinkMaxMs, buildFullUrl, () => pickRandomPayload(payloads), () => stopSignal.value));
  }

  const results = await Promise.all(workers);
  process.removeListener('SIGINT', handleSigint);

  const latencies = results.flatMap((r) => r.latencies);
  const totalRequests = results.reduce((sum, r) => sum + r.totalRequests, 0);
  const non2xx = results.reduce((sum, r) => sum + r.non2xxResponses, 0);
  const transportErrors = results.reduce((sum, r) => sum + r.transportErrors, 0);
  const actualDurationSec = Math.max(1, (Math.min(Date.now(), endTime) - startTime) / 1000);
  const requestsPerSec = totalRequests / actualDurationSec;
  const percentiles = computePercentiles(latencies);

  console.log('\n=== PulseX Think-Time Stress Summary ===');
  console.log(`Duration: ${actualDurationSec.toFixed(2)}s`);
  console.log(
    `Latency p50/p90/p95/p99/max (ms): ${percentiles.p50.toFixed(2)} / ${percentiles.p90.toFixed(2)} / ${percentiles.p95.toFixed(2)} / ${percentiles.p99.toFixed(2)} / ${percentiles.max.toFixed(
      2
    )}`
  );
  console.log(`Requests/sec avg: ${requestsPerSec.toFixed(2)} | Total requests: ${totalRequests}`);
  console.log(`Errors: ${transportErrors} | Non-2xx: ${non2xx}`);
  process.exitCode = transportErrors > 0 ? 1 : 0;
};

const main = async () => {
  try {
    const context = createStressContext();
    const mode = (process.env.PULSEX_STRESS_MODE ?? 'hammer').toLowerCase();

    if (mode === 'think') {
      await runThinkTimeMode(context);
    } else {
      await runHammerMode(context);
    }
  } catch (error) {
    console.error('[PulseX Stress] Unable to start benchmark:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

void main();
