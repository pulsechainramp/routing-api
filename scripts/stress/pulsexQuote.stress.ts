import { config as loadEnv } from 'dotenv';
import autocannon, { AutocannonResult, RequestOptions } from 'autocannon';
import { readFileSync } from 'fs';
import path from 'path';

loadEnv();

type QuotePayload = Record<string, string | number>;

interface TickMetrics {
  counter?: number;
  bytes?: number;
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

const loadPayloads = (): QuotePayload[] => {
  const payloadFile = path.resolve(__dirname, 'pulsexQuote.payloads.json');
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

const summarizeResult = (result: AutocannonResult): void => {
  const { latency, requests, throughput, non2xx, errors, timeouts, mismatches, duration } = result;

  const safeValue = (value?: number) => (typeof value === 'number' ? value.toFixed(2) : 'n/a');
  console.log('\n=== PulseX Stress Summary ===');
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

const main = () => {
  const targetUrlRaw = process.env.PULSEX_QUOTE_URL;
  if (!targetUrlRaw) {
    throw new Error('PULSEX_QUOTE_URL is required.');
  }

  const payloads = loadPayloads();
  const baseConcurrency = parseNumericEnv('PULSEX_STRESS_CONCURRENCY', 20);
  const durationSec = parseNumericEnv('PULSEX_STRESS_DURATION_SEC', 60);
  const maxRequestsPerConnection = parseNumericEnv('PULSEX_STRESS_MAX_REQUESTS_PER_CONN', 0);
  const connectionCap = parseNumericEnv('PULSEX_STRESS_CONNECTIONS', 100);
  const activeConnections = Math.max(1, Math.min(baseConcurrency, connectionCap));

  const parsedUrl = new URL(targetUrlRaw);
  const buildPath = buildPathFactory(parsedUrl.pathname || '/', new URLSearchParams(parsedUrl.search));

  console.log('[PulseX Stress] Loaded payloads:', payloads.length);
  console.log('[PulseX Stress] Target URL:', targetUrlRaw);
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
  });

  instance.once('done', (result: AutocannonResult) => {
    summarizeResult(result);
    process.exitCode = 0;
  });

  process.on('SIGINT', () => {
    console.log('\n[PulseX Stress] Caught SIGINT, stopping load...');
    instance.stop();
  });
};

try {
  main();
} catch (error) {
  console.error('[PulseX Stress] Unable to start benchmark:', error instanceof Error ? error.message : error);
  process.exit(1);
}
