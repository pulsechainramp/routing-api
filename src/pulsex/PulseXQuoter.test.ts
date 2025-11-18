import { solidityPacked, type Provider } from 'ethers';
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

const mockQuoteStableOut = jest.fn();
const mockQuoteStableOutByIndices = jest.fn();
const mockGetTokenIndices = jest.fn().mockResolvedValue({
  tokenInIndex: 0,
  tokenOutIndex: 1,
});
const mockGetIndexMap = jest.fn().mockResolvedValue(new Map());
jest.mock('./StableThreePoolQuoter', () => ({
  StableThreePoolQuoter: jest.fn().mockImplementation(() => ({
    quoteStableOut: mockQuoteStableOut,
    quoteStableOutByIndices: mockQuoteStableOutByIndices,
    getTokenIndices: mockGetTokenIndices,
    getIndexMap: mockGetIndexMap,
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

const HUNDRED_K_USDC_IN = 100_000n * 1_000_000n;
const BASELINE_CPMM_AMOUNT = 4_000_000_000_000_000_000n;
const STABLE_CONNECTOR_AMOUNT = 4_500_000_000_000_000_000n;

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
  stableRouting: {
    enabled: true,
    useStableForStableToStable: true,
    useStableAsConnectorToPLS: true,
    maxStablePivots: 3,
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
    mockQuoteStableOut.mockClear();
    mockQuoteStableOutByIndices.mockClear();
    mockGetTokenIndices.mockClear();
    mockGetIndexMap.mockClear();
    mockGetIndexMap.mockResolvedValue(new Map());
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
      userData: "0x",
    };
    const v2Leg: RouteLegSummary = {
      protocol: 'PULSEX_V2',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.usdt,
      poolAddress: toAddress('30'),
      userData: "0x",
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
      userData: "0x",
    };
    const routeBLeg: RouteLegSummary = {
      protocol: 'PULSEX_V1',
      tokenIn: TOKENS.wpls,
      tokenOut: TOKENS.plsx,
      poolAddress: toAddress('41'),
      userData: "0x",
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
      userData: "0x",
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

  it('selects the stable connector route when it yields more output', async () => {
    const config: PulsexConfig = {
      ...BASE_CONFIG,
      splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
    };
    const quoter = new PulseXQuoter({} as Provider, config);

    const stableLeg: RouteLegSummary = {
      protocol: 'PULSEX_STABLE',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.usdt,
      poolAddress: toAddress('60'),
      userData: solidityPacked(['uint8', 'uint8'], [0, 1]),
    };
    const v2Leg: RouteLegSummary = {
      protocol: 'PULSEX_V2',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.plsx,
      poolAddress: toAddress('61'),
      userData: '0x',
    };

    const stableCandidate = candidateFromLeg('stable-route', stableLeg);
    const v2Candidate = candidateFromLeg('v2-route', v2Leg);

    jest
      .spyOn(quoter, 'generateRouteCandidates')
      .mockReturnValue([stableCandidate, v2Candidate]);

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockResolvedValue([
        { candidate: stableCandidate, amountOut: 11_000n, legs: [stableLeg] },
        { candidate: v2Candidate, amountOut: 10_000n, legs: [v2Leg] },
      ]);

    const result = await quoter.quoteBestExactIn(defaultRequest());

    expect(result.singleRoute).toEqual([stableLeg]);
    expect(result.totalAmountOut).toBe(11_000n);
  });

  it('sticks to CPMM candidates for 100k USDC -> PLS when stable routing is disabled', async () => {
    const quoter = new PulseXQuoter(
      {} as Provider,
      {
        ...BASE_CONFIG,
        stableRouting: { ...BASE_CONFIG.stableRouting, enabled: false },
        splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
      },
    );
    jest.spyOn(quoter as any, 'prewarmReserves').mockResolvedValue(undefined);
    let evaluated: RouteCandidate[] = [];

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockImplementation(
        async (candidates: RouteCandidate[]): Promise<
          { candidate: RouteCandidate; amountOut: bigint; legs: RouteLegSummary[] }[]
        > => {
          evaluated = candidates;
          return candidates.map((candidate, candidateIndex) => ({
            candidate,
            amountOut: BASELINE_CPMM_AMOUNT,
            legs: candidate.legs.map((leg, legIdx) => ({
              protocol: leg.protocol,
              tokenIn: leg.tokenIn,
              tokenOut: leg.tokenOut,
              poolAddress: leg.poolAddress ?? toAddress(`${70 + candidateIndex + legIdx}`),
              userData: leg.userData ?? '0x',
            })),
          }));
        },
      );

    const result = await quoter.quoteBestExactIn(
      defaultRequest({
        tokenOut: TOKENS.wpls,
        amountIn: HUNDRED_K_USDC_IN,
      }),
    );

    expect(result.totalAmountOut).toBe(BASELINE_CPMM_AMOUNT);
    expect(
      evaluated.every((candidate) =>
        candidate.legs.every((leg) => leg.protocol !== 'PULSEX_STABLE'),
      ),
    ).toBe(true);
    expect(
      result.singleRoute?.every((leg) => leg.protocol !== 'PULSEX_STABLE'),
    ).toBe(true);
  });

  it('builds and selects a stable candidate for 100k USDC -> PLS when enabled', async () => {
    mockGetIndexMap.mockResolvedValueOnce(
      new Map<Address, number>([
        [TOKENS.usdc.address, 0],
        [TOKENS.usdt.address, 1],
        [TOKENS.dai.address, 2],
      ]),
    );
    const quoter = new PulseXQuoter(
      {} as Provider,
      {
        ...BASE_CONFIG,
        splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
      },
    );
    jest.spyOn(quoter as any, 'prewarmReserves').mockResolvedValue(undefined);
    let sawStableCandidate = false;

    jest
      .spyOn(quoter as unknown as { evaluateRoutes: jest.Mock }, 'evaluateRoutes')
      .mockImplementation(
        async (candidates: RouteCandidate[]): Promise<
          { candidate: RouteCandidate; amountOut: bigint; legs: RouteLegSummary[] }[]
        > => {
          sawStableCandidate = candidates.some((candidate) =>
            candidate.legs.some((leg) => leg.protocol === 'PULSEX_STABLE'),
          );
          return candidates.map((candidate, candidateIndex) => {
            const hasStableLeg = candidate.legs.some(
              (leg) => leg.protocol === 'PULSEX_STABLE',
            );
            return {
              candidate,
              amountOut: hasStableLeg
                ? STABLE_CONNECTOR_AMOUNT
                : BASELINE_CPMM_AMOUNT,
              legs: candidate.legs.map((leg, legIdx) => ({
                protocol: leg.protocol,
                tokenIn: leg.tokenIn,
                tokenOut: leg.tokenOut,
                poolAddress: leg.poolAddress ?? toAddress(`${90 + candidateIndex + legIdx}`),
                userData: leg.userData ?? '0x',
              })),
            };
          });
        },
      );

    const result = await quoter.quoteBestExactIn(
      defaultRequest({
        tokenOut: TOKENS.wpls,
        amountIn: HUNDRED_K_USDC_IN,
      }),
    );

    expect(sawStableCandidate).toBe(true);
    expect(result.totalAmountOut).toBe(STABLE_CONNECTOR_AMOUNT);
    expect(
      result.singleRoute?.some((leg) => leg.protocol === 'PULSEX_STABLE'),
    ).toBe(true);
  });
});

describe('PulseXQuoter stable helpers', () => {
  const buildQuoter = () => new PulseXQuoter({} as Provider, BASE_CONFIG);

  const getInternals = (quoter: PulseXQuoter) =>
    quoter as unknown as Record<string, any>;

  it('identifies stable tokens via helper set and cached indices', () => {
    const quoter = buildQuoter();
    const internals = getInternals(quoter);
    internals.stableIndexMap = new Map([
      [TOKENS.usdc.address.toLowerCase(), 0],
      [TOKENS.dai.address.toLowerCase(), 2],
    ]);

    expect(internals.isStableToken(TOKENS.usdc.address)).toBe(true);
    expect(internals.isStableToken(TOKENS.plsx.address)).toBe(false);
    expect(internals.getStableIndex(TOKENS.usdc.address)).toBe(0);
    expect(internals.getStableIndex(TOKENS.usdt.address)).toBe(null);
  });

  it('builds stable legs with encoded userData when indices exist', () => {
    const quoter = buildQuoter();
    const internals = getInternals(quoter);
    internals.stableIndexMap = new Map([
      [TOKENS.usdc.address.toLowerCase(), 0],
      [TOKENS.dai.address.toLowerCase(), 2],
    ]);

    const leg = internals.buildStableLeg(TOKENS.usdc, TOKENS.dai);
    expect(leg).toEqual({
      protocol: 'PULSEX_STABLE',
      tokenIn: TOKENS.usdc,
      tokenOut: TOKENS.dai,
      poolAddress: BASE_CONFIG.stablePoolAddress,
      userData: solidityPacked(['uint8', 'uint8'], [0, 2]),
    });

    const missing = internals.buildStableLeg(TOKENS.usdt, TOKENS.dai);
    expect(missing).toBeNull();
  });
});

describe('PulseXQuoter stable routing candidates', () => {
  const buildQuoter = (overrides?: Partial<PulsexConfig>) =>
    new PulseXQuoter(
      {} as Provider,
      {
        ...BASE_CONFIG,
        ...overrides,
      },
    );

  it('adds a standalone stable candidate for stable pairs when enabled', () => {
    const quoter = buildQuoter();
    const internals = quoter as unknown as Record<string, any>;
    internals.stableIndexMap = new Map([
      [TOKENS.usdc.address.toLowerCase(), 0],
      [TOKENS.usdt.address.toLowerCase(), 1],
    ]);

    const nodePathsSpy = jest
      .spyOn(internals, 'generateNodePaths')
      .mockReturnValue([[TOKENS.usdc, TOKENS.usdt]]);
    const expandSpy = jest
      .spyOn(internals, 'expandPathsToRoutes')
      .mockReturnValue([]);

    const candidates = quoter.generateRouteCandidates(
      TOKENS.usdc,
      TOKENS.usdt,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].legs).toHaveLength(1);
    expect(candidates[0].legs[0].protocol).toBe('PULSEX_STABLE');
    expect(candidates[0].legs[0].userData).toBe(
      solidityPacked(['uint8', 'uint8'], [0, 1]),
    );

    nodePathsSpy.mockRestore();
    expandSpy.mockRestore();
  });

  it('builds connector routes using stable pivots for stable -> non-stable trades', () => {
    const quoter = buildQuoter({
      stableRouting: {
        ...BASE_CONFIG.stableRouting,
        maxStablePivots: 1,
      },
    });
    const internals = quoter as unknown as Record<string, any>;
    internals.stableIndexMap = new Map([
      [TOKENS.usdc.address.toLowerCase(), 0],
      [TOKENS.usdt.address.toLowerCase(), 1],
      [TOKENS.dai.address.toLowerCase(), 2],
    ]);

    const nodePathsSpy = jest
      .spyOn(internals, 'generateNodePaths')
      .mockImplementation((...args: unknown[]) => {
        const [tokenA, tokenB] = args as [PulsexToken, PulsexToken];
        if (
          tokenA.address === TOKENS.usdc.address &&
          tokenB.address === TOKENS.plsx.address
        ) {
          return [];
        }
        if (
          tokenA.address === TOKENS.usdt.address &&
          tokenB.address === TOKENS.plsx.address
        ) {
          return [[TOKENS.usdt, TOKENS.plsx]];
        }
        return [];
      });

    const expandSpy = jest
      .spyOn(internals, 'expandPathsToRoutes')
      .mockImplementation((...args: unknown[]) => {
        const [paths] = args as [PulsexToken[][]];
        if (
          paths.length === 1 &&
          paths[0][0].address === TOKENS.usdt.address &&
          paths[0][1].address === TOKENS.plsx.address
        ) {
          return [
            {
              id: 'pivot-route',
              path: paths[0],
              legs: [
                {
                  protocol: 'PULSEX_V2',
                  tokenIn: TOKENS.usdt,
                  tokenOut: TOKENS.plsx,
                },
              ],
            },
          ];
        }
        return [];
      });

    const candidates = quoter.generateRouteCandidates(
      TOKENS.usdc,
      TOKENS.plsx,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].legs).toHaveLength(2);
    expect(candidates[0].legs[0].protocol).toBe('PULSEX_STABLE');
    expect(candidates[0].legs[1].protocol).toBe('PULSEX_V2');
    expect(candidates[0].path.map((token) => token.address)).toEqual([
      TOKENS.usdc.address,
      TOKENS.usdt.address,
      TOKENS.plsx.address,
    ]);

    nodePathsSpy.mockRestore();
    expandSpy.mockRestore();
  });
});

describe('PulseXQuoter simulateRoute', () => {
  const buildQuoter = () =>
    new PulseXQuoter(
      {} as Provider,
      {
        ...BASE_CONFIG,
        splitConfig: { ...BASE_CONFIG.splitConfig, enabled: false },
      },
    );

  it('uses userData indices for stable legs without reloading indices', async () => {
    const quoter = buildQuoter();
    const userData = solidityPacked(['uint8', 'uint8'], [0, 1]);
    mockQuoteStableOutByIndices.mockResolvedValueOnce(1_000n);

    const candidate: RouteCandidate = {
      id: 'stable-route',
      path: [TOKENS.usdc, TOKENS.usdt],
      legs: [
        {
          protocol: 'PULSEX_STABLE',
          tokenIn: TOKENS.usdc,
          tokenOut: TOKENS.usdt,
          userData,
        },
      ],
    };

    const result = await quoter.simulateRoute(candidate, 100n);

    expect(result?.amountOut).toBe(1_000n);
    expect(result?.legs[0].userData).toBe(userData);
    expect(mockQuoteStableOutByIndices).toHaveBeenCalledWith(0, 1, 100n);
    expect(mockGetTokenIndices).not.toHaveBeenCalled();
  });
});


