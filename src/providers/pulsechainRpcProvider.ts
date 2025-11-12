import '../config/env';
import { Provider, Network } from 'ethers';
import { Logger } from '../utils/logger';
import {
  CircuitBreakerJsonRpcProvider,
  RetryingFallbackProvider,
  createDefaultClassifier,
  parseNumericEnv,
  serializeError,
  type ProviderEntry,
  validateRpcProviders,
} from './rpcShared';
import { resolvePulsechainRpcUrls } from '../config/pulsechainRpcUrls';

const logger = new Logger('PulsechainRPC');

const pulsechainNetwork = Network.from({ chainId: 369, name: 'pulsechain' });

const stallTimeoutMs = parseNumericEnv(['RPC_STALL_TIMEOUT_MS'], 1200, logger, 'rpc.config.invalidNumber');
const retryCount = parseNumericEnv(['RPC_RETRY_COUNT'], 2, logger, 'rpc.config.invalidNumber');
const retryDelayMs = parseNumericEnv(['RPC_RETRY_DELAY_MS'], 200, logger, 'rpc.config.invalidNumber');
const cooldownMs = parseNumericEnv(['RPC_COOLDOWN_MS'], 30000, logger, 'rpc.config.invalidNumber');
const rateLimitCooldownMs = parseNumericEnv(
  ['RPC_RATE_LIMIT_COOLDOWN_MS'],
  Math.max(cooldownMs * 2, 60000),
  logger,
  'rpc.config.invalidNumber'
);

const rpcUrls = resolvePulsechainRpcUrls();

const TRANSIENT_CODES = new Set<string>([
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'OFFLINE',
  'TIMEOUT',
  'FETCH_ERROR',
  'BAD_DATA',
]);

const TRANSIENT_MESSAGE_RE = /(timeout|network|ECONN|EAI_AGAIN|ENOTFOUND|temporarily unavailable)/i;
const RATE_LIMIT_MESSAGE_RE = /(429|rate limit)/i;

const errorClassifier = createDefaultClassifier({
  transientCodes: TRANSIENT_CODES,
  transientMessagePattern: TRANSIENT_MESSAGE_RE,
  rateLimitMessagePattern: RATE_LIMIT_MESSAGE_RE,
});

const createProviderEntries = (urls: string[]): ProviderEntry[] =>
  urls.map((url) => ({
    url,
    provider: new CircuitBreakerJsonRpcProvider(url, {
      network: pulsechainNetwork,
      stallTimeoutMs,
      cooldownMs,
      rateLimitCooldownMs,
      logger,
      logKey: 'rpc',
      classifier: errorClassifier,
    }),
  }));

const createFallbackProvider = (entries: ProviderEntry[]) =>
  new RetryingFallbackProvider(
    entries.map(({ provider }, index) => ({
      provider,
      priority: index + 1,
      stallTimeout: stallTimeoutMs,
      weight: 1,
    })),
    pulsechainNetwork,
    {
      quorum: 1,
      attempts: retryCount,
      retryDelayMs,
      logger,
      logKey: 'rpc',
      classifier: errorClassifier,
      fallbackErrorMessage: 'PulseChain RPC request failed after retries',
    }
  );

let providerEntries: ProviderEntry[] = createProviderEntries(rpcUrls);
let fallbackProvider = createFallbackProvider(providerEntries);
let initialized = false;
let initializationPromise: Promise<void> | null = null;

async function validateProviders(): Promise<void> {
  const healthyEntries = await validateRpcProviders({
    entries: providerEntries,
    expectedChainId: 369,
    logger,
    logKey: 'rpc',
    failureMessage: 'No healthy PulseChain RPC providers configured.',
    extraCheck: async (provider, url) => {
      let blockNumber: number;
      try {
        blockNumber = await provider.getBlockNumber();
      } catch (err) {
        throw new Error(`RPC ${url} failed getBlockNumber: ${(err as Error)?.message ?? err}`);
      }
      if (!Number.isFinite(blockNumber) || blockNumber < 0) {
        throw new Error(`RPC ${url} returned invalid blockNumber: ${blockNumber}`);
      }
    },
  });

  const changed =
    healthyEntries.length !== providerEntries.length ||
    healthyEntries.some((entry, index) => entry.url !== providerEntries[index]?.url);

  if (changed) {
    providerEntries = healthyEntries;
    fallbackProvider = createFallbackProvider(providerEntries);
  }
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
        initializationPromise = null;
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
  rateLimitCooldownMs,
});
