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
  reserveCacheMisses: number;
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
  ): Promise<PulsexQuoteResult> {
    this.splitAmountCache.clear();
    const debugContext = this.debugLoggingEnabled
      ? this.createDebugContext()
      : undefined;
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
      const maxRoutes = this.config.quoteEvaluation.maxRoutes ?? 0;
      if (maxRoutes > 0 && allCandidates.length > maxRoutes) {
        const limited = allCandidates.slice(0, maxRoutes);
        const limitedIds = new Set(limited.map((candidate) => candidate.id));
        const missingStable = allCandidates.filter(
          (candidate) =>
            this.candidateHasStableLeg(candidate) &&
            !limitedIds.has(candidate.id),
        );

        if (missingStable.length > 0) {
          let replaceIndex = limited.length - 1;
          for (const stableCandidate of missingStable) {
            while (
              replaceIndex >= 0 &&
              this.candidateHasStableLeg(limited[replaceIndex])
            ) {
              replaceIndex -= 1;
            }
            if (replaceIndex < 0) {
              break;
            }
            limited[replaceIndex] = stableCandidate;
            replaceIndex -= 1;
          }
        }

        candidates = limited;
      } else {
        candidates = allCandidates;
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

      await this.prewarmReserves(candidates);

      const simulations = await this.evaluateRoutes(
        candidates,
        normalizedRequest.amountIn,
        debugContext,
      );

      if (!simulations.length) {
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

      if (this.config.splitConfig.enabled) {
        const bestSplit = await this.findBestSplit(
          normalizedRequest.amountIn,
          topRanked,
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
      if (debugContext) {
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

    addPath([tokenIn, tokenOut]);

    for (const connector of connectors) {
      addPath([tokenIn, connector, tokenOut]);
    }

    if (this.config.maxConnectorHops >= 2) {
      for (let i = 0; i < connectors.length; i += 1) {
        for (let j = 0; j < connectors.length; j += 1) {
          if (i === j) {
            continue;
          }
          const c1 = connectors[i];
          const c2 = connectors[j];
          addPath([tokenIn, c1, c2, tokenOut]);
        }
      }
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
          this.config.stableRouting.useStableForStableToStable &&
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

    if (
      inStable &&
      outStable &&
      this.config.stableRouting.useStableForStableToStable
    ) {
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
      return this.mapCachedReserves(existing.value, tokenIn, tokenOut);
    }

    if (metrics) {
      metrics.reserveCacheMisses += 1;
    }

    const multicallLoaded = await this.loadReservesForLegsWithMulticall([
      { protocol, tokenIn, tokenOut, cacheKey },
    ]);
    if (multicallLoaded && multicallLoaded.has(cacheKey)) {
      const refreshed = this.reserveCache.get(cacheKey);
      return this.mapCachedReserves(refreshed?.value ?? null, tokenIn, tokenOut);
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
  ): Promise<SimulatedRouteResult[]> {
    const results: SimulatedRouteResult[] = [];
    const concurrency = Math.max(
      1,
      this.config.quoteEvaluation.concurrency ?? 1,
    );
    const timeoutMs = this.config.quoteEvaluation.timeoutMs ?? 4_000;

    for (let i = 0; i < candidates.length; i += concurrency) {
      const batch = candidates.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (candidate) => {
          const { value: simulation } = await this.withTimeout(
            this.simulateRoute(candidate, amountIn, metrics),
            timeoutMs,
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

  private candidateHasStableLeg(candidate: RouteCandidate): boolean {
    return candidate.legs.some((leg) => leg.protocol === 'PULSEX_STABLE');
  }

  private async findBestSplit(
    totalAmountIn: bigint,
    simulations: SimulatedRouteResult[],
    metrics?: QuoteDebugMetrics,
  ): Promise<{ totalAmountOut: bigint; routes: SplitRouteMeta[] } | undefined> {
    if (simulations.length < 2) {
      return undefined;
    }

    const first = simulations[0];
    const second = simulations.find(
      (candidate) => candidate.candidate.id !== first.candidate.id,
    );

    if (!first || !second) {
      return undefined;
    }

    const weights = this.config.splitConfig.weights ?? [];
    let bestTotal = 0n;
    let bestRoutes: SplitRouteMeta[] | undefined;

    for (const weight of weights) {
      if (weight <= 0 || weight >= 10_000) {
        continue;
      }

      const amountInFirst = (totalAmountIn * BigInt(weight)) / 10_000n;
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

    if (!bestRoutes) {
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

  private async prewarmReserves(candidates: RouteCandidate[]): Promise<void> {
    if (!candidates.length) {
      return;
    }
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

    const multicallLoaded = await this.loadReservesForLegsWithMulticall(legsToLoad);
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
    }

    if (!legsToLoad.length) {
      return;
    }

    const concurrency = Math.max(
      1,
      this.config.quoteEvaluation.concurrency ?? 1,
    );

    for (let i = 0; i < legsToLoad.length; i += concurrency) {
      const batch = legsToLoad.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (leg) => {
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

  private createDebugContext(): QuoteDebugMetrics {
    return {
      startTimeMs: Date.now(),
      reserveCacheMisses: 0,
    };
  }

  private async loadReservesForLegsWithMulticall(
    legs: Array<{
      protocol: PulsexProtocol;
      tokenIn: PulsexToken;
      tokenOut: PulsexToken;
      cacheKey?: string;
    }>,
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

    for (const leg of legs) {
      if (leg.protocol === 'PULSEX_STABLE') {
        continue;
      }
      const cacheKey =
        leg.cacheKey ??
        this.buildReserveCacheKey(leg.protocol, leg.tokenIn, leg.tokenOut);
      const existing = this.reserveCache.get(cacheKey);
      if (existing && existing.expiresAt > Date.now()) {
        continue;
      }
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
      reserveCacheMisses: context.reserveCacheMisses,
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
