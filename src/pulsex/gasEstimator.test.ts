import type { Provider } from 'ethers';
import type { PulsexConfig } from '../config/pulsex';
import { PulsexGasEstimator } from './gasEstimator';

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
  connectorTokens: [],
  stableTokens: [],
  stableRouting: {
    enabled: true,
    useStableAsConnectorToPLS: true,
    maxStablePivots: 2,
  },
  fees: {
    v1FeeBps: 29,
    v2FeeBps: 29,
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
    totalBudgetMs: 7_000,
  },
  splitConfig: {
    enabled: false,
    weights: [],
    maxRoutes: 2,
    minImprovementBps: 0,
    minUsdValue: 0,
  },
  usdStableToken: {
    address: '0x00000000000000000000000000000000000000d1',
    decimals: 6,
    symbol: 'USDC',
  },
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

const mockProvider = (gasPrice: bigint | undefined) =>
  ({
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
  }) as unknown as Provider;

describe('PulsexGasEstimator', () => {
  it('computes gas units using base plus per-leg multiplier', async () => {
    const estimator = new PulsexGasEstimator(mockProvider(10_000_000_000n), BASE_CONFIG);
    const result = await estimator.estimateRouteGas(3, 0.01);

    expect(result.gasUnits.toString()).toBe(BigInt(150_000 + 3 * 50_000).toString());
    expect(result.gasCostWei.toString()).toBe((result.gasUnits * 10_000_000_000n).toString());
    expect(result.gasCostPlsFormatted).toEqual(expect.any(String));
    expect(result.gasUsd).toBeGreaterThan(0);
  });

  it('falls back to alternative fee data fields when gasPrice is missing', async () => {
    const provider = mockProvider(undefined);
    const estimator = new PulsexGasEstimator(provider, BASE_CONFIG);
    const result = await estimator.estimateRouteGas(1, 0.02);

    expect(result.gasCostWei.toString()).toBe((result.gasUnits * 2_000_000_000n).toString());
    expect(result.gasCostPlsFormatted).toEqual(expect.any(String));
  });
});
