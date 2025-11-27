import { Contract, Interface, ZeroAddress, solidityPacked, type Provider } from 'ethers';
import PulsexFactoryAbi from '../abis/PulsexFactory.json';
import { StableThreePoolQuoter } from './StableThreePoolQuoter';
import { PulseXPriceOracle } from './PulseXPriceOracle';
import { PulsexGasEstimator } from './gasEstimator';
import { getAmountOutCpmm } from './cpmmMath';
import { Logger } from '../utils/logger';
import { MulticallClient, type MulticallCall, type MulticallResult } from '../utils/multicall';
import type { PulsexConfig } from '../config/pulsex';
import type {
  ExactInQuoteRequest,
  PulsexProtocol,
  PulsexQuoteResult,
  PulsexToken,
  RouteLegSummary,
  SplitRouteMeta,
} from '../types/pulsex';
import type { Address } from '../types/pulsex';

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ROUTE_RANK_LIMIT = 3;
const ZERO_ADDRESS = ZeroAddress.toLowerCase();
const PULSEX_DEBUG_LOGGING_ENABLED =
  process.env.PULSEX_DEBUG_LOGGING === 'true';
const PULSEX_DEBUG_ROUTING_ENABLED =
  process.env.PULSEX_DEBUG_ROUTING === 'true';
const MAX_STABLE_CONNECTOR_ROUTE_OPTIONS = 4;
const PREFERRED_CONNECTOR_SYMBOLS = [
  'WPLS',
  'USDC',
  'DAI',
  'USDT',
  'PLSX',
  'WETH',
  'HEX',
  'INC',
];
const BPS_DENOMINATOR = 10_000n;

interface RouteLeg {
  protocol: PulsexProtocol;
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
  poolAddress?: Address;
  userData?: string;
}

export interface RouteCandidate {
  id: string;
  path: PulsexToken[];
  legs: RouteLeg[];
}

interface ReserveCacheEntry {
  expiresAt: number;
  value: PairReserves | null;
}

interface PairReserves {
  pairAddress: string;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
}

interface SimulatedRouteResult {
  candidate: RouteCandidate;
  amountOut: bigint;
  legs: RouteLegSummary[];
}

interface QuoteDebugMetrics {
  startTimeMs: number;
  routeCandidatesTotal?: number;
  routeCandidatesEvaluated?: number;
  uniqueCpmmPairs?: number;
  reserveCacheHits: number;
  reserveCacheMisses: number;
  multicallPairsLoaded: number;
  success?: boolean;
}

export class PulseXQuoter {
  private readonly logger = new Logger('PulseXQuoter');
  private readonly stableQuoter: StableThreePoolQuoter;
  private readonly priceOracle: PulseXPriceOracle;
  private readonly gasEstimator: PulsexGasEstimator;
  private readonly multicallClient?: MulticallClient;
  private readonly pairInterface = new Interface(PAIR_ABI);

  private readonly factoryContracts: Record<
    'PULSEX_V1' | 'PULSEX_V2',
    Contract
  >;

  private readonly stableTokenSet: Set<string>;
  private readonly wrappedNativeToken?: PulsexToken;
  private stableIndexMap?: Map<string, number>;
  private stableIndexInitPromise?: Promise<void>;

  private readonly reserveCache = new Map<string, ReserveCacheEntry>();
  private readonly splitAmountCache = new Map<string, Map<string, bigint>>();
  private readonly debugLoggingEnabled = PULSEX_DEBUG_LOGGING_ENABLED;
  private readonly stableRoutingDebugEnabled = PULSEX_DEBUG_ROUTING_ENABLED;
  private readonly preferredConnectorWeights: Map<string, number>;

  constructor(
    private readonly provider: Provider,
    private readonly config: PulsexConfig,
  ) {
    this.stableQuoter = new StableThreePoolQuoter(
      provider,
      config.stablePoolAddress,
    );
    this.priceOracle = new PulseXPriceOracle(provider, config);
    this.gasEstimator = new PulsexGasEstimator(provider, config);
    if (config.multicall?.enabled) {
      try {
        this.multicallClient = new MulticallClient(provider, {
          address: config.multicall.address,
          enabled: config.multicall.enabled,
          maxBatchSize: config.multicall.maxBatchSize,
          timeoutMs: config.multicall.timeoutMs,
        }, this.logger);
      } catch (error) {
        this.logger.debug('Failed to initialize multicall client', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.factoryContracts = {
      PULSEX_V1: new Contract(
        config.factories.v1,
        PulsexFactoryAbi,
        provider,
      ),
      PULSEX_V2: new Contract(
        config.factories.v2,
        PulsexFactoryAbi,
        provider,
      ),
    };

    this.stableTokenSet = new Set(
      config.stableTokens.map((token) => token.address.toLowerCase()),
    );

    this.preferredConnectorWeights = this.buildPreferredConnectorWeights();

    this.wrappedNativeToken = config.connectorTokens.find(
      (token) => token.isNative,
    );
  }

  public async getTokenPrice(address: string): Promise<number> {
    return this.priceOracle.getTokenPriceUsd(address);
  }

  public generateRouteCandidates(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): RouteCandidate[] {
    const nodePaths = this.generateNodePaths(tokenIn, tokenOut);
    const baseRoutes = this.expandPathsToRoutes(nodePaths);
    const stableRoutes = this.buildStableRouteCandidates(tokenIn, tokenOut);
    if (this.stableRoutingDebugEnabled && stableRoutes.length > 0) {
      this.logger.debug('PulseX stable routing candidates generated', {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        stableCandidateCount: stableRoutes.length,
      });
    }
    return this.dedupeRouteCandidates([...baseRoutes, ...stableRoutes]);
  }

  public async quoteBestExactIn(
    request: ExactInQuoteRequest,
    options?: { budgetMs?: number },
  ): Promise<PulsexQuoteResult> {
    this.splitAmountCache.clear();
    const startTimeMs = Date.now();
    const debugContext = this.createDebugContext(startTimeMs);
    const shouldLogMetrics = this.debugLoggingEnabled;
    const budgetMs =
      options?.budgetMs ?? this.config.quoteEvaluation.totalBudgetMs;
    let success = false;
    let candidates: RouteCandidate[] = [];
    const normalizedRequest = this.normalizeRequest(request);
    if (normalizedRequest.amountIn <= 0n) {
      throw new Error('amountIn must be greater than zero');
    }

    try {
      if (this.config.stableRouting.enabled) {
        await this.ensureStableIndicesLoaded();
      }

      const allCandidates = this.generateRouteCandidates(
        normalizedRequest.tokenIn,
        normalizedRequest.tokenOut,
      );
      const quoteHasStableCandidates = allCandidates.some((candidate) =>
        candidate.legs.some((leg) => leg.protocol === 'PULSEX_STABLE'),
      );
      const scoredCandidates = this.sortCandidatesByPreScore(allCandidates);
      const maxRoutes = this.config.quoteEvaluation.maxRoutes ?? 0;
      if (maxRoutes > 0 && scoredCandidates.length > maxRoutes) {
        let limited = scoredCandidates.slice(0, maxRoutes);
        const limitedIds = new Set(limited.map((candidate) => candidate.id));
        if (
          quoteHasStableCandidates &&
          !limited.some((candidate) => this.candidateHasStableLeg(candidate))
        ) {
          const replacement = scoredCandidates.find(
            (candidate) =>
              this.candidateHasStableLeg(candidate) &&
              !limitedIds.has(candidate.id),
          );
          if (replacement) {
            limited[limited.length - 1] = replacement;
          }
        }

        candidates = limited;
      } else {
        candidates = scoredCandidates;
      }

      if (debugContext) {
        debugContext.routeCandidatesTotal = allCandidates.length;
        debugContext.routeCandidatesEvaluated = candidates.length;
        debugContext.uniqueCpmmPairs =
          this.countUniqueCpmmPairs(allCandidates);
      }

      if (!candidates.length) {
        throw new Error('No candidate PulseX routes found');
      }

      await this.prewarmReserves(candidates, debugContext, budgetMs);

      const simulations = await this.evaluateRoutes(
        candidates,
        normalizedRequest.amountIn,
        debugContext,
        budgetMs,
      );

      if (!simulations.length) {
        const fallback = await this.tryDirectFallback(
          normalizedRequest,
          candidates,
          budgetMs,
          debugContext,
        );
        if (fallback) {
          success = true;
          return fallback;
        }
        throw new Error('No valid PulseX routes after simulation');
      }

      const preferStableRoutes = this.shouldPreferStableRoutes(
        normalizedRequest.tokenIn,
        normalizedRequest.tokenOut,
      );

      const rankedRoutes = this.rankSimulations(
        simulations,
        preferStableRoutes,
      );
      const topRanked = rankedRoutes.slice(0, ROUTE_RANK_LIMIT);
      const bestSingle = topRanked[0];
      if (!bestSingle) {
        throw new Error('Unable to rank PulseX routes');
      }
      if (
        this.stableRoutingDebugEnabled &&
        quoteHasStableCandidates &&
        bestSingle.legs.some((leg) => leg.protocol === 'PULSEX_STABLE')
      ) {
        this.logger.debug('PulseX stable route selected', {
          candidateId: bestSingle.candidate.id,
          amountOut: bestSingle.amountOut.toString(),
          stableLegs: this.countStableLegs(bestSingle.legs),
          tokenIn: normalizedRequest.tokenIn.address,
          tokenOut: normalizedRequest.tokenOut.address,
        });
      }

      let totalAmountOut = bestSingle.amountOut;
      let singleRoute: RouteLegSummary[] | undefined = bestSingle.legs;
      let splitRoutes: SplitRouteMeta[] | undefined;

      const splitConfig = this.config.splitConfig;
      let shouldConsiderSplits = splitConfig.enabled;
      if (shouldConsiderSplits && splitConfig.minUsdValue > 0) {
        try {
          const tokenPriceUsd = await this.priceOracle.getTokenPriceUsd(
            normalizedRequest.tokenIn.address,
          );
          const notionalMicros = this.computeUsdNotionalMicros(
            normalizedRequest.amountIn,
            normalizedRequest.tokenIn,
            tokenPriceUsd,
          );
          const thresholdMicros = this.scaleUsdToMicros(
            splitConfig.minUsdValue,
            'splitMinUsdValue',
          );
          shouldConsiderSplits =
            notionalMicros.valid &&
            thresholdMicros.valid &&
            notionalMicros.value >= thresholdMicros.value;
        } catch (error) {
          shouldConsiderSplits = false;
          if (this.debugLoggingEnabled) {
            this.logger.debug('Skipping split evaluation due to price lookup failure', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      if (shouldConsiderSplits) {
        const bestSplit = await this.findBestSplit(
          normalizedRequest.amountIn,
          topRanked,
          bestSingle,
          debugContext,
        );
        if (bestSplit && bestSplit.totalAmountOut > totalAmountOut) {
          totalAmountOut = bestSplit.totalAmountOut;
          splitRoutes = bestSplit.routes;
          singleRoute = undefined;
        }
      }

      const result = {
        request: normalizedRequest,
        totalAmountOut,
        routerAddress: this.config.routers.default,
        singleRoute,
        splitRoutes,
        ...(await this.buildGasEstimates(singleRoute, splitRoutes)),
      };
      success = true;
      return result;
    } finally {
      if (shouldLogMetrics) {
        debugContext.success = success;
        this.logQuoteMetrics(debugContext);
      }
    }
  }

  public async simulateRoute(
    route: RouteCandidate,
    amountIn: bigint,
    metrics?: QuoteDebugMetrics,
  ): Promise<{ amountOut: bigint; legs: RouteLegSummary[] } | null> {
    let cursorAmount = amountIn;
    const summaries: RouteLegSummary[] = [];

    for (const leg of route.legs) {
      if (leg.protocol === 'PULSEX_STABLE') {
        let indices = this.decodeStableLegUserData(leg.userData);
        if (!indices) {
          indices = await this.stableQuoter.getTokenIndices(
            leg.tokenIn.address,
            leg.tokenOut.address,
          );
        }
        const amountOut = await this.stableQuoter.quoteStableOutByIndices(
          indices.tokenInIndex,
          indices.tokenOutIndex,
          cursorAmount,
        );

        if (amountOut <= 0n) {
          return null;
        }

        cursorAmount = amountOut;
        summaries.push({
          protocol: leg.protocol,
          tokenIn: leg.tokenIn,
          tokenOut: leg.tokenOut,
          poolAddress: this.config.stablePoolAddress,
          userData:
            leg.userData ??
            solidityPacked(
              ['uint8', 'uint8'],
              [indices.tokenInIndex, indices.tokenOutIndex],
            ),
        });
        continue;
      }

      const reserves = await this.getPairReserves(
        leg.protocol,
        leg.tokenIn,
        leg.tokenOut,
        metrics,
      );

      if (!reserves) {
        return null;
      }

      const feeBps =
        leg.protocol === 'PULSEX_V1'
          ? this.config.fees.v1FeeBps
          : this.config.fees.v2FeeBps;

      const amountOut = getAmountOutCpmm(
        cursorAmount,
        reserves.reserveIn,
        reserves.reserveOut,
        feeBps,
      );

      if (amountOut <= 0n) {
        return null;
      }

      cursorAmount = amountOut;
      summaries.push({
        protocol: leg.protocol,
        tokenIn: leg.tokenIn,
        tokenOut: leg.tokenOut,
        poolAddress: reserves.pairAddress as Address,
        userData: '0x',
      });
    }

    return {
      amountOut: cursorAmount,
      legs: summaries,
    };
  }

  private generateNodePaths(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): PulsexToken[][] {
    const paths: PulsexToken[][] = [];
    const seen = new Set<string>();
    const connectors = this.config.connectorTokens.filter(
      (token) =>
        !this.isSameAddress(token.address, tokenIn.address) &&
        !this.isSameAddress(token.address, tokenOut.address),
    );

    const addPath = (tokens: PulsexToken[]) => {
      const key = tokens.map((token) => token.address.toLowerCase()).join('>');
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(tokens);
      }
    };

    const maxConnectors = Math.max(0, this.config.maxConnectorHops);
    const dfs = (currentPath: PulsexToken[], remainingConnectors: number) => {
      if (remainingConnectors === 0) {
        addPath([...currentPath, tokenOut]);
        return;
      }
      for (const connector of connectors) {
        if (
          this.pathContainsToken(currentPath, connector.address) ||
          this.isSameAddress(connector.address, tokenOut.address)
        ) {
          continue;
        }
        dfs([...currentPath, connector], remainingConnectors - 1);
      }
    };

    for (let connectorsToUse = 0; connectorsToUse <= maxConnectors; connectorsToUse += 1) {
      if (connectorsToUse === 0) {
        addPath([tokenIn, tokenOut]);
        continue;
      }
      dfs([tokenIn], connectorsToUse);
    }

    return paths;
  }

  private expandPathsToRoutes(paths: PulsexToken[][]): RouteCandidate[] {
    const routes: RouteCandidate[] = [];

    for (const path of paths) {
      const legOptions: RouteLeg[][] = [];

      for (let i = 0; i < path.length - 1; i += 1) {
        const tokenA = path[i];
        const tokenB = path[i + 1];

        const options: RouteLeg[] = [
          { protocol: 'PULSEX_V1', tokenIn: tokenA, tokenOut: tokenB },
          { protocol: 'PULSEX_V2', tokenIn: tokenA, tokenOut: tokenB },
        ];

        if (
          this.config.stableRouting.enabled &&
          this.stableTokenSet.has(tokenA.address.toLowerCase()) &&
          this.stableTokenSet.has(tokenB.address.toLowerCase())
        ) {
          options.push({
            protocol: 'PULSEX_STABLE',
            tokenIn: tokenA,
            tokenOut: tokenB,
          });
        }

        legOptions.push(options);
      }

      const legCombinations = this.cartesianLegs(legOptions);
      for (const legs of legCombinations) {
        routes.push({
          id: this.buildRouteId(legs),
          path: [...path],
          legs,
        });
      }
    }

    return routes;
  }

  private buildStableRouteCandidates(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): RouteCandidate[] {
    if (!this.config.stableRouting.enabled || !this.stableIndexMap?.size) {
      return [];
    }

    const candidates: RouteCandidate[] = [];
    const inStable = this.isStableToken(tokenIn.address);
    const outStable = this.isStableToken(tokenOut.address);

    if (inStable && outStable) {
      const stableLeg = this.buildStableLeg(tokenIn, tokenOut);
      if (stableLeg) {
        const legs = [stableLeg];
        candidates.push({
          id: this.buildRouteId(legs),
          path: [tokenIn, tokenOut],
          legs,
        });
      }
    }

    if (
      this.config.stableRouting.useStableAsConnectorToPLS &&
      inStable !== outStable
    ) {
      if (inStable) {
        candidates.push(
          ...this.buildStableConnectorCandidatesFromStableIn(
            tokenIn,
            tokenOut,
          ),
        );
      } else {
        candidates.push(
          ...this.buildStableConnectorCandidatesToStableOut(
            tokenIn,
            tokenOut,
          ),
        );
      }
    }

    return candidates;
  }

  private buildStableConnectorCandidatesFromStableIn(
    stableTokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): RouteCandidate[] {
    const pivots = this.getStablePivotTokens(stableTokenIn.address);
    const candidates: RouteCandidate[] = [];

    for (const pivot of pivots) {
      const stableLeg = this.buildStableLeg(stableTokenIn, pivot);
      if (!stableLeg) {
        continue;
      }
      const pivotPaths = this.generateNodePaths(pivot, tokenOut);
      const pivotRoutes = this.expandPathsToRoutes(pivotPaths).slice(
        0,
        MAX_STABLE_CONNECTOR_ROUTE_OPTIONS,
      );
      for (const route of pivotRoutes) {
        const legs = [stableLeg, ...route.legs];
        const path = [stableTokenIn, ...route.path];
        candidates.push({
          id: this.buildRouteId(legs),
          path,
          legs,
        });
      }
    }

    return candidates;
  }

  private buildStableConnectorCandidatesToStableOut(
    tokenIn: PulsexToken,
    stableTokenOut: PulsexToken,
  ): RouteCandidate[] {
    const pivots = this.getStablePivotTokens(stableTokenOut.address);
    const candidates: RouteCandidate[] = [];

    for (const pivot of pivots) {
      const stableLeg = this.buildStableLeg(pivot, stableTokenOut);
      if (!stableLeg) {
        continue;
      }
      const upstreamPaths = this.generateNodePaths(tokenIn, pivot);
      const upstreamRoutes = this.expandPathsToRoutes(upstreamPaths).slice(
        0,
        MAX_STABLE_CONNECTOR_ROUTE_OPTIONS,
      );
      for (const route of upstreamRoutes) {
        const legs = [...route.legs, stableLeg];
        const path = [...route.path, stableTokenOut];
        candidates.push({
          id: this.buildRouteId(legs),
          path,
          legs,
        });
      }
    }

    return candidates;
  }

  private getStablePivotTokens(excludeAddress: Address): PulsexToken[] {
    const excludeLower = excludeAddress.toLowerCase();
    const limit = Math.max(0, this.config.stableRouting.maxStablePivots);
    return this.config.stableTokens
      .filter((token) => token.address.toLowerCase() !== excludeLower)
      .slice(0, limit);
  }

  private cartesianLegs(options: RouteLeg[][]): RouteLeg[][] {
    if (options.length === 0) {
      return [];
    }
    return options.reduce<RouteLeg[][]>(
      (acc, current) => {
        const combined: RouteLeg[][] = [];
        for (const prefix of acc) {
          for (const leg of current) {
            combined.push([...prefix, leg]);
          }
        }
        return combined;
      },
      [[]],
    );
  }

  private dedupeRouteCandidates(
    candidates: RouteCandidate[],
  ): RouteCandidate[] {
    if (!candidates.length) {
      return [];
    }
    const unique = new Map<string, RouteCandidate>();
    for (const candidate of candidates) {
      if (!unique.has(candidate.id)) {
        unique.set(candidate.id, candidate);
      }
    }
    return Array.from(unique.values());
  }

  private async buildGasEstimates(
    singleRoute?: RouteLegSummary[],
    splitRoutes?: SplitRouteMeta[],
  ): Promise<{
    gasEstimate?: bigint;
    gasPLSWei?: bigint;
    gasPLSFormatted?: string;
    gasUsd?: number;
  }> {
    const legCount = this.calculateLegCount(singleRoute, splitRoutes);
    if (legCount <= 0) {
      return {};
    }

    try {
      const priceUsd = await this.priceOracle.getPlsPriceUsd();
      const estimate = await this.gasEstimator.estimateRouteGas(
        legCount,
        priceUsd,
      );
      return {
        gasEstimate: estimate.gasUnits,
        gasPLSWei: estimate.gasCostWei,
        gasPLSFormatted: estimate.gasCostPlsFormatted,
        gasUsd: estimate.gasUsd,
      };
    } catch (error) {
      return {};
    }
  }

  private calculateLegCount(
    singleRoute?: RouteLegSummary[],
    splitRoutes?: SplitRouteMeta[],
  ): number {
    if (splitRoutes && splitRoutes.length > 0) {
      return splitRoutes.reduce((sum, route) => sum + route.legs.length, 0);
    }
    return singleRoute?.length ?? 0;
  }

  private async getPairReserves(
    protocol: PulsexProtocol,
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
    metrics?: QuoteDebugMetrics,
  ): Promise<PairReserves | null> {
    if (protocol === 'PULSEX_STABLE') {
      return null;
    }

    const cacheKey = this.buildReserveCacheKey(protocol, tokenIn, tokenOut);
    const existing = this.reserveCache.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) {
      if (metrics) {
        metrics.reserveCacheHits += 1;
      }
      return this.mapCachedReserves(existing.value, tokenIn, tokenOut);
    }

    if (metrics) {
      metrics.reserveCacheMisses += 1;
    }

    const multicallLoaded = await this.loadReservesForLegsWithMulticall(
      [
        { protocol, tokenIn, tokenOut, cacheKey },
      ],
      metrics,
    );
    if (multicallLoaded && multicallLoaded.has(cacheKey)) {
      const refreshed = this.reserveCache.get(cacheKey);
      return this.mapCachedReserves(refreshed?.value ?? null, tokenIn, tokenOut);
    }
    if (!multicallLoaded && this.debugLoggingEnabled) {
      this.logger.debug('Multicall failed for PulseX reserves; falling back to direct RPC', {
        protocol,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
      });
    }

    const entry = await this.loadPairReservesFromChain(
      protocol,
      tokenIn,
      tokenOut,
      cacheKey,
    );
    if (!entry) {
      return null;
    }

    return this.mapCachedReserves(entry, tokenIn, tokenOut);
  }

  private buildReserveCacheKey(
    protocol: PulsexProtocol,
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): string {
    const tokens = [
      tokenIn.address.toLowerCase(),
      tokenOut.address.toLowerCase(),
    ].sort();
    return `${protocol}:${tokens[0]}>${tokens[1]}`;
  }

  private async loadPairReservesFromChain(
    protocol: PulsexProtocol,
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
    cacheKey?: string,
  ): Promise<PairReserves | null> {
    if (protocol === 'PULSEX_STABLE') {
      return null;
    }

    const key =
      cacheKey ?? this.buildReserveCacheKey(protocol, tokenIn, tokenOut);
    const factory = this.factoryContracts[protocol];
    if (!factory) {
      return null;
    }

    const { value: pairAddress, timedOut: pairTimedOut } = await this.withTimeout(
      factory.getPair(tokenIn.address, tokenOut.address),
      this.config.quoteEvaluation.timeoutMs,
      {
        context: {
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          protocol,
          call: 'getPair',
        },
      },
    );

    if (pairTimedOut || !pairAddress || this.isZeroAddress(pairAddress)) {
      if (pairTimedOut) {
        this.logger.warn('Timed out fetching PulseX pair address', {
          protocol,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
        });
      }
      this.storeReserveCacheEntry(key, null);
      return null;
    }

    const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
    const timeoutMs = this.config.quoteEvaluation.timeoutMs;

    const [token0Result, token1Result, reservesResult] = await Promise.all([
      this.withTimeout(pairContract.token0() as Promise<string>, timeoutMs, {
        context: { pairAddress, protocol, call: 'token0' },
      }),
      this.withTimeout(pairContract.token1() as Promise<string>, timeoutMs, {
        context: { pairAddress, protocol, call: 'token1' },
      }),
      this.withTimeout(
        pairContract.getReserves() as Promise<
          readonly [reserve0: bigint, reserve1: bigint, blockTimestampLast: number]
        >,
        timeoutMs,
        {
          context: { pairAddress, protocol, call: 'getReserves' },
        },
      ),
    ]);

    if (token0Result.timedOut || !token0Result.value) {
      this.logger.warn('Failed to load token0 for PulseX pair', {
        protocol,
        pairAddress,
      });
      this.storeReserveCacheEntry(key, null);
      return null;
    }

    if (token1Result.timedOut || !token1Result.value) {
      this.logger.warn('Failed to load token1 for PulseX pair', {
        protocol,
        pairAddress,
      });
      this.storeReserveCacheEntry(key, null);
      return null;
    }

    if (reservesResult.timedOut || !reservesResult.value) {
      this.logger.warn('Failed to load reserves for PulseX pair', {
        protocol,
        pairAddress,
      });
      this.storeReserveCacheEntry(key, null);
      return null;
    }

    const [reserve0, reserve1] = reservesResult.value;

    const entry: PairReserves = {
      pairAddress,
      token0: token0Result.value as Address,
      token1: token1Result.value as Address,
      reserve0: BigInt(reserve0),
      reserve1: BigInt(reserve1),
      reserveIn: 0n,
      reserveOut: 0n,
    };

    this.storeReserveCacheEntry(key, entry);
    return entry;
  }

  private storeReserveCacheEntry(
    cacheKey: string,
    value: PairReserves | null,
  ): void {
    this.reserveCache.set(cacheKey, {
      expiresAt: Date.now() + this.config.cacheTtlMs.reserves,
      value,
    });
  }

  private isStableToken(address: string): boolean {
    return this.stableTokenSet.has(address.toLowerCase());
  }

  private getStableIndex(address: Address): number | null {
    if (!this.stableIndexMap) {
      return null;
    }
    const index = this.stableIndexMap.get(address.toLowerCase());
    return typeof index === 'number' ? index : null;
  }

  private buildStableLeg(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): RouteLeg | null {
    const tokenInIndex = this.getStableIndex(tokenIn.address as Address);
    const tokenOutIndex = this.getStableIndex(tokenOut.address as Address);
    if (tokenInIndex === null || tokenOutIndex === null) {
      return null;
    }

    return {
      protocol: 'PULSEX_STABLE',
      tokenIn,
      tokenOut,
      poolAddress: this.config.stablePoolAddress,
      userData: solidityPacked(
        ['uint8', 'uint8'],
        [tokenInIndex, tokenOutIndex],
      ),
    };
  }

  private mapCachedReserves(
    cached: PairReserves | null,
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): PairReserves | null {
    if (!cached) {
      return null;
    }

    const normalizedIn = tokenIn.address.toLowerCase();
    const normalizedOut = tokenOut.address.toLowerCase();
    const token0Lower = cached.token0.toLowerCase();
    const token1Lower = cached.token1.toLowerCase();

    if (
      (normalizedIn !== token0Lower && normalizedIn !== token1Lower) ||
      (normalizedOut !== token0Lower && normalizedOut !== token1Lower)
    ) {
      return null;
    }

    const reserveIn =
      normalizedIn === token0Lower ? cached.reserve0 : cached.reserve1;
    const reserveOut =
      normalizedOut === token0Lower ? cached.reserve0 : cached.reserve1;

    return {
      ...cached,
      reserveIn,
      reserveOut,
    };
  }

  private buildPreferredConnectorWeights(): Map<string, number> {
    const weights = new Map<string, number>();
    const baseWeight = PREFERRED_CONNECTOR_SYMBOLS.length;
    PREFERRED_CONNECTOR_SYMBOLS.forEach((symbol, index) => {
      const weight = baseWeight - index;
      this.config.connectorTokens.forEach((token) => {
        if (
          token.symbol &&
          token.symbol.toLowerCase() === symbol.toLowerCase()
        ) {
          weights.set(token.address.toLowerCase(), weight);
        }
      });
    });
    return weights;
  }

  private connectorWeight(token: PulsexToken): number {
    return this.preferredConnectorWeights.get(token.address.toLowerCase()) ?? 0;
  }

  private buildRouteId(legs: RouteLeg[]): string {
    return legs
      .map(
        (leg) =>
          `${leg.protocol}:${leg.tokenIn.address.toLowerCase()}-${leg.tokenOut.address.toLowerCase()}`,
      )
      .join('|');
  }

  private isSameAddress(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  private pathContainsToken(path: PulsexToken[], address: string): boolean {
    const normalized = address.toLowerCase();
    return path.some((token) => token.address.toLowerCase() === normalized);
  }

  private normalizeRequest(req: ExactInQuoteRequest): ExactInQuoteRequest {
    return {
      ...req,
      tokenIn: this.normalizeToken(req.tokenIn),
      tokenOut: this.normalizeToken(req.tokenOut),
    };
  }

  private normalizeToken(token: PulsexToken): PulsexToken {
    if (this.shouldWrapNativeToken(token)) {
      if (!this.wrappedNativeToken) {
        throw new Error('Wrapped native token metadata missing from config');
      }

      return {
        ...token,
        address: this.wrappedNativeToken.address,
        decimals: token.decimals ?? this.wrappedNativeToken.decimals,
        symbol: token.symbol ?? this.wrappedNativeToken.symbol,
        name: token.name ?? this.wrappedNativeToken.name,
        isNative: false,
      };
    }

    return {
      ...token,
      address: token.address as Address,
    };
  }

  private async ensureStableIndicesLoaded(): Promise<void> {
    if (this.stableIndexMap && this.stableIndexMap.size > 0) {
      return;
    }

    if (!this.stableIndexInitPromise) {
      this.stableIndexInitPromise = this.stableQuoter
        .getIndexMap()
        .then((map) => {
          this.stableIndexMap = new Map(
            Array.from(map.entries(), ([address, index]) => [
              address.toLowerCase(),
              index,
            ]),
          );
        })
        .catch((error) => {
          this.logger.warn('Unable to load PulseX stable pool indices', {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.stableIndexInitPromise = undefined;
        });
    }

    await this.stableIndexInitPromise;
  }

  private decodeStableLegUserData(
    userData?: string,
  ): { tokenInIndex: number; tokenOutIndex: number } | null {
    if (!userData || userData === '0x') {
      return null;
    }
    const trimmed = userData.startsWith('0x') ? userData.slice(2) : userData;
    if (trimmed.length < 4) {
      return null;
    }
    const tokenInIndex = Number.parseInt(trimmed.slice(0, 2), 16);
    const tokenOutIndex = Number.parseInt(trimmed.slice(2, 4), 16);
    if (Number.isNaN(tokenInIndex) || Number.isNaN(tokenOutIndex)) {
      return null;
    }
    return {
      tokenInIndex,
      tokenOutIndex,
    };
  }

  private shouldWrapNativeToken(token: PulsexToken): boolean {
    const normalizedAddress = token.address.toLowerCase();
    if (normalizedAddress === ZERO_ADDRESS || normalizedAddress === '0x0') {
      return true;
    }

    if (token.isNative && this.wrappedNativeToken) {
      return !this.isSameAddress(token.address, this.wrappedNativeToken.address);
    }

    return false;
  }

  private isZeroAddress(value: string | undefined): boolean {
    if (!value) {
      return true;
    }
    const normalized = value.toLowerCase();
    return normalized === '0x0' || normalized === ZERO_ADDRESS;
  }

  private async evaluateRoutes(
    candidates: RouteCandidate[],
    amountIn: bigint,
    metrics?: QuoteDebugMetrics,
    budgetMs?: number,
  ): Promise<SimulatedRouteResult[]> {
    const results: SimulatedRouteResult[] = [];
    const concurrency = Math.max(
      1,
      this.config.quoteEvaluation.concurrency ?? 1,
    );
    const baseTimeoutMs = this.config.quoteEvaluation.timeoutMs ?? 4_000;
    const startTime = metrics?.startTimeMs ?? Date.now();
    const remainingBudget = () =>
      budgetMs !== undefined ? budgetMs - (Date.now() - startTime) : undefined;

    for (let i = 0; i < candidates.length; i += concurrency) {
      const remaining = remainingBudget();
      if (remaining !== undefined && remaining <= 0) {
        break;
      }
      const perRouteTimeout =
        remaining !== undefined
          ? Math.min(baseTimeoutMs, Math.max(200, Math.floor(remaining / 2)))
          : baseTimeoutMs;
      const batch = candidates.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          const { value: simulation } = await this.withTimeout(
            this.simulateRoute(candidate, amountIn, metrics),
            perRouteTimeout,
            { logOnError: false },
          );

          if (!simulation || simulation.amountOut <= 0n) {
            return null;
          }

          return {
            candidate,
            amountOut: simulation.amountOut,
            legs: simulation.legs,
          };
        }),
      );

      for (const sim of batchResults) {
        if (sim) {
          results.push(sim);
        }
      }
    }

    return results;
  }

  private async tryDirectFallback(
    request: ExactInQuoteRequest,
    candidates: RouteCandidate[],
    budgetMs?: number,
    metrics?: QuoteDebugMetrics,
  ): Promise<PulsexQuoteResult | null> {
    const startTime = metrics?.startTimeMs ?? Date.now();
    const remainingBudget = () =>
      budgetMs !== undefined ? budgetMs - (Date.now() - startTime) : undefined;
    const coreConnectorAddresses = new Set(
      this.config.connectorTokens
        .filter(
          (token) =>
            token.symbol &&
            ['WPLS', 'USDC', 'PLSX'].includes(token.symbol.toUpperCase()),
        )
        .map((token) => token.address.toLowerCase()),
    );

    const filtered = candidates.filter((candidate) => {
      if (candidate.legs.some((leg) => leg.protocol === 'PULSEX_STABLE')) {
        return false;
      }
      if (candidate.path.length === 2) {
        return true;
      }
      if (candidate.path.length === 3) {
        const connector = candidate.path[1];
        return coreConnectorAddresses.has(connector.address.toLowerCase());
      }
      return false;
    });

    const perLegTimeout = () => {
      const remaining = remainingBudget();
      if (remaining === undefined) {
        return 800;
      }
      return Math.max(200, Math.min(800, remaining));
    };

    for (const candidate of filtered) {
      const remaining = remainingBudget();
      if (remaining !== undefined && remaining <= 0) {
        break;
      }

      let cursorAmount = request.amountIn;
      const legs: RouteLegSummary[] = [];
      let failed = false;

      for (const leg of candidate.legs) {
        const { value: reserves } = await this.withTimeout(
          this.getPairReserves(leg.protocol, leg.tokenIn, leg.tokenOut, metrics),
          perLegTimeout(),
          { logOnError: false },
        );
        if (!reserves || reserves.reserveIn <= 0n || reserves.reserveOut <= 0n) {
          failed = true;
          break;
        }

        const feeBps =
          leg.protocol === 'PULSEX_V1'
            ? this.config.fees.v1FeeBps
            : this.config.fees.v2FeeBps;
        const amountOut = getAmountOutCpmm(
          cursorAmount,
          reserves.reserveIn,
          reserves.reserveOut,
          feeBps,
        );
        if (amountOut <= 0n) {
          failed = true;
          break;
        }

        cursorAmount = amountOut;
        legs.push({
          protocol: leg.protocol,
          tokenIn: leg.tokenIn,
          tokenOut: leg.tokenOut,
          poolAddress: reserves.pairAddress as Address,
          userData: '0x',
        });
      }

      if (failed || cursorAmount <= 0n || !legs.length) {
        continue;
      }

      return {
        request,
        totalAmountOut: cursorAmount,
        routerAddress: this.config.routers.default,
        singleRoute: legs,
        ...(await this.buildGasEstimates(legs, undefined)),
      };
    }

    return null;
  }

  private shouldPreferStableRoutes(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): boolean {
    return (
      this.isStableToken(tokenIn.address) &&
      this.isStableToken(tokenOut.address)
    );
  }

  private rankSimulations(
    simulations: SimulatedRouteResult[],
    preferStableRoutes: boolean,
  ): SimulatedRouteResult[] {
    return simulations
      .slice()
      .sort((a, b) => {
        if (a.amountOut !== b.amountOut) {
          return a.amountOut > b.amountOut ? -1 : 1;
        }
        if (a.legs.length !== b.legs.length) {
          return a.legs.length - b.legs.length;
        }
        if (preferStableRoutes) {
          const stableDiff =
            this.countStableLegs(b.legs) - this.countStableLegs(a.legs);
          if (stableDiff !== 0) {
            return stableDiff;
          }
        }
        return a.candidate.id.localeCompare(b.candidate.id);
      });
  }

  private countStableLegs(legs: RouteLegSummary[]): number {
    return legs.filter((leg) => leg.protocol === 'PULSEX_STABLE').length;
  }

  private scaleUsdToMicros(value: number, label: string): { value: bigint; valid: boolean } {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
      if (this.debugLoggingEnabled) {
        this.logger.debug('Invalid USD value for split evaluation', { label, value });
      }
      return { value: 0n, valid: false };
    }
    const scaled = BigInt(Math.round(value * 1_000_000));
    return { value: scaled > 0n ? scaled : 0n, valid: scaled > 0n };
  }

  private computeUsdNotionalMicros(
    amountIn: bigint,
    token: PulsexToken,
    priceUsd: number,
  ): { value: bigint; valid: boolean } {
    const priceScaled = this.scaleUsdToMicros(priceUsd, 'priceUsd');
    if (!priceScaled.valid) {
      return { value: 0n, valid: false };
    }
    const decimals = Math.max(0, Math.min(18, token.decimals ?? 18));
    const unit = 10n ** BigInt(decimals);
    const notionalMicros = (amountIn * priceScaled.value) / unit;
    return { value: notionalMicros > 0n ? notionalMicros : 0n, valid: true };
  }

  private preScoreRoute(candidate: RouteCandidate): number {
    let score = 1_000;
    const hopPenalty = (candidate.path.length - 2) * 50;
    score -= hopPenalty;

    for (const leg of candidate.legs) {
      if (leg.protocol === 'PULSEX_V1') {
        score -= 25;
      }
      if (leg.protocol === 'PULSEX_STABLE') {
        score += 10;
      }
    }

    const connectorBonus = candidate.path
      .slice(1, -1)
      .reduce((total, token) => total + this.connectorWeight(token), 0);
    score += connectorBonus;

    score += this.cachedLiquidityBonus(candidate);

    return score;
  }

  private cachedLiquidityBonus(candidate: RouteCandidate): number {
    let bonus = 0;
    for (const leg of candidate.legs) {
      if (leg.protocol === 'PULSEX_STABLE') {
        continue;
      }
      const cacheKey = this.buildReserveCacheKey(
        leg.protocol,
        leg.tokenIn,
        leg.tokenOut,
      );
      const cached = this.reserveCache.get(cacheKey);
      if (cached && cached.value && cached.expiresAt > Date.now()) {
        bonus += 5;
      }
    }
    return bonus;
  }

  private sortCandidatesByPreScore(candidates: RouteCandidate[]): RouteCandidate[] {
    return candidates
      .map((candidate) => ({
        candidate,
        score: this.preScoreRoute(candidate),
      }))
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.candidate.id.localeCompare(b.candidate.id);
      })
      .map((entry) => entry.candidate);
  }

  private candidateHasStableLeg(candidate: RouteCandidate): boolean {
    return candidate.legs.some((leg) => leg.protocol === 'PULSEX_STABLE');
  }

  private async findBestSplit(
    totalAmountIn: bigint,
    simulations: SimulatedRouteResult[],
    bestSingle: SimulatedRouteResult,
    metrics?: QuoteDebugMetrics,
  ): Promise<{ totalAmountOut: bigint; routes: SplitRouteMeta[] } | undefined> {
    if (simulations.length < 2 || !bestSingle || bestSingle.amountOut <= 0n) {
      return undefined;
    }

    const weights = this.config.splitConfig.weights ?? [];
    const maxRoutes = Math.max(2, this.config.splitConfig.maxRoutes ?? 2);
    const routesToConsider = simulations.slice(0, maxRoutes);
    let bestTotal = 0n;
    let bestRoutes: SplitRouteMeta[] | undefined;

    for (let i = 0; i < routesToConsider.length; i += 1) {
      for (let j = i + 1; j < routesToConsider.length; j += 1) {
        const first = routesToConsider[i];
        const second = routesToConsider[j];
        for (const weight of weights) {
          if (weight <= 0 || weight >= 10_000) {
            continue;
          }

          const amountInFirst = (totalAmountIn * BigInt(weight)) / BPS_DENOMINATOR;
          const amountInSecond = totalAmountIn - amountInFirst;
          if (amountInFirst <= 0n || amountInSecond <= 0n) {
            continue;
          }

          const amountOutFirst = await this.simulateAmountWithCache(
            first.candidate,
            amountInFirst,
            metrics,
          );
          const amountOutSecond = await this.simulateAmountWithCache(
            second.candidate,
            amountInSecond,
            metrics,
          );

          if (amountOutFirst <= 0n || amountOutSecond <= 0n) {
            continue;
          }

          const total = amountOutFirst + amountOutSecond;
          if (total > bestTotal) {
            bestTotal = total;
            bestRoutes = [
              {
                shareBps: weight,
                amountIn: amountInFirst,
                amountOut: amountOutFirst,
                legs: first.legs,
              },
              {
                shareBps: 10_000 - weight,
                amountIn: amountInSecond,
                amountOut: amountOutSecond,
                legs: second.legs,
              },
            ];
          }
        }
      }
    }

    if (!bestRoutes) {
      return undefined;
    }

    const minImprovementBps =
      BigInt(Math.max(0, this.config.splitConfig.minImprovementBps ?? 0));
    if (bestTotal <= bestSingle.amountOut) {
      return undefined;
    }

    const improvementBps =
      ((bestTotal - bestSingle.amountOut) * BPS_DENOMINATOR) / bestSingle.amountOut;
    if (improvementBps < minImprovementBps) {
      return undefined;
    }

    return {
      totalAmountOut: bestTotal,
      routes: bestRoutes,
    };
  }

  private async simulateAmountWithCache(
    candidate: RouteCandidate,
    amountIn: bigint,
    metrics?: QuoteDebugMetrics,
  ): Promise<bigint> {
    const routeCache =
      this.splitAmountCache.get(candidate.id) ??
      this.splitAmountCache
        .set(candidate.id, new Map<string, bigint>())
        .get(candidate.id)!;
    const cacheKey = amountIn.toString();
    if (routeCache.has(cacheKey)) {
      return routeCache.get(cacheKey)!;
    }

    const simulation = await this.simulateRoute(
      candidate,
      amountIn,
      metrics,
    );
    const amountOut = simulation?.amountOut ?? 0n;
    routeCache.set(cacheKey, amountOut);
    return amountOut;
  }

  private collectUniqueCpmmLegs(
    candidates: RouteCandidate[],
  ): Array<{ protocol: PulsexProtocol; tokenIn: PulsexToken; tokenOut: PulsexToken }> {
    const unique = new Map<string, { protocol: PulsexProtocol; tokenIn: PulsexToken; tokenOut: PulsexToken }>();
    for (const candidate of candidates) {
      for (const leg of candidate.legs) {
        if (leg.protocol === 'PULSEX_STABLE') {
          continue;
        }
        const key = this.buildReserveCacheKey(
          leg.protocol,
          leg.tokenIn,
          leg.tokenOut,
        );
        if (!unique.has(key)) {
          unique.set(key, {
            protocol: leg.protocol,
            tokenIn: leg.tokenIn,
            tokenOut: leg.tokenOut,
          });
        }
      }
    }
    return Array.from(unique.values());
  }

  private async prewarmReserves(
    candidates: RouteCandidate[],
    metrics?: QuoteDebugMetrics,
    budgetMs?: number,
  ): Promise<void> {
    if (!candidates.length) {
      return;
    }
    const startTime = metrics?.startTimeMs ?? Date.now();
    const getRemaining = () =>
      budgetMs !== undefined ? budgetMs - (Date.now() - startTime) : Infinity;
    const uniqueLegs = this.collectUniqueCpmmLegs(candidates);
    if (!uniqueLegs.length) {
      return;
    }

    let legsToLoad = uniqueLegs.filter((leg) => {
      const cacheKey = this.buildReserveCacheKey(
        leg.protocol,
        leg.tokenIn,
        leg.tokenOut,
      );
      const existing = this.reserveCache.get(cacheKey);
      return !existing || existing.expiresAt <= Date.now();
    });

    if (!legsToLoad.length) {
      return;
    }

    if (getRemaining() <= 500) {
      if (this.debugLoggingEnabled) {
        this.logger.debug('Stopping PulseX reserve prewarm; budget almost exhausted', {
          budgetMs,
        });
      }
      return;
    }

    const multicallLoaded = await this.loadReservesForLegsWithMulticall(
      legsToLoad,
      metrics,
    );
    if (multicallLoaded) {
      const remaining = legsToLoad.filter((leg) => {
        const cacheKey = this.buildReserveCacheKey(
          leg.protocol,
          leg.tokenIn,
          leg.tokenOut,
        );
        return !multicallLoaded.has(cacheKey);
      });
      if (!remaining.length) {
        return;
      }
      legsToLoad = remaining;
      if (this.debugLoggingEnabled && legsToLoad.length > 0) {
        this.logger.debug('PulseX multicall left reserves unresolved; falling back to RPC', {
          remainingLegs: legsToLoad.length,
        });
      }
    } else if (this.debugLoggingEnabled) {
      this.logger.debug('Multicall prewarm failed; falling back to direct RPC for remaining legs', {
        legCount: legsToLoad.length,
      });
    }

    if (!legsToLoad.length) {
      return;
    }

    if (getRemaining() <= 1_000) {
      if (this.debugLoggingEnabled) {
        this.logger.debug('Skipping RPC reserve prewarm; insufficient remaining budget', {
          budgetMs,
          remainingMs: getRemaining(),
        });
      }
      return;
    }

    const concurrency = Math.max(
      1,
      this.config.quoteEvaluation.concurrency ?? 1,
    );

    for (let i = 0; i < legsToLoad.length; i += concurrency) {
      if (getRemaining() <= 200) {
        break;
      }
      const batch = legsToLoad.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (leg) => {
          if (getRemaining() <= 200) {
            return;
          }
          try {
            await this.loadPairReservesFromChain(
              leg.protocol,
              leg.tokenIn,
              leg.tokenOut,
            );
          } catch (error) {
            this.logger.debug('Failed to prewarm PulseX pair reserves', {
              protocol: leg.protocol,
              tokenIn: leg.tokenIn.address,
              tokenOut: leg.tokenOut.address,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    }
  }

  private createDebugContext(startTimeMs: number): QuoteDebugMetrics {
    return {
      startTimeMs,
      reserveCacheHits: 0,
      reserveCacheMisses: 0,
      multicallPairsLoaded: 0,
    };
  }

  private async loadReservesForLegsWithMulticall(
    legs: Array<{
      protocol: PulsexProtocol;
      tokenIn: PulsexToken;
      tokenOut: PulsexToken;
      cacheKey?: string;
    }>,
    metrics?: QuoteDebugMetrics,
  ): Promise<Set<string> | null> {
    if (!this.multicallClient || !this.multicallClient.isEnabled()) {
      return null;
    }

    type LegContext = {
      protocol: PulsexProtocol;
      tokenIn: PulsexToken;
      tokenOut: PulsexToken;
      cacheKey: string;
      factory: Contract;
    };

    const legContexts: LegContext[] = [];
    const loadedKeys = new Set<string>();
    const seenLegKeys = new Set<string>();

    for (const leg of legs) {
      if (leg.protocol === 'PULSEX_STABLE') {
        continue;
      }
      const cacheKey =
        leg.cacheKey ??
        this.buildReserveCacheKey(leg.protocol, leg.tokenIn, leg.tokenOut);
      const existing = this.reserveCache.get(cacheKey);
      if (existing && existing.expiresAt > Date.now()) {
        if (metrics) {
          metrics.reserveCacheHits += 1;
        }
        continue;
      }
      const dedupeKey = `${leg.protocol}:${cacheKey}`;
      if (seenLegKeys.has(dedupeKey)) {
        continue;
      }
      seenLegKeys.add(dedupeKey);
      const factory = this.factoryContracts[leg.protocol];
      if (!factory) {
        this.storeReserveCacheEntry(cacheKey, null);
        continue;
      }
      legContexts.push({
        protocol: leg.protocol,
        tokenIn: leg.tokenIn,
        tokenOut: leg.tokenOut,
        cacheKey,
        factory,
      });
    }

    if (!legContexts.length) {
      return loadedKeys;
    }

    const getPairCalls: MulticallCall[] = legContexts.map((context) => ({
      target: context.factory.target as Address,
      callData: context.factory.interface.encodeFunctionData('getPair', [
        context.tokenIn.address,
        context.tokenOut.address,
      ]),
    }));

    let pairResults: MulticallResult[];
    try {
      pairResults = await this.multicallClient.execute(getPairCalls);
    } catch (error) {
      this.logger.debug('Multicall getPair stage failed', {
        message: error instanceof Error ? error.message : String(error),
        callCount: getPairCalls.length,
      });
      return null;
    }

    const pairContextMap = new Map<
      string,
      {
        pairAddress: Address;
        protocol: PulsexProtocol;
        legs: LegContext[];
      }
    >();

    pairResults.forEach((result, index) => {
      const context = legContexts[index];
      if (!context) {
        return;
      }

      if (!result?.success || !result.returnData) {
        this.storeReserveCacheEntry(context.cacheKey, null);
        return;
      }

      let pairAddress: Address | null = null;
      try {
        const decoded = context.factory.interface.decodeFunctionResult(
          'getPair',
          result.returnData,
        );
        pairAddress = decoded[0] as Address;
      } catch (error) {
        this.logger.debug('Failed to decode getPair via multicall', {
          message: error instanceof Error ? error.message : String(error),
        });
      }

      if (!pairAddress || this.isZeroAddress(pairAddress)) {
        this.storeReserveCacheEntry(context.cacheKey, null);
        return;
      }

      const mapKey = `${context.protocol}:${pairAddress.toLowerCase()}`;
      const existing = pairContextMap.get(mapKey);
      if (existing) {
        existing.legs.push(context);
        return;
      }

      pairContextMap.set(mapKey, {
        pairAddress,
        protocol: context.protocol,
        legs: [context],
      });
    });

    if (!pairContextMap.size) {
      return loadedKeys;
    }

    const pairCalls: MulticallCall[] = [];
    const callMeta: Array<{
      pairAddress: Address;
      protocol: PulsexProtocol;
      legs: LegContext[];
      token0Index: number;
      token1Index: number;
      reservesIndex: number;
    }> = [];

    for (const context of pairContextMap.values()) {
      const token0Index = pairCalls.length;
      pairCalls.push({
        target: context.pairAddress,
        callData: this.pairInterface.encodeFunctionData('token0', []),
      });
      const token1Index = pairCalls.length;
      pairCalls.push({
        target: context.pairAddress,
        callData: this.pairInterface.encodeFunctionData('token1', []),
      });
      const reservesIndex = pairCalls.length;
      pairCalls.push({
        target: context.pairAddress,
        callData: this.pairInterface.encodeFunctionData('getReserves', []),
      });

      callMeta.push({
        pairAddress: context.pairAddress,
        protocol: context.protocol,
        legs: context.legs,
        token0Index,
        token1Index,
        reservesIndex,
      });
    }

    let reserveResults: MulticallResult[];
    try {
      reserveResults = await this.multicallClient.execute(pairCalls);
    } catch (error) {
      this.logger.debug('Multicall reserve stage failed', {
        message: error instanceof Error ? error.message : String(error),
        callCount: pairCalls.length,
      });
      return null;
    }

    for (const meta of callMeta) {
      const token0Result = reserveResults[meta.token0Index];
      const token1Result = reserveResults[meta.token1Index];
      const reservesResult = reserveResults[meta.reservesIndex];

      if (
        !token0Result?.success ||
        !token1Result?.success ||
        !reservesResult?.success
      ) {
        for (const leg of meta.legs) {
          this.storeReserveCacheEntry(leg.cacheKey, null);
        }
        continue;
      }

      let token0: Address | null = null;
      let token1: Address | null = null;
      let reserve0: bigint | null = null;
      let reserve1: bigint | null = null;

      try {
        const decodedToken0 = this.pairInterface.decodeFunctionResult(
          'token0',
          token0Result.returnData,
        );
        const decodedToken1 = this.pairInterface.decodeFunctionResult(
          'token1',
          token1Result.returnData,
        );
        const decodedReserves = this.pairInterface.decodeFunctionResult(
          'getReserves',
          reservesResult.returnData,
        );

        token0 = decodedToken0[0] as Address;
        token1 = decodedToken1[0] as Address;
        reserve0 = BigInt(decodedReserves[0] as bigint);
        reserve1 = BigInt(decodedReserves[1] as bigint);
      } catch (error) {
        this.logger.debug('Failed to decode reserves via multicall', {
          message: error instanceof Error ? error.message : String(error),
          pairAddress: meta.pairAddress,
        });
      }

      if (
        !token0 ||
        !token1 ||
        reserve0 === null ||
        reserve1 === null
      ) {
        for (const leg of meta.legs) {
          this.storeReserveCacheEntry(leg.cacheKey, null);
        }
        continue;
      }

      const entry: PairReserves = {
        pairAddress: meta.pairAddress,
        token0,
        token1,
        reserve0,
        reserve1,
        reserveIn: 0n,
        reserveOut: 0n,
      };

      for (const leg of meta.legs) {
        this.storeReserveCacheEntry(leg.cacheKey, entry);
        loadedKeys.add(leg.cacheKey);
      }
    }

    if (metrics && loadedKeys.size > 0) {
      metrics.multicallPairsLoaded += loadedKeys.size;
    }

    return loadedKeys;
  }

  private countUniqueCpmmPairs(candidates: RouteCandidate[]): number {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      for (const leg of candidate.legs) {
        if (leg.protocol === 'PULSEX_STABLE') {
          continue;
        }
        const [tokenA, tokenB] = [
          leg.tokenIn.address.toLowerCase(),
          leg.tokenOut.address.toLowerCase(),
        ].sort();
        seen.add(`${leg.protocol}:${tokenA}-${tokenB}`);
      }
    }
    return seen.size;
  }

  private logQuoteMetrics(context: QuoteDebugMetrics): void {
    this.logger.debug('PulseXQuoter.quoteBestExactIn metrics', {
      routeCandidatesTotal: context.routeCandidatesTotal ?? 0,
      routeCandidatesEvaluated: context.routeCandidatesEvaluated ?? 0,
      uniqueCpmmPairs: context.uniqueCpmmPairs ?? 0,
      reserveCacheHits: context.reserveCacheHits,
      reserveCacheMisses: context.reserveCacheMisses,
      multicallPairsLoaded: context.multicallPairsLoaded,
      durationMs: Date.now() - context.startTimeMs,
      success: context.success ?? false,
    });
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    options?: { logOnError?: boolean; context?: Record<string, unknown> },
  ): Promise<{ value: T | null; timedOut: boolean }> {
    const { logOnError = true, context } = options ?? {};
    let timeoutHandle: NodeJS.Timeout | undefined;
    return Promise.race([
      promise
        .then((value) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          return { value, timedOut: false };
        })
        .catch((error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          if (logOnError) {
            this.logger.warn('Pulsex RPC call failed', {
              message: error instanceof Error ? error.message : String(error),
              ...(context ?? {}),
            });
          }
          return { value: null, timedOut: false };
        }),
      new Promise<{ value: null; timedOut: boolean }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ value: null, timedOut: true }),
          timeoutMs,
        );
      }),
    ]);
  }
}
