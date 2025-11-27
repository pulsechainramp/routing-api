import { Interface } from 'ethers';
import type { Address, PulsexToken } from '../types/pulsex';
import { PulseXQuoter } from './PulseXQuoter';
import type { PulsexConfig } from '../config/pulsex';

const executeMock = jest.fn();
const isEnabledMock = jest.fn().mockReturnValue(true);

jest.mock('../utils/multicall', () => ({
  MulticallClient: jest.fn().mockImplementation(() => ({
    execute: executeMock,
    isEnabled: isEnabledMock,
  })),
}));

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation((address: string) => ({
      target: address,
      interface: new actual.Interface(['function getPair(address,address) view returns (address)']),
    })),
    Interface: actual.Interface,
  };
});

const toAddress = (value: string): Address => (`0x${value.padStart(40, '0')}`) as Address;

const TOKENS: Record<string, PulsexToken> = {
  wpls: { address: toAddress('1'), decimals: 18, symbol: 'WPLS', isNative: true },
  usdc: { address: toAddress('2'), decimals: 6, symbol: 'USDC' },
};

const BASE_CONFIG: PulsexConfig = {
  chainId: 369,
  affiliateRouter: toAddress('10'),
  factories: {
    v1: toAddress('11'),
    v2: toAddress('12'),
  },
  routers: {
    v1: toAddress('13'),
    v2: toAddress('14'),
    default: toAddress('14'),
  },
  stablePoolAddress: toAddress('15'),
  connectorTokens: [TOKENS.wpls, TOKENS.usdc],
  stableTokens: [TOKENS.usdc],
  stableRouting: {
    enabled: true,
    useStableAsConnectorToPLS: true,
    maxStablePivots: 1,
  },
  fees: { v1FeeBps: 29, v2FeeBps: 29 },
  maxConnectorHops: 1,
  cacheTtlMs: { reserves: 1_000, stableIndex: 1_000, priceOracle: 1_000 },
  quoteEvaluation: { timeoutMs: 1_000, concurrency: 2, totalBudgetMs: 7_000 },
  splitConfig: { enabled: false, weights: [], maxRoutes: 2, minImprovementBps: 0, minUsdValue: 0 },
  usdStableToken: TOKENS.usdc,
  gasConfig: { baseGasUnits: 150_000, gasPerLegUnits: 50_000 },
  multicall: {
    enabled: true,
    address: toAddress('99'),
    maxBatchSize: 10,
    timeoutMs: 500,
  },
};

describe('PulseXQuoter multicall reserve loading', () => {
  beforeEach(() => {
    executeMock.mockReset();
    isEnabledMock.mockReturnValue(true);
  });

  it('loads reserves via multicall and populates cache', async () => {
    const pairAddress = toAddress('aa');
    const pairInterface = new Interface([
      'function token0() view returns (address)',
      'function token1() view returns (address)',
      'function getReserves() view returns (uint112,uint112,uint32)',
    ]);

    executeMock
      .mockResolvedValueOnce([
        { success: true, returnData: new Interface(['function getPair(address,address) view returns (address)']).encodeFunctionResult('getPair', [pairAddress]) },
      ])
      .mockResolvedValueOnce([
        { success: true, returnData: pairInterface.encodeFunctionResult('token0', [TOKENS.wpls.address]) },
        { success: true, returnData: pairInterface.encodeFunctionResult('token1', [TOKENS.usdc.address]) },
        { success: true, returnData: pairInterface.encodeFunctionResult('getReserves', [1_000_000n, 2_000_000n, 0]) },
      ]);

    const quoter = new PulseXQuoter({} as any, BASE_CONFIG);

    const cacheKey = `PULSEX_V2:${[TOKENS.usdc.address.toLowerCase(), TOKENS.wpls.address.toLowerCase()].sort().join('>')}`;
    const loaded = await (quoter as any).loadReservesForLegsWithMulticall([
      { protocol: 'PULSEX_V2', tokenIn: TOKENS.wpls, tokenOut: TOKENS.usdc },
    ]);

    expect(loaded?.has(cacheKey)).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('returns null and falls back when multicall is disabled', async () => {
    isEnabledMock.mockReturnValue(false);
    const quoter = new PulseXQuoter({} as any, BASE_CONFIG);
    const loaded = await (quoter as any).loadReservesForLegsWithMulticall([
      { protocol: 'PULSEX_V2', tokenIn: TOKENS.wpls, tokenOut: TOKENS.usdc },
    ]);
    expect(loaded).toBeNull();
  });
});
