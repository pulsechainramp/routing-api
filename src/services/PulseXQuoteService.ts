import { ethers, type Provider } from 'ethers';
import { Logger } from '../utils/logger';
import { encodeSwapRoute, getTokenDecimals, getTokenSymbol, setPulsechainProviderForWeb3, toCorrectDexName } from '../utils/web3';
import pulsexConfig from '../config/pulsex';
import { PulseXQuoter } from '../pulsex/PulseXQuoter';
import type {
  Address,
  ExactInQuoteRequest,
  PulsexQuoteResult,
  PulsexToken,
  RouteLegSummary,
  SplitRouteMeta,
} from '../types/pulsex';
import type { QuoteResponse } from '../types/QuoteResponse';
import type { CombinedRoute, CombinedPath, CombinedSubswap, CombinedSwap } from '../types/Quote';
import type { SwapRoute, SwapStep, Group } from '../types/swapmanager';

interface QuoteParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
}

interface RouteEntry {
  shareBps: number;
  legs: RouteLegSummary[];
}

const DEFAULT_SLIPPAGE_PERCENT = 0.5;
const DEADLINE_BUFFER_SECONDS = 600;
const TEN_THOUSAND = 10_000n;
const PULSEX_DEBUG_LOGGING_ENABLED =
  process.env.PULSEX_DEBUG_LOGGING === 'true';
export const PULSEX_QUOTE_TIMEOUT_ERROR = 'PulseX quote timed out';

export class PulseXQuoteService {
  private readonly logger = new Logger('PulseXQuoteService');
  private readonly quoter: PulseXQuoter;
  private readonly wrappedNativeAddress: Address;

  constructor(private readonly provider: Provider, quoter?: PulseXQuoter) {
    setPulsechainProviderForWeb3(provider);
    this.quoter = quoter ?? new PulseXQuoter(provider, pulsexConfig);
    const nativeToken = pulsexConfig.connectorTokens.find((token) => token.isNative);
    this.wrappedNativeAddress = (nativeToken?.address ??
      pulsexConfig.connectorTokens[0]?.address) as Address;
    if (!this.wrappedNativeAddress) {
      throw new Error('Unable to determine wrapped native token address');
    }
  }

  public async getQuote(params: QuoteParams): Promise<QuoteResponse> {
    const startTime = Date.now();
    let globalTimeoutHit = false;
    let success = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const slippageBps = this.normalizeSlippageBps(params.allowedSlippage);
      const request = await this.buildQuoteRequest(params, slippageBps);
      const totalTimeoutMs = Number(
        process.env.PULSEX_QUOTE_TOTAL_TIMEOUT_MS ?? 6_000,
      );
      const quotePromise = this.quoter.quoteBestExactIn(request);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(PULSEX_QUOTE_TIMEOUT_ERROR)),
          totalTimeoutMs,
        );
      });
      const quote = await Promise.race([quotePromise, timeoutPromise]);
      const response = this.buildQuoteResponse(params, request, quote, slippageBps);
      success = true;
      return response;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === PULSEX_QUOTE_TIMEOUT_ERROR
      ) {
        globalTimeoutHit = true;
        this.logger.warn('PulseX quote timed out', {
          timeoutMs: Number(
            process.env.PULSEX_QUOTE_TOTAL_TIMEOUT_MS ?? 6_000,
          ),
        });
      } else {
        this.logger.error('Failed to build PulseX quote', { error });
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (PULSEX_DEBUG_LOGGING_ENABLED) {
        this.logger.debug('PulseXQuoteService.getQuote metrics', {
          durationMs: Date.now() - startTime,
          globalTimeoutHit,
          success,
        });
      }
    }
  }

  private async buildQuoteRequest(
    params: QuoteParams,
    slippageBps: number,
  ): Promise<ExactInQuoteRequest> {
    const normalizedIn = this.normalizeTokenAddress(params.tokenInAddress);
    const normalizedOut = this.normalizeTokenAddress(params.tokenOutAddress);

    return {
      chainId: pulsexConfig.chainId,
      tokenIn: await this.buildPulsexToken(normalizedIn, params.tokenInAddress),
      tokenOut: await this.buildPulsexToken(normalizedOut, params.tokenOutAddress),
      amountIn: BigInt(params.amount),
      slippageBps,
      recipient: (params.account ?? pulsexConfig.routers.default) as Address,
      deadlineSeconds: Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS,
    };
  }

  private async buildPulsexToken(address: string, original: string): Promise<PulsexToken> {
    const [decimals, symbol] = await Promise.all([
      getTokenDecimals(address),
      getTokenSymbol(address),
    ]);

    return {
      address: address as Address,
      decimals,
      symbol,
      isNative: this.isNativeToken(original),
    };
  }

  private buildQuoteResponse(
    params: QuoteParams,
    request: ExactInQuoteRequest,
    result: PulsexQuoteResult,
    slippageBps: number,
  ): QuoteResponse {
    const deadline = request.deadlineSeconds ?? Math.floor(Date.now() / 1000) + DEADLINE_BUFFER_SECONDS;
    const minAmountOut = this.computeMinAmountOut(result.totalAmountOut, slippageBps);
    const isEthOut = this.isNativeToken(params.tokenOutAddress);
    const routeEntries = this.buildRouteEntries(result);
    const combinedRoute = this.buildCombinedRoute(routeEntries);
    const swapRoute = this.buildSwapRoute(
      routeEntries,
      params,
      request,
      minAmountOut.toString(),
      deadline,
      isEthOut,
    );

    return {
      calldata: encodeSwapRoute(swapRoute),
      tokenInAddress: this.formatResponseToken(params.tokenInAddress, request.tokenIn.address),
      tokenOutAddress: this.formatResponseToken(params.tokenOutAddress, request.tokenOut.address),
      amountIn: params.amount,
      minAmountOut: minAmountOut.toString(),
      outputAmount: result.totalAmountOut.toString(),
      deadline,
      gasAmountEstimated: Number(result.gasEstimate ?? 0n),
      gasUSDEstimated: result.gasUsd ?? 0,
      route: combinedRoute,
    };
  }

  private buildRouteEntries(result: PulsexQuoteResult): RouteEntry[] {
    if (result.splitRoutes && result.splitRoutes.length > 0) {
      return result.splitRoutes.map((route) => ({
        shareBps: route.shareBps,
        legs: route.legs,
      }));
    }

    if (!result.singleRoute || result.singleRoute.length === 0) {
      throw new Error('Pulsex quote did not return any route legs');
    }

    return [
      {
        shareBps: 10_000,
        legs: result.singleRoute,
      },
    ];
  }

  private buildCombinedRoute(entries: RouteEntry[]): CombinedRoute {
    return entries.map((entry) => {
      const subroutes: CombinedSubswap[] = entry.legs.map((leg) => ({
        percent: 100,
        paths: [this.toCombinedPath(leg)],
      }));

      return {
        percent: entry.shareBps / 100,
        subroutes,
      } as CombinedSwap;
    });
  }

  private buildSwapRoute(
    entries: RouteEntry[],
    params: QuoteParams,
    request: ExactInQuoteRequest,
    minAmountOut: string,
    deadline: number,
    isEthOut: boolean,
  ): SwapRoute {
    const parentGroups: Group[] = entries.map((entry, index) => ({
      id: index,
      percent: this.toSwapManagerPercent(entry.shareBps),
    }));

    const steps: SwapStep[] = [];
    let nextGroupId = parentGroups.length;

    entries.forEach((entry, entryIndex) => {
      const entryPercent = parentGroups[entryIndex]?.percent ?? 0;
      entry.legs.forEach((leg, legIdx) => {
        const id = nextGroupId++;
        steps.push({
          dex: toCorrectDexName(this.protocolDisplayName(leg.protocol)),
          path: [leg.tokenIn.address, leg.tokenOut.address],
          pool: leg.poolAddress,
          percent: legIdx === 0 ? entryPercent : 100_000,
          groupId: id,
          parentGroupId: legIdx === 0 ? parentGroups[entryIndex].id : id - 1,
          userData: '0x',
        });
      });
    });

    return {
      steps,
      parentGroups,
      groupCount: parentGroups.length + steps.length,
      destination: params.account ?? ethers.ZeroAddress,
      tokenIn: request.tokenIn.address,
      tokenOut: request.tokenOut.address,
      deadline,
      amountIn: request.amountIn.toString(),
      amountOutMin: minAmountOut,
      isETHOut: isEthOut,
    };
  }

  private toSwapManagerPercent(shareBps: number): number {
    if (shareBps <= 0) {
      return 0;
    }
    const scaled = Math.round((shareBps * 100_000) / 10_000);
    if (scaled > 100_000) {
      return 100_000;
    }
    return scaled;
  }

  private toCombinedPath(leg: RouteLegSummary): CombinedPath {
    return {
      percent: 100,
      exchange: this.protocolDisplayName(leg.protocol),
      pool: leg.poolAddress,
      tokens: [this.toPathToken(leg.tokenIn), this.toPathToken(leg.tokenOut)],
    };
  }

  private toPathToken(token: PulsexToken) {
    return {
      address: token.address,
      symbol: token.symbol ?? token.address.slice(0, 6),
      decimals: token.decimals,
      chainId: pulsexConfig.chainId,
    };
  }

  private protocolDisplayName(protocol: RouteLegSummary['protocol']): string {
    if (protocol === 'PULSEX_V1') {
      return 'PulseX V1';
    }
    if (protocol === 'PULSEX_V2') {
      return 'PulseX V2';
    }
    return 'PulseX Stable';
  }

  private computeMinAmountOut(amountOut: bigint, slippageBps: number): bigint {
    return (amountOut * (TEN_THOUSAND - BigInt(slippageBps))) / TEN_THOUSAND;
  }

  private normalizeSlippageBps(value?: number): number {
    if (value === undefined) {
      return this.normalizeSlippageBps(DEFAULT_SLIPPAGE_PERCENT);
    }
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }
    if (value > 100) {
      return 10_000;
    }
    return Math.round(value * 100);
  }

  private isNativeToken(address?: string): boolean {
    if (!address) {
      return false;
    }
    const normalized = address.toLowerCase();
    return (
      normalized === 'pls' ||
      normalized === ethers.ZeroAddress.toLowerCase() ||
      normalized === '0x0'
    );
  }

  private normalizeTokenAddress(address: string): string {
    return this.isNativeToken(address) ? this.wrappedNativeAddress : address;
  }

  private formatResponseToken(original: string, normalized: string): string {
    return this.isNativeToken(original) ? ethers.ZeroAddress : normalized;
  }
}
