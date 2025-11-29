import { Interface } from 'ethers';
import type { Provider } from 'ethers';
import { PulseXPriceOracle } from './PulseXPriceOracle';
import type { PulsexConfig } from '../config/pulsex';
import type { Address, PulsexToken } from '../types/pulsex';

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
      getPair: jest.fn().mockResolvedValue(address === '0xFALLBACK' ? '0xpair' : '0x0'),
      token0: jest.fn().mockResolvedValue('0x0'),
      token1: jest.fn().mockResolvedValue('0x0'),
      getReserves: jest.fn().mockResolvedValue([0n, 0n, 0]),
    })),
    Interface: actual.Interface,
  };
});

const toAddress = (value: string): Address => (`0x${value.padStart(40, '0')}`) as Address;

const WPLS: PulsexToken = { address: toAddress('1'), decimals: 18, symbol: 'WPLS', isNative: true };
const USDC: PulsexToken = { address: toAddress('2'), decimals: 6, symbol: 'USDC' };

const BASE_CONFIG: PulsexConfig = {
  chainId: 369,
  affiliateRouter: toAddress('10'),
  factories: {
    v1: '0xFALLBACK' as Address,
    v2: toAddress('12'),
  },
  routers: {
    v1: toAddress('13'),
    v2: toAddress('14'),
    default: toAddress('14'),
  },
  stablePoolAddress: toAddress('15'),
  connectorTokens: [WPLS, USDC],
  stableTokens: [USDC],
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
  usdStableToken: USDC,
  gasConfig: { baseGasUnits: 150_000, gasPerLegUnits: 50_000 },
  multicall: {
    enabled: true,
    address: toAddress('99'),
    maxBatchSize: 10,
    timeoutMs: 500,
  },
};

describe('PulseXPriceOracle multicall', () => {
  beforeEach(() => {
    executeMock.mockReset();
    isEnabledMock.mockReturnValue(true);
  });

  it('uses multicall to fetch pair data and compute price', async () => {
    const pairInterface = new Interface([
      'function token0() view returns (address)',
      'function token1() view returns (address)',
      'function getReserves() view returns (uint112,uint112,uint32)',
    ]);

    executeMock
      .mockResolvedValueOnce([
        { success: true, returnData: new Interface(['function getPair(address,address) view returns (address)']).encodeFunctionResult('getPair', [toAddress('aa')]) },
        { success: true, returnData: '0x' },
      ])
      .mockResolvedValueOnce([
        { success: true, returnData: pairInterface.encodeFunctionResult('token0', [WPLS.address]) },
        { success: true, returnData: pairInterface.encodeFunctionResult('token1', [USDC.address]) },
        { success: true, returnData: pairInterface.encodeFunctionResult('getReserves', [10_000_000_000_000_000_000n, 20_000_000n, 0]) },
      ]);

    const oracle = new PulseXPriceOracle({} as Provider, BASE_CONFIG);
    const price = await oracle.getPlsPriceUsd();

    expect(price).toBeCloseTo(2); // 20 USDC / 10 WPLS
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to sequential calls when multicall fails', async () => {
    const ethers = jest.requireMock('ethers');
    const contractMock = ethers.Contract as jest.Mock;
    contractMock.mockImplementation(() => ({
      target: BASE_CONFIG.factories.v2,
      interface: new Interface(['function getPair(address,address) view returns (address)']),
      getPair: jest.fn().mockResolvedValue('0xpair'),
      token0: jest.fn().mockResolvedValue(WPLS.address),
      token1: jest.fn().mockResolvedValue(USDC.address),
      getReserves: jest.fn().mockResolvedValue([10_000_000_000_000_000_000n, 20_000_000n, 0]),
    }));
    // Disable multicall so sequential path is exercised
    isEnabledMock.mockReturnValue(false);
    executeMock.mockRejectedValueOnce(new Error('mc-fail'));

    const oracle = new PulseXPriceOracle({} as Provider, BASE_CONFIG);
    const price = await oracle.getPlsPriceUsd();
    expect(price).toBeCloseTo(2);
  });
});
