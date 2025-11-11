import '../config/env';
import { FallbackProvider, JsonRpcProvider, Provider, Network } from 'ethers';
import { Logger } from '../utils/logger';

const logger = new Logger('EthereumRPC');
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
    logger.warn('eth.rpc.config.invalidNumber', { key, value: raw, fallback });
  }
  return fallback;
};

const ethereumNetwork = Network.from({ chainId: 1, name: 'homestead' });

const DEFAULT_ETHEREUM_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://ethereum.public.blockpi.network/v1/rpc/public',
  'https://eth.drpc.org',
];

const stallTimeoutMs = parseNumericEnv(['ETH_RPC_STALL_TIMEOUT_MS', 'RPC_STALL_TIMEOUT_MS'], 1200);
const retryCount = parseNumericEnv(['ETH_RPC_RETRY_COUNT', 'RPC_RETRY_COUNT'], 2);
const retryDelayMs = parseNumericEnv(['ETH_RPC_RETRY_DELAY_MS', 'RPC_RETRY_DELAY_MS'], 200);
const cooldownMs = parseNumericEnv(['ETH_RPC_COOLDOWN_MS', 'RPC_COOLDOWN_MS'], 30000);

function parseRpcUrls(): string[] {
  const raw =
    process.env.ETHEREUM_RPC_URLS ??
    process.env.ETH_RPC_URL ??
    DEFAULT_ETHEREUM_RPCS.join(',');

  const urls = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    return [...DEFAULT_ETHEREUM_RPCS];
  }

  return Array.from(new Set(urls));
}

const rpcUrls = parseRpcUrls();

const TRANSIENT_CODES = new Set(['SERVER_ERROR', 'NETWORK_ERROR', 'OFFLINE', 'TIMEOUT', 'FETCH_ERROR', 'BAD_DATA']);
const TRANSIENT_MESSAGE_RE = /(timeout|network|ECONN|EAI_AGAIN|ENOTFOUND|429|rate limit|temporarily unavailable)/i;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    super(rpcUrl, ethereumNetwork);
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
      const error = new Error(`RPC provider ${this.rpcUrl} is in cooldown`);
      (error as any).code = 'RPC_COOLDOWN';
      logger.warn('eth.rpc.cooldown', { url: this.rpcUrl, method });
      throw error;
    }

    const startedAt = now;
    try {
      const result = await super.send(method, params);
      if (this.failedUntil !== 0) {
        this.failedUntil = 0;
        logger.info('eth.rpc.recovered', { url: this.rpcUrl });
      }
      return result;
    } catch (error: any) {
      if (isTransientError(error)) {
        this.failedUntil = Date.now() + cooldownMs;
        logger.warn('eth.rpc.fail', {
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

        logger.warn('eth.rpc.retry', {
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
    ethereumNetwork
  );

let providerEntries: ProviderEntry[] = createProviderEntries(rpcUrls);
let fallbackProvider = createFallbackProvider(providerEntries);
let initialized = false;
let initializationPromise: Promise<void> | null = null;

async function validateProviders(): Promise<void> {
  const results = await Promise.allSettled(
    providerEntries.map(async ({ provider, url }) => {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== 1) {
        throw new Error(`RPC ${url} returned chainId ${network.chainId}`);
      }
    })
  );

  const healthyEntries = providerEntries.filter((_, index) => results[index].status === 'fulfilled');

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('eth.rpc.validate.fail', {
        url: providerEntries[index]?.url,
        error: serializeError(result.reason),
      });
    }
  });

  if (healthyEntries.length === 0) {
    throw new Error('No healthy Ethereum RPC providers configured');
  }

  if (healthyEntries.length !== providerEntries.length) {
    const dropped = providerEntries
      .filter((_, index) => results[index].status === 'rejected')
      .map((entry) => entry.url);
    providerEntries = healthyEntries;
    fallbackProvider = createFallbackProvider(providerEntries);
    logger.warn('eth.rpc.validate.pruned', { dropped });
  }

  logger.info('eth.rpc.validate.success', { urls: providerEntries.map((entry) => entry.url), healthy: healthyEntries.length });
}

export const initializeEthereumRpcProvider = async (): Promise<void> => {
  if (initialized) {
    return;
  }
  if (!initializationPromise) {
    initializationPromise = validateProviders()
      .then(() => {
        initialized = true;
      })
      .catch((error) => {
        logger.error('Failed to initialize Ethereum RPC providers', { error: serializeError(error) });
        throw error;
      });
  }
  await initializationPromise;
};

export const getEthereumProvider = (): Provider => {
  if (!initialized) {
    throw new Error('Ethereum RPC provider accessed before initialization');
  }
  return fallbackProvider;
};

export const getEthereumRpcUrls = (): string[] => providerEntries.map((entry) => entry.url);
