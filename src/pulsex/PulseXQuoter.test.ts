import type { Provider } from 'ethers';
import { PulseXQuoter, type RouteCandidate } from './PulseXQuoter';
import type { PulsexConfig } from '../config/pulsex';
import type { Address, ExactInQuoteRequest, PulsexToken, RouteLegSummary } from '../types/pulsex';

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      getPair: jest.fn(),
      token0: jest.fn(),
      token1: jest.fn(),
      getReserves: jest.fn(),
    })),
  };
});

jest.mock('./StableThreePoolQuoter', () => ({
  StableThreePoolQuoter: jest.fn().mockImplementation(() => ({
    quoteStableOut: jest.fn(),
  })),
}));

const mockGetPrice = jest.fn().mockResolvedValue(0.01);
jest.mock('./PulseXPriceOracle', () => ({
  PulseXPriceOracle: jest.fn().mockImplementation(() => ({
    getPlsPriceUsd: mockGetPrice,
  })),
}));

const mockEstimateGas = jest.fn().mockResolvedValue({
  gasUnits: 200_000n,
  gasCostWei: 1_000_000n,
  gasCostPlsFormatted: '0.000001',
  gasUsd: 0.5,
});
jest.mock('./gasEstimator', () => ({
  PulsexGasEstimator: jest.fn().mockImplementation(() => ({
    estimateRouteGas: mockEstimateGas,
  })),
}));

const toAddress = (suffix: string): Address =>
  (`0x${suffix.padStart(40, '0')}` as Address);

const TOKENS: Record<string, PulsexToken> = {
  wpls: { address: toAddress('1'), decimals: 18, symbol: 'WPLS', isNative: true },
  plsx: { address: toAddress('2'), decimals: 18, symbol: 'PLSX' },
  usdc: { address: toAddress('3'), decimals: 6, symbol: 'USDC' },
  usdt: { address: toAddress('4'), decimals: 6, symbol: 'USDT' },
  dai: { address: toAddress('5'), decimals: 18, symbol: 'DAI' },
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
  connectorTokens: [
    TOKENS.wpls,
    TOKENS.plsx,
    TOKENS.usdc,
    TOKENS.usdt,
    TOKENS.dai,
  ],
  stableTokens: [TOKENS.usdc, TOKENS.usdt, TOKENS.dai],
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
    enabled: true,
    weights: [5_000],
  },
  usdStableToken: TOKENS.usdc,
  gasConfig: {
    baseGasUnits: 150_000,
    gasPerLegUnits: 50_000,
  },
};

const defaultRequest = (
  overrides?: Partial<ExactInQuoteRequest>,
): ExactInQuoteRequest => ({
  chainId: BASE_CONFIG.chainId,
  tokenIn: TOKENS.usdc,
  tokenOut: TOKENS.usdt,
  amountIn: 10_000n,
  slippageBps: 50,
  recipient: toAddress('20'),
  ...overrides,
});

const candidateFromLeg = (id: string, leg: RouteLegSummary): RouteCandidate => ({
  id,
  path: [leg.tokenIn, leg.tokenOut],
  legs: [
    {
      protocol: leg.protocol,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
    },
  ],
});

describe('PulseXQuoter.quoteBestExactIn', () => {
  beforeEach(() => {
    mockEstimateGas.mockClear();
    mockGetPrice.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefers stable routes with equal outputs when quoting stable pairs', async () => {
    const config: PulsexConfig = {
      ...BASE_CONFIG,
      splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
    };
    const quoter = new PulseXQuoter({} as Provider, config);

    const stableLeg: RouteLegSummary = {
      protocol: 'PULSEX_STABLE',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.usdt,
      poolAddress: config.stablePoolAddress,
    };
    const v2Leg: RouteLegSummary = {
      protocol: 'PULSEX_V2',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.usdt,
      poolAddress: toAddress('30'),
    };

    const stableCandidate = candidateFromLeg('stable', stableLeg);
    const v2Candidate = candidateFromLeg('v2', v2Leg);

    jest
      .spyOn(quoter, 'generateRouteCandidates')
      .mockReturnValue([stableCandidate, v2Candidate]);

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockResolvedValue([
        { candidate: v2Candidate, amountOut: 1_000n, legs: [v2Leg] },
        { candidate: stableCandidate, amountOut: 1_000n, legs: [stableLeg] },
      ]);

    const result = await quoter.quoteBestExactIn(defaultRequest());

    expect(result.singleRoute).toEqual([stableLeg]);
    expect(result.splitRoutes).toBeUndefined();
    expect(result.totalAmountOut).toBe(1_000n);
    expect(result.gasEstimate).toBe(200_000n);
    expect(result.gasPLSWei).toBe(1_000_000n);
    expect(result.gasUsd).toBeCloseTo(0.5);
    expect(mockEstimateGas).toHaveBeenCalledWith(1, 0.01);
  });

  it('returns split metadata when weighted routes beat the best single path', async () => {
    const config: PulsexConfig = {
      ...BASE_CONFIG,
      splitConfig: { ...BASE_CONFIG.splitConfig, enabled: true, weights: [5_000] },
    };
    const quoter = new PulseXQuoter({} as Provider, config);

    const routeALeg: RouteLegSummary = {
      protocol: 'PULSEX_V2',
      tokenIn: TOKENS.wpls,
      tokenOut: TOKENS.plsx,
      poolAddress: toAddress('40'),
    };
    const routeBLeg: RouteLegSummary = {
      protocol: 'PULSEX_V1',
      tokenIn: TOKENS.wpls,
      tokenOut: TOKENS.plsx,
      poolAddress: toAddress('41'),
    };

    const routeACandidate = candidateFromLeg('route-a', routeALeg);
    const routeBCandidate = candidateFromLeg('route-b', routeBLeg);

    jest
      .spyOn(quoter, 'generateRouteCandidates')
      .mockReturnValue([routeACandidate, routeBCandidate]);

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockResolvedValue([
        { candidate: routeACandidate, amountOut: 10_000n, legs: [routeALeg] },
        { candidate: routeBCandidate, amountOut: 9_700n, legs: [routeBLeg] },
      ]);

    jest
      .spyOn(
        quoter as unknown as {
          simulateAmountWithCache: (
            candidate: RouteCandidate,
            amountIn: bigint,
            metrics?: unknown,
          ) => Promise<bigint>;
        },
        'simulateAmountWithCache',
      )
      .mockImplementation(async (candidate: RouteCandidate, amountIn: bigint) => {
        if (candidate.id === 'route-a') {
          return amountIn;
        }
        if (candidate.id === 'route-b') {
          if (amountIn === 5_000n) {
            return 5_200n;
          }
          if (amountIn === 10_000n) {
            return 9_700n;
          }
        }
        return amountIn;
      });

    const result = await quoter.quoteBestExactIn(
      defaultRequest({
        tokenIn: TOKENS.wpls,
        tokenOut: TOKENS.plsx,
        amountIn: 10_000n,
      }),
    );

    expect(result.singleRoute).toBeUndefined();
    expect(result.splitRoutes).toHaveLength(2);
    expect(result.totalAmountOut).toBe(10_200n);
    expect(result.splitRoutes?.[0].shareBps).toBe(5_000);
    expect(result.splitRoutes?.[0].amountOut).toBe(5_000n);
    expect(result.splitRoutes?.[1].amountOut).toBe(5_200n);
    expect(result.gasEstimate).toBe(200_000n);
    expect(result.gasPLSFormatted).toBe('0.000001');
    expect(mockEstimateGas).toHaveBeenCalledWith(2, 0.01);
  });

  it('normalizes native tokens to the configured wrapped address before routing', async () => {
    const config: PulsexConfig = {
      ...BASE_CONFIG,
      splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
    };
    const quoter = new PulseXQuoter({} as Provider, config);

    const v2Leg: RouteLegSummary = {
      protocol: 'PULSEX_V2',
      tokenIn: TOKENS.wpls,
      tokenOut: TOKENS.usdc,
      poolAddress: toAddress('50'),
    };
    const v2Candidate = candidateFromLeg('native', v2Leg);

    const generateSpy = jest
      .spyOn(quoter, 'generateRouteCandidates')
      .mockReturnValue([v2Candidate]);

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockResolvedValue([{ candidate: v2Candidate, amountOut: 500n, legs: [v2Leg] }]);

    const result = await quoter.quoteBestExactIn(
      defaultRequest({
        tokenIn: {
          ...TOKENS.wpls,
          address: '0x0000000000000000000000000000000000000000' as Address,
          isNative: true,
        },
        tokenOut: TOKENS.usdc,
        amountIn: 500n,
      }),
    );

    expect(generateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ address: TOKENS.wpls.address }),
      expect.objectContaining({ address: TOKENS.usdc.address }),
    );
    expect(result.request.tokenIn.address).toBe(TOKENS.wpls.address);
    expect(result.singleRoute).toEqual([v2Leg]);
    expect(result.gasPLSFormatted).toBe('0.000001');
    expect(result.gasEstimate).toBe(200_000n);
  });
});
