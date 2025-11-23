import type { Provider } from 'ethers';
import { PulseXPriceOracle } from './PulseXPriceOracle';
import type { PulsexConfig } from '../config/pulsex';
import type { PulsexToken } from '../types/pulsex';

const mockFactories: Record<string, any> = {};
const mockPairs: Record<string, any> = {};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation((address: string) => {
      const lower = address.toLowerCase();
      if (mockFactories[lower]) {
        return mockFactories[lower];
      }
      if (mockPairs[lower]) {
        return mockPairs[lower];
      }
      throw new Error(`No mock defined for contract ${address}`);
    }),
  };
});

const resetContractMocks = () => {
  Object.keys(mockFactories).forEach((key) => delete mockFactories[key]);
  Object.keys(mockPairs).forEach((key) => delete mockPairs[key]);
};

const token = (
  address: string,
  decimals: number,
  symbol: string,
  extras: Partial<PulsexToken> = {},
): PulsexToken => ({
  address: address as `0x${string}`,
  decimals,
  symbol,
  ...extras,
});

const WPLS = token('0x0000000000000000000000000000000000000001', 18, 'WPLS', {
  isNative: true,
});
const USDC = token('0x0000000000000000000000000000000000000002', 6, 'USDC');

const BASE_CONFIG: PulsexConfig = {
  chainId: 369,
  affiliateRouter: '0x00000000000000000000000000000000000000aa',
  factories: {
    v1: '0x00000000000000000000000000000000000000a1',
    v2: '0x00000000000000000000000000000000000000a2',
  },
  routers: {
    v1: '0x00000000000000000000000000000000000000b1',
    v2: '0x00000000000000000000000000000000000000b2',
    default: '0x00000000000000000000000000000000000000b2',
  },
  stablePoolAddress: '0x00000000000000000000000000000000000000c1',
  connectorTokens: [WPLS, USDC],
  stableTokens: [USDC],
  stableRouting: {
    enabled: true,
    useStableForStableToStable: true,
    useStableAsConnectorToPLS: true,
    maxStablePivots: 2,
  },
  fees: {
    v1FeeBps: 25,
    v2FeeBps: 25,
  },
  maxConnectorHops: 2,
  cacheTtlMs: {
    reserves: 1_000,
    stableIndex: 1_000,
    priceOracle: 5_000,
  },
  quoteEvaluation: {
    timeoutMs: 1_000,
    concurrency: 2,
  },
  splitConfig: {
    enabled: false,
    weights: [],
  },
  usdStableToken: USDC,
  gasConfig: {
    baseGasUnits: 150_000,
    gasPerLegUnits: 50_000,
  },
  multicall: {
    enabled: false,
    address: '0x0000000000000000000000000000000000000aaa',
    maxBatchSize: 20,
    timeoutMs: 1_000,
  },
};

const registerFactory = (address: string, impl: any) => {
  mockFactories[address.toLowerCase()] = impl;
};

const registerPair = (address: string, impl: any) => {
  mockPairs[address.toLowerCase()] = impl;
};

describe('PulseXPriceOracle', () => {
  beforeEach(() => {
    resetContractMocks();
  });

  it('returns cached price when within TTL', async () => {
    const pairAddress = '0x0000000000000000000000000000000000000aaa';
    registerFactory(BASE_CONFIG.factories.v2, {
      getPair: jest.fn().mockResolvedValue(pairAddress),
    });
    registerFactory(BASE_CONFIG.factories.v1, {
      getPair: jest.fn().mockResolvedValue('0x0'),
    });
    registerPair(pairAddress, {
      token0: jest.fn().mockResolvedValue(WPLS.address),
      token1: jest.fn().mockResolvedValue(USDC.address),
      getReserves: jest.fn().mockResolvedValue([10_000_000_000_000_000_000n, 10_000_000n, 0]),
    });

    const oracle = new PulseXPriceOracle({} as Provider, BASE_CONFIG);
    const first = await oracle.getPlsPriceUsd();
    const second = await oracle.getPlsPriceUsd();

    expect(first).toBeCloseTo(second);
  });

  it('falls back to V1 factory when V2 pair is missing', async () => {
    const pairAddress = '0x0000000000000000000000000000000000000bbb';
    registerFactory(BASE_CONFIG.factories.v2, {
      getPair: jest.fn().mockResolvedValue('0x0'),
    });
    registerFactory(BASE_CONFIG.factories.v1, {
      getPair: jest.fn().mockResolvedValue(pairAddress),
    });
    registerPair(pairAddress, {
      token0: jest.fn().mockResolvedValue(USDC.address),
      token1: jest.fn().mockResolvedValue(WPLS.address),
      getReserves: jest.fn().mockResolvedValue([10_000_000n, 10_000_000_000_000_000_000n, 0]),
    });

    const oracle = new PulseXPriceOracle({} as Provider, BASE_CONFIG);
    const price = await oracle.getPlsPriceUsd();

    expect(price).toBeGreaterThan(0);
    const v1Factory = mockFactories[BASE_CONFIG.factories.v1.toLowerCase()];
    expect(v1Factory.getPair).toHaveBeenCalled();
  });

  it('throws when neither factory yields a usable price', async () => {
    registerFactory(BASE_CONFIG.factories.v2, {
      getPair: jest.fn().mockResolvedValue('0x0'),
    });
    registerFactory(BASE_CONFIG.factories.v1, {
      getPair: jest.fn().mockResolvedValue('0x0'),
    });

    const oracle = new PulseXPriceOracle({} as Provider, BASE_CONFIG);
    await expect(oracle.getPlsPriceUsd()).rejects.toThrow(
      'Unable to determine WPLS/USDC price from PulseX pairs',
    );
  });
});
