import { Contract, ZeroAddress, type Provider } from 'ethers';
import PulsexFactoryAbi from '../abis/PulsexFactory.json';
import { StableThreePoolQuoter } from './StableThreePoolQuoter';
import { PulseXPriceOracle } from './PulseXPriceOracle';
import { PulsexGasEstimator } from './gasEstimator';
import { getAmountOutCpmm } from './cpmmMath';
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

interface RouteLeg {
  protocol: PulsexProtocol;
  tokenIn: PulsexToken;
  tokenOut: PulsexToken;
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

export class PulseXQuoter {
  private readonly stableQuoter: StableThreePoolQuoter;
  private readonly priceOracle: PulseXPriceOracle;
  private readonly gasEstimator: PulsexGasEstimator;

  private readonly factoryContracts: Record<
    'PULSEX_V1' | 'PULSEX_V2',
    Contract
  >;

  private readonly stableTokenSet: Set<string>;
  private readonly wrappedNativeToken?: PulsexToken;

  private readonly reserveCache = new Map<string, ReserveCacheEntry>();
  private readonly splitAmountCache = new Map<string, Map<string, bigint>>();

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

  public generateRouteCandidates(
    tokenIn: PulsexToken,
    tokenOut: PulsexToken,
  ): RouteCandidate[] {
    const nodePaths = this.generateNodePaths(tokenIn, tokenOut);
    return this.expandPathsToRoutes(nodePaths);
  }

  public async quoteBestExactIn(
    request: ExactInQuoteRequest,
  ): Promise<PulsexQuoteResult> {
    this.splitAmountCache.clear();
    const normalizedRequest = this.normalizeRequest(request);
    if (normalizedRequest.amountIn <= 0n) {
      throw new Error('amountIn must be greater than zero');
    }

    const candidates = this.generateRouteCandidates(
      normalizedRequest.tokenIn,
      normalizedRequest.tokenOut,
    );

    if (!candidates.length) {
      throw new Error('No candidate PulseX routes found');
    }

    const simulations = await this.evaluateRoutes(
      candidates,
      normalizedRequest.amountIn,
    );

    if (!simulations.length) {
      throw new Error('No valid PulseX routes after simulation');
    }

    const preferStableRoutes = this.shouldPreferStableRoutes(
      normalizedRequest.tokenIn,
      normalizedRequest.tokenOut,
    );

    const rankedRoutes = this.rankSimulations(simulations, preferStableRoutes);
    const topRanked = rankedRoutes.slice(0, ROUTE_RANK_LIMIT);
    const bestSingle = topRanked[0];
    if (!bestSingle) {
      throw new Error('Unable to rank PulseX routes');
    }

    let totalAmountOut = bestSingle.amountOut;
    let singleRoute: RouteLegSummary[] | undefined = bestSingle.legs;
    let splitRoutes: SplitRouteMeta[] | undefined;

    if (this.config.splitConfig.enabled) {
      const bestSplit = await this.findBestSplit(
        normalizedRequest.amountIn,
        topRanked,
      );
      if (bestSplit && bestSplit.totalAmountOut > totalAmountOut) {
        totalAmountOut = bestSplit.totalAmountOut;
        splitRoutes = bestSplit.routes;
        singleRoute = undefined;
      }
    }

    return {
      request: normalizedRequest,
      totalAmountOut,
      routerAddress: this.config.routers.default,
      singleRoute,
      splitRoutes,
      ...(await this.buildGasEstimates(singleRoute, splitRoutes)),
    };
  }

  public async simulateRoute(
    route: RouteCandidate,
    amountIn: bigint,
  ): Promise<{ amountOut: bigint; legs: RouteLegSummary[] } | null> {
    let cursorAmount = amountIn;
    const summaries: RouteLegSummary[] = [];

    for (const leg of route.legs) {
      if (leg.protocol === 'PULSEX_STABLE') {
        const amountOut = await this.stableQuoter.quoteStableOut(
          leg.tokenIn.address,
          leg.tokenOut.address,
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
        });
        continue;
      }

      const reserves = await this.getPairReserves(
        leg.protocol,
        leg.tokenIn,
        leg.tokenOut,
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
  ): Promise<PairReserves | null> {
    if (protocol === 'PULSEX_STABLE') {
      return null;
    }

    const cacheKey = this.buildReserveCacheKey(protocol, tokenIn, tokenOut);
    const existing = this.reserveCache.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) {
      return this.mapCachedReserves(existing.value, tokenIn, tokenOut);
    }

    const factory = this.factoryContracts[protocol];
    if (!factory) {
      return null;
    }

    const pairAddress: string = await factory.getPair(
      tokenIn.address,
      tokenOut.address,
    );

    if (!pairAddress || pairAddress === '0x0000000000000000000000000000000000000000') {
      this.reserveCache.set(cacheKey, {
        expiresAt: Date.now() + this.config.cacheTtlMs.reserves,
        value: null,
      });
      return null;
    }

    const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
    const token0 = (await pairContract.token0()) as string;
    const token1 = (await pairContract.token1()) as string;

    const [reserve0, reserve1] = await pairContract.getReserves();

    const entry: PairReserves = {
      pairAddress,
      token0: token0 as Address,
      token1: token1 as Address,
      reserve0: BigInt(reserve0),
      reserve1: BigInt(reserve1),
      reserveIn: 0n,
      reserveOut: 0n,
    };

    this.reserveCache.set(cacheKey, {
      expiresAt: Date.now() + this.config.cacheTtlMs.reserves,
      value: entry,
    });

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

  private isStableToken(address: string): boolean {
    return this.stableTokenSet.has(address.toLowerCase());
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

  private async evaluateRoutes(
    candidates: RouteCandidate[],
    amountIn: bigint,
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
          const simulation = await this.withTimeout(
            this.simulateRoute(candidate, amountIn),
            timeoutMs,
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

  private async findBestSplit(
    totalAmountIn: bigint,
    simulations: SimulatedRouteResult[],
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
      );
      const amountOutSecond = await this.simulateAmountWithCache(
        second.candidate,
        amountInSecond,
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

    const simulation = await this.simulateRoute(candidate, amountIn);
    const amountOut = simulation?.amountOut ?? 0n;
    routeCache.set(cacheKey, amountOut);
    return amountOut;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T | null> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    return Promise.race([
      promise
        .then((value) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          return value;
        })
        .catch(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          return null;
        }),
      new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  }
}
