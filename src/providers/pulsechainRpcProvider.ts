import '../config/env';
import { FallbackProvider, JsonRpcProvider, Provider, Network } from 'ethers';
import { Logger } from '../utils/logger';

const logger = new Logger('PulsechainRPC');

const parseNumericEnv = (keys: string[], fallback: number): number => {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined) {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
    logger.warn('rpc.config.invalidNumber', { key, value: raw, fallback });
  }
  return fallback;
};

const DEFAULT_PULSECHAIN_RPCS = [
  'https://rpc.pulsechain.com',
  'https://pulsechain-rpc.publicnode.com',
  'https://rpc-pulsechain.g4mm4.io',
];

const pulsechainNetwork = Network.from({ chainId: 369, name: 'pulsechain' });

const stallTimeoutMs = parseNumericEnv(['RPC_STALL_TIMEOUT_MS'], 1200);
const retryCount = parseNumericEnv(['RPC_RETRY_COUNT'], 2);
const retryDelayMs = parseNumericEnv(['RPC_RETRY_DELAY_MS'], 200);
const cooldownMs = parseNumericEnv(['RPC_COOLDOWN_MS'], 30000);

function parseRpcUrls(): string[] {
  const raw =
    process.env.PULSECHAIN_RPC_URLS ??
    process.env.RPC_URL ??
    DEFAULT_PULSECHAIN_RPCS.join(',');

  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return [...DEFAULT_PULSECHAIN_RPCS];
  }

  const unique = Array.from(new Set(urls));
  return unique;
}

const rpcUrls = parseRpcUrls();

const TRANSIENT_CODES = new Set([
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'OFFLINE',
  'TIMEOUT',
  'FETCH_ERROR',
  'BAD_DATA',
]);

const TRANSIENT_MESSAGE_RE = /(timeout|network|ECONN|EAI_AGAIN|ENOTFOUND|429|rate limit|temporarily unavailable)/i;

const createCooldownError = (url: string) => {
  const error = new Error(`RPC provider ${url} is in cooldown`);
  (error as any).code = 'RPC_COOLDOWN';
  return error;
};

const serializeError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  const err = error as any;
  return {
    code: err.code,
    status: err.status,
    message: err.message,
    shortMessage: err.shortMessage,
  };
};

const isTransientError = (error: any): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  if (typeof error.code === 'string' && TRANSIENT_CODES.has(error.code)) {
    return true;
  }

  if (typeof error.shortMessage === 'string' && TRANSIENT_MESSAGE_RE.test(error.shortMessage)) {
    return true;
  }

  if (typeof error.message === 'string' && TRANSIENT_MESSAGE_RE.test(error.message)) {
    return true;
  }

  return false;
};

class CircuitBreakerJsonRpcProvider extends JsonRpcProvider {
  private failedUntil = 0;

  constructor(private readonly rpcUrl: string) {
    super(rpcUrl, pulsechainNetwork);
  }

  override _getConnection() {
    const connection = super._getConnection();
    if (stallTimeoutMs > 0) {
      connection.timeout = stallTimeoutMs;
    }
    return connection;
  }

  override async send(method: string, params: Array<any>): Promise<any> {
    const now = Date.now();
    if (now < this.failedUntil) {
      logger.warn('rpc.cooldown.active', {
        url: this.rpcUrl,
        method,
        retryInMs: this.failedUntil - now,
      });
      throw createCooldownError(this.rpcUrl);
    }

    const startedAt = now;

    try {
      const result = await super.send(method, params);
      if (this.failedUntil !== 0) {
        this.failedUntil = 0;
        logger.info('rpc.recovered', { url: this.rpcUrl });
      }
      return result;
    } catch (error: any) {
      if (isTransientError(error)) {
        this.failedUntil = Date.now() + cooldownMs;
        logger.warn('rpc.fail', {
          url: this.rpcUrl,
          method,
          elapsedMs: Date.now() - startedAt,
          cooldownMs,
          error: serializeError(error),
        });
      }
      throw error;
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RetryingFallbackProvider extends FallbackProvider {
  constructor(
    configs: ConstructorParameters<typeof FallbackProvider>[0],
    quorum: number,
    private readonly attempts: number,
    private readonly retryDelay: number,
    network: Network
  ) {
    super(configs, network, { quorum });
  }

  override async _perform(req: any): Promise<any> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.attempts; attempt++) {
      try {
        return await super._perform(req);
      } catch (error: any) {
        lastError = error;
        const transient = isTransientError(error) || error?.code === 'RPC_COOLDOWN';
        if (!transient || attempt === this.attempts) {
          throw error;
        }

        logger.warn('rpc.retry', {
          method: req?.method,
          attempt: attempt + 1,
          maxAttempts: this.attempts + 1,
          error: serializeError(error),
        });

        if (this.retryDelay > 0) {
          await delay(this.retryDelay);
        }
      }
    }

    throw lastError;
  }
}

type ProviderEntry = {
  url: string;
  provider: CircuitBreakerJsonRpcProvider;
};

const createProviderEntries = (urls: string[]): ProviderEntry[] =>
  urls.map((url) => ({
    url,
    provider: new CircuitBreakerJsonRpcProvider(url),
  }));

const createFallbackProvider = (entries: ProviderEntry[]) =>
  new RetryingFallbackProvider(
    entries.map(({ provider }, index) => ({
      provider,
      priority: index + 1,
      stallTimeout: stallTimeoutMs,
      weight: 1,
    })),
    1,
    retryCount,
    retryDelayMs,
    pulsechainNetwork
  );

let providerEntries: ProviderEntry[] = createProviderEntries(rpcUrls);
let fallbackProvider = createFallbackProvider(providerEntries);
let initialized = false;
let initializationPromise: Promise<void> | null = null;

async function validateProviders(): Promise<void> {
  const results = await Promise.allSettled(
    providerEntries.map(async ({ provider, url }) => {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== 369) {
        throw new Error(`RPC ${url} returned chainId ${network.chainId}`);
      }
    })
  );

  const healthyEntries = providerEntries.filter((_, index) => results[index].status === 'fulfilled');

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('rpc.validate.fail', {
        url: providerEntries[index]?.url,
        error: serializeError(result.reason),
      });
    }
  });

  if (healthyEntries.length === 0) {
    throw new Error('No healthy PulseChain RPC providers configured');
  }

  if (healthyEntries.length !== providerEntries.length) {
    const dropped = providerEntries
      .filter((_, index) => results[index].status === 'rejected')
      .map((entry) => entry.url);
    providerEntries = healthyEntries;
    fallbackProvider = createFallbackProvider(providerEntries);
    logger.warn('rpc.validate.pruned', { dropped });
  }

  logger.info('rpc.validate.success', { urls: providerEntries.map((entry) => entry.url), healthy: healthyEntries.length });
}

export const initializePulsechainRpcProvider = async (): Promise<void> => {
  if (initialized) {
    return;
  }
  if (!initializationPromise) {
    initializationPromise = validateProviders()
      .then(() => {
        initialized = true;
      })
      .catch((error) => {
        logger.error('Failed to initialize PulseChain RPC providers', { error: serializeError(error) });
        throw error;
      });
  }
  await initializationPromise;
};

export const getPulsechainProvider = (): Provider => {
  if (!initialized) {
    throw new Error('PulseChain RPC provider accessed before initialization');
  }
  return fallbackProvider;
};

export const getPulsechainRpcUrls = (): string[] => providerEntries.map((entry) => entry.url);

export const getPrimaryPulsechainRpcUrl = (): string => getPulsechainRpcUrls()[0];

export const getPulsechainRpcConfig = () => ({
  urls: getPulsechainRpcUrls(),
  stallTimeoutMs,
  retryCount,
  retryDelayMs,
  cooldownMs,
});
