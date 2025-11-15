import baseConfig from '.';
import type { Address, PulsexToken } from '../types/pulsex';

const asAddress = (value: string): Address => value as Address;

const envAddress = (envKey: string, fallback: Address): Address => {
  const value = process.env[envKey];
  return value ? (value as Address) : fallback;
};

export const PULSECHAIN_CHAIN_ID = 369;

const DEFAULT_PLSX_ADDRESS = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' as Address;
const DEFAULT_WETH_ADDRESS = '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C' as Address;
const DEFAULT_HEX_ADDRESS = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' as Address;
const DEFAULT_INC_ADDRESS = '0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d' as Address;

const connectorTokenMetadata: PulsexToken[] = [
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

export const PULSEX_CONNECTOR_TOKENS = uniqueConnectorTokens.map((token) => token.address);
export const PULSEX_STABLE_TOKENS = stableTokens.map((token) => token.address);
export const MAX_CONNECTOR_HOPS = 2;
export const MAX_STABLE_COINS = 3;
export const RESERVES_TTL_MS = 15_000;
export const STABLE_INDEX_TTL_MS = 300_000;
export const PRICE_CACHE_TTL_MS = 15_000;
export const QUOTE_TIMEOUT_MS = 4_000;
export const QUOTE_CONCURRENCY = 4;
export const ENABLE_SPLIT_ROUTES = true;
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
  fees: {
    v1FeeBps: number;
    v2FeeBps: number;
  };
  maxConnectorHops: number;
  cacheTtlMs: {
    reserves: number;
    stableIndex: number;
  };
  priceOracle: {
    cacheTtlMs: number;
  };
  quoteEvaluation: {
    timeoutMs: number;
    concurrency: number;
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
  stablePoolAddress: asAddress(baseConfig.PulsexStablePoolAddress),
  connectorTokens: uniqueConnectorTokens,
  stableTokens,
  fees: {
    v1FeeBps: 25,
    v2FeeBps: 25,
  },
  maxConnectorHops: MAX_CONNECTOR_HOPS,
  cacheTtlMs: {
    reserves: RESERVES_TTL_MS,
    stableIndex: STABLE_INDEX_TTL_MS,
  },
  priceOracle: {
    cacheTtlMs: PRICE_CACHE_TTL_MS,
  },
  quoteEvaluation: {
    timeoutMs: QUOTE_TIMEOUT_MS,
    concurrency: QUOTE_CONCURRENCY,
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
