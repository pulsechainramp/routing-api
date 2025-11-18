import baseConfig from '.';
import type { Address, PulsexToken } from '../types/pulsex';

const asAddress = (value: string): Address => value as Address;

const envAddress = (envKey: string, fallback: Address): Address => {
  const value = process.env[envKey];
  return value ? (value as Address) : fallback;
};

const parseNumberEnv = (envKey: string, fallback: number): number => {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBooleanEnv = (envKey: string, fallback: boolean): boolean => {
  const raw = process.env[envKey];
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

export const PULSECHAIN_CHAIN_ID = 369;

const DEFAULT_PLSX_ADDRESS = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' as Address;
const DEFAULT_WETH_ADDRESS = '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C' as Address;
const DEFAULT_HEX_ADDRESS = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' as Address;
const DEFAULT_INC_ADDRESS = '0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d' as Address;

const coreConnectorTokenMetadata: PulsexToken[] = [
  {
    address: asAddress(baseConfig.WPLS),
    decimals: 18,
    symbol: 'WPLS',
    name: 'Wrapped Pulse',
    isNative: true,
  },
  {
    address: envAddress('PLSX_ADDRESS', DEFAULT_PLSX_ADDRESS),
    decimals: 18,
    symbol: 'PLSX',
    name: 'PulseX',
  },
  {
    address: asAddress(baseConfig.USDC),
    decimals: 6,
    symbol: 'USDC',
    name: 'USDC from Ethereum',
  },
  {
    address: asAddress(baseConfig.USDT),
    decimals: 6,
    symbol: 'USDT',
    name: 'USDT from Ethereum',
  },
  {
    address: asAddress(baseConfig.DAI),
    decimals: 18,
    symbol: 'DAI',
    name: 'DAI from Ethereum',
  },
];

const extraConnectorTokenMetadata: PulsexToken[] = [
  {
    address: envAddress('WETH_ADDRESS', DEFAULT_WETH_ADDRESS),
    decimals: 18,
    symbol: 'WETH',
    name: 'WETH from Ethereum',
  },
  {
    address: envAddress('HEX_ADDRESS', DEFAULT_HEX_ADDRESS),
    decimals: 8,
    symbol: 'HEX',
    name: 'HEX',
  },
  {
    address: envAddress('INC_ADDRESS', DEFAULT_INC_ADDRESS),
    decimals: 18,
    symbol: 'INC',
    name: 'Incentive',
  },
];

const includeExtraConnectors = parseBooleanEnv('PULSEX_EXTRA_CONNECTORS_ENABLED', true);
const connectorTokenMetadata = includeExtraConnectors
  ? [...coreConnectorTokenMetadata, ...extraConnectorTokenMetadata]
  : coreConnectorTokenMetadata;

const uniqueConnectorTokens = connectorTokenMetadata.filter(
  (token, index, array) => array.findIndex((candidate) => candidate.address === token.address) === index,
);

const stableTokenAddresses = new Set<Address>([
  asAddress(baseConfig.USDC),
  asAddress(baseConfig.USDT),
  asAddress(baseConfig.DAI),
]);

const stableTokens = uniqueConnectorTokens.filter((token) => stableTokenAddresses.has(token.address));
const usdStableToken = stableTokens.find((token) => token.address === asAddress(baseConfig.USDC));
if (!usdStableToken) {
  throw new Error('USDC metadata missing from connector tokens; cannot configure PulseX oracle');
}

const stableRoutingDefaults = {
  enabled: parseBooleanEnv('PULSEX_STABLE_ROUTING_ENABLED', true),
  useStableForStableToStable: parseBooleanEnv(
    'PULSEX_STABLE_ROUTING_USE_STABLE_FOR_STABLE',
    true,
  ),
  useStableAsConnectorToPLS: parseBooleanEnv(
    'PULSEX_STABLE_ROUTING_USE_STABLE_CONNECTOR_FOR_PLS',
    true,
  ),
  maxStablePivots: Math.max(1, parseNumberEnv('PULSEX_STABLE_ROUTING_MAX_PIVOTS', 3)),
};

export const PULSEX_CONNECTOR_TOKENS = uniqueConnectorTokens.map((token) => token.address);
export const PULSEX_STABLE_TOKENS = stableTokens.map((token) => token.address);
export const MAX_CONNECTOR_HOPS = parseNumberEnv('PULSEX_MAX_CONNECTOR_HOPS', 1);
export const MAX_STABLE_COINS = 3;
export const RESERVES_TTL_MS = parseNumberEnv('PULSEX_RESERVES_CACHE_TTL_MS', 15_000);
export const STABLE_INDEX_TTL_MS = parseNumberEnv('PULSEX_STABLE_INDEX_TTL_MS', 300_000);
export const PRICE_CACHE_TTL_MS = parseNumberEnv('PULSEX_PRICE_CACHE_TTL_MS', 15_000);
export const QUOTE_TIMEOUT_MS = parseNumberEnv('PULSEX_QUOTE_TIMEOUT_MS', 3_000);
export const QUOTE_CONCURRENCY = parseNumberEnv('PULSEX_QUOTE_CONCURRENCY', 6);
export const QUOTE_MAX_ROUTES = parseNumberEnv('PULSEX_QUOTE_MAX_ROUTES', 40);
export const ENABLE_SPLIT_ROUTES = parseBooleanEnv('PULSEX_SPLIT_ROUTES_ENABLED', false);
export const SPLIT_WEIGHTS = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
export const GAS_BASE_UNITS = 150_000;
export const GAS_UNITS_PER_LEG = 50_000;

export interface PulsexConfig {
  chainId: number;
  affiliateRouter: Address;
  factories: {
    v1: Address;
    v2: Address;
  };
  routers: {
    v1: Address;
    v2: Address;
    default: Address;
  };
  stablePoolAddress: Address;
  connectorTokens: PulsexToken[];
  stableTokens: PulsexToken[];
  stableRouting: {
    enabled: boolean;
    useStableForStableToStable: boolean;
    useStableAsConnectorToPLS: boolean;
    maxStablePivots: number;
  };
  fees: {
    v1FeeBps: number;
    v2FeeBps: number;
  };
  maxConnectorHops: number;
  cacheTtlMs: {
    reserves: number;
    stableIndex: number;
    priceOracle: number;
  };
  quoteEvaluation: {
    timeoutMs: number;
    concurrency: number;
    maxRoutes?: number;
  };
  splitConfig: {
    enabled: boolean;
    weights: number[];
  };
  usdStableToken: PulsexToken;
  gasConfig: {
    baseGasUnits: number;
    gasPerLegUnits: number;
  };
}

export const pulsexConfig: PulsexConfig = {
  chainId: PULSECHAIN_CHAIN_ID,
  affiliateRouter: asAddress(baseConfig.AffiliateRouterAddress),
  factories: {
    v1: asAddress(baseConfig.PulsexV1FactoryAddress),
    v2: asAddress(baseConfig.PulsexV2FactoryAddress),
  },
  routers: {
    v1: asAddress(baseConfig.PulsexV1RouterAddress),
    v2: asAddress(baseConfig.PulsexV2RouterAddress),
    default: asAddress(baseConfig.PulsexV2RouterAddress),
  },
  stablePoolAddress: envAddress('PULSEX_STABLE_POOL_ADDRESS', asAddress(baseConfig.PulsexStablePoolAddress)),
  connectorTokens: uniqueConnectorTokens,
  stableTokens,
  stableRouting: {
    enabled: stableRoutingDefaults.enabled,
    useStableForStableToStable: stableRoutingDefaults.useStableForStableToStable,
    useStableAsConnectorToPLS: stableRoutingDefaults.useStableAsConnectorToPLS,
    maxStablePivots: stableRoutingDefaults.maxStablePivots,
  },
  fees: {
    v1FeeBps: 25,
    v2FeeBps: 25,
  },
  maxConnectorHops: MAX_CONNECTOR_HOPS,
  cacheTtlMs: {
    reserves: RESERVES_TTL_MS,
    stableIndex: STABLE_INDEX_TTL_MS,
    priceOracle: PRICE_CACHE_TTL_MS,
  },
  quoteEvaluation: {
    timeoutMs: QUOTE_TIMEOUT_MS,
    concurrency: QUOTE_CONCURRENCY,
    maxRoutes: QUOTE_MAX_ROUTES,
  },
  splitConfig: {
    enabled: ENABLE_SPLIT_ROUTES,
    weights: SPLIT_WEIGHTS,
  },
  usdStableToken: usdStableToken,
  gasConfig: {
    baseGasUnits: GAS_BASE_UNITS,
    gasPerLegUnits: GAS_UNITS_PER_LEG,
  },
};

export default pulsexConfig;
