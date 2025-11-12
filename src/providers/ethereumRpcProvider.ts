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

const logger = new Logger('EthereumRPC');

const DEFAULT_ETHEREUM_RPCS = [
  'https://ethereum-rpc.publicnode.com',
  'https://ethereum.public.blockpi.network/v1/rpc/public',
  'https://eth.drpc.org',
];

const ethereumNetwork = Network.from({ chainId: 1, name: 'homestead' });

const stallTimeoutMs = parseNumericEnv(
  ['ETH_RPC_STALL_TIMEOUT_MS', 'RPC_STALL_TIMEOUT_MS'],
  1200,
  logger,
  'eth.rpc.config.invalidNumber'
);
const retryCount = parseNumericEnv(
  ['ETH_RPC_RETRY_COUNT', 'RPC_RETRY_COUNT'],
  2,
  logger,
  'eth.rpc.config.invalidNumber'
);
const retryDelayMs = parseNumericEnv(
  ['ETH_RPC_RETRY_DELAY_MS', 'RPC_RETRY_DELAY_MS'],
  200,
  logger,
  'eth.rpc.config.invalidNumber'
);
const cooldownMs = parseNumericEnv(
  ['ETH_RPC_COOLDOWN_MS', 'RPC_COOLDOWN_MS'],
  30000,
  logger,
  'eth.rpc.config.invalidNumber'
);

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

const TRANSIENT_CODES = new Set<string>([
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'OFFLINE',
  'TIMEOUT',
  'FETCH_ERROR',
  'BAD_DATA',
]);

const TRANSIENT_MESSAGE_RE = /(timeout|network|ECONN|EAI_AGAIN|ENOTFOUND|429|rate limit|temporarily unavailable)/i;

const errorClassifier = createDefaultClassifier({
  transientCodes: TRANSIENT_CODES,
  transientMessagePattern: TRANSIENT_MESSAGE_RE,
  rateLimitMessagePattern: /(429|rate limit)/i,
});

const createProviderEntries = (urls: string[]): ProviderEntry[] =>
  urls.map((url) => ({
    url,
    provider: new CircuitBreakerJsonRpcProvider(url, {
      network: ethereumNetwork,
      stallTimeoutMs,
      cooldownMs,
      logger,
      logKey: 'eth.rpc',
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
    ethereumNetwork,
    {
      quorum: 1,
      attempts: retryCount,
      retryDelayMs,
      logger,
      logKey: 'eth.rpc',
      classifier: errorClassifier,
      fallbackErrorMessage: 'Ethereum RPC request failed after retries',
    }
  );

let providerEntries: ProviderEntry[] = createProviderEntries(rpcUrls);
let fallbackProvider = createFallbackProvider(providerEntries);
let initialized = false;
let initializationPromise: Promise<void> | null = null;

async function validateProviders(): Promise<void> {
  const healthyEntries = await validateRpcProviders({
    entries: providerEntries,
    expectedChainId: 1,
    logger,
    logKey: 'eth.rpc',
    failureMessage: 'No healthy Ethereum RPC providers configured.',
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
        initializationPromise = null;
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

export const getPrimaryEthereumRpcUrl = (): string => getEthereumRpcUrls()[0];

export const getEthereumRpcConfig = () => ({
  urls: getEthereumRpcUrls(),
  stallTimeoutMs,
  retryCount,
  retryDelayMs,
  cooldownMs,
});
