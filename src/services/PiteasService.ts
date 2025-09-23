import axios, { AxiosInstance } from "axios";
import { Logger } from "../utils/logger";
import { RateLimiter } from "./RateLimiter";
import { ProxyManager } from "./ProxyManager";
import { ethers } from "ethers";
import { combineRoute, encodeSwapRoute, toCorrectDexName } from "../utils/web3";

import PulseXStableSwapPoolAbi from "../abis/PulseXStableSwapPool.json";
import PulsexFactoryAbi from "../abis/PulsexFactory.json";

import { SwapRoute, SwapStep } from "../types/swapmanager";
import { CombinedRoute } from "../types/Quote";
import config from "../config";
import { FallbackQuoterService } from "./FallbackQuoterService";
import { buildAllowlistFromEnvAndQuery, ENFORCE_ALLOWED_DEXES } from "../config/dexPolicy";


interface QuoteParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
  allowedDexes?: string;
  blockedDexes?: string;
  policy?: 'strict' | 'soft';
}

interface QuoteResponse {
  calldata: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  outputAmount: string;
  gasAmountEstimated: number;
  gasUSDEstimated: number;
  route: CombinedRoute;
}


export class PiteasService {
  private proxyManager: ProxyManager;
  private logger: Logger;
  private rateLimiter: RateLimiter;
  private baseUrl: string;
  private fallback = new FallbackQuoterService();
  
  constructor(
    baseUrl: string,
    proxyManager: ProxyManager,
    rateLimiter: RateLimiter
  ) {
    this.logger = new Logger("PiteasService");
    this.rateLimiter = rateLimiter;
    this.proxyManager = proxyManager;
    this.baseUrl = baseUrl;
  }

  public async getQuote(params: QuoteParams): Promise<QuoteResponse> {
    try {
      const useProxy = (process.env.USE_PROXY ?? 'false').toLowerCase() === 'true';

      let axiosInstance: AxiosInstance;
      let proxyUrl: string | undefined;

      if (useProxy) {
        axiosInstance = this.proxyManager.createAxiosInstance();
        const proxy = this.proxyManager.getCurrentProxy?.();
        proxyUrl = proxy?.url;
        this.logger.info(`Using proxy: ${proxyUrl ?? '<none>'}`, { service: 'ProxyManager' });
      } else {
        // Important: proxy:false tells Axios to ignore proxy env vars too
        axiosInstance = axios.create({ baseURL: this.baseUrl, proxy: false });
      }

      const rateKey = proxyUrl ? `proxy:${proxyUrl}` : 'direct';

      axiosInstance.defaults.baseURL = this.baseUrl;

      const response = await this.rateLimiter.schedule(
        () =>
          axiosInstance.get("/quote", {
            params: {
              tokenInAddress: params.tokenInAddress,
              tokenOutAddress: params.tokenOutAddress,
              amount: params.amount,
              allowedSlippage: params.allowedSlippage || 0.5,
              ...(params.account && { account: params.account }),
            },
          }),
        rateKey
      );

      const piteas = response.data;
      // ==== GATE: block unsupported DEXes, fail-soft with fallback ====
      const allow = buildAllowlistFromEnvAndQuery(undefined, params.allowedDexes, params.blockedDexes);
      const violations = this.findUnsupportedDexes(piteas?.route, allow);

      if (violations.length) {
        this.logger.warn('Unsupported DEX(es) detected in Piteas route', { violations });

        // soft policy: try fallback route first
        const isSoft = params.policy === 'soft' || !ENFORCE_ALLOWED_DEXES;
        const fallback = await this.tryFallback(piteas, params);
        if (fallback) return fallback;

        if (isSoft) {
          // soft mode but no fallback workable: surface clear error
          const err: any = new Error('No supported DEX path available');
          err.statusCode = 422;
          err.details = { unsupportedDexes: violations };
          throw err;
        }

        // strict mode
        const err: any = new Error('UNSUPPORTED_DEX_IN_ROUTE');
        err.statusCode = 409;
        err.details = { unsupportedDexes: violations };
        throw err;
      }

      // No violations → proceed as today
      return await this.transformQuoteData(piteas);

    } catch (error) {
      this.logger.error("Failed to fetch quote from Piteas", { error });
      throw error;
    }
  }

  private findUnsupportedDexes(route: any, allow: Set<string>): string[] {
    if (!route) return [];
    const seen = new Set<string>();

    const add = (ex: string) => {
      const canon = (toCorrectDexName(ex) || '').toLowerCase();
      seen.add(canon || `unknown:${ex}`);
    };

    // v1 shape: swaps -> subSwaps -> paths
    for (const sw of route.swaps ?? []) {
      for (const ss of sw.subswaps ?? []) {
        for (const p of ss.paths ?? []) add(p.exchange);
      }
      // tolerate a flattened shape: swaps -> paths
      for (const p of sw.paths ?? []) add(p.exchange);
    }

    // ultra-flat fallback: route.paths[*].exchange (just in case)
    for (const p of route.paths ?? []) {
      if (p?.exchange) add(p.exchange);
      // or nested paths arrays
      for (const pp of p?.paths ?? []) if (pp?.exchange) add(pp.exchange);
    }

    const bad: string[] = [];
    for (const d of seen) if (d.startsWith('unknown:') || !allow.has(d)) bad.push(d);
    return bad;
  }

  private async tryFallback(piteas: any, params: QuoteParams) {
    // pull token metadata from Piteas response for UI/debug
    const srcToken = piteas?.srcToken, destToken = piteas?.destToken;
    if (!srcToken || !destToken) return null;

    const amountIn = ethers.getBigInt(piteas?.srcAmount ?? params.amount);
    const fb = await this.fallback.quoteBestExactIn(
      srcToken.address, destToken.address, amountIn, srcToken, destToken
    );
    if (!fb.success) return null;

    // Return in the same shape your controller already returns
    return {
      calldata: fb.routeBytes,
      tokenInAddress: srcToken.address,
      tokenOutAddress: destToken.address,
      outputAmount: fb.destAmount.toString(),
      gasAmountEstimated: fb.gasAmountEstimated,
      gasUSDEstimated: fb.gasUSDEstimated,
      route: fb.combinedRoute,
    };
  }

  private async transformQuoteData(piteasData: any): Promise<QuoteResponse> {
    // Implement the transformation logic here
    // This should convert Piteas API response to your custom format
    const {
      srcToken,
      destToken,
      srcAmount,
      destAmount,
      route: { paths, swaps },
      gasUseEstimate,
      gasUseEstimateUSD,
    } = piteasData;

    console.log(JSON.stringify(swaps));
    const route: SwapRoute = {
      steps: [],
      deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes
      amountIn: ethers.getBigInt(srcAmount).toString(),
      amountOutMin: ethers.getBigInt(destAmount).toString(),
      parentGroups: [],
      groupCount: 0,
      destination: ethers.ZeroAddress,
      tokenIn: srcToken.address,
      tokenOut: destToken.address,
    };

    const swapRoute = [];

    let currentGroupId = 0;
    for (const [swapIndex, swap] of swaps.entries()) {
      const parentGroupId = currentGroupId++;
      route.parentGroups.push({ id: parentGroupId, percent: swap.percent });

      for (const [subswapIndex, subswap] of swap.subswaps.entries()) {
        const groupId = currentGroupId++;
        for (const [pathIndex, path] of subswap.paths.entries()) {
          let userData = "0x";
          if (path.exchange == "PulseX Stable") {
            let index1: number = -1,
              index2: number = -1;
            const StablePool = new ethers.Contract(
              path.address,
              PulseXStableSwapPoolAbi,
              new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.pulsechain.com")
            );
            for (let i = 0; i <= 2; i++) {
              const token = await StablePool.coins(i);
              if (
                token.toLowerCase() ==
                paths[swapIndex][subswapIndex].address.toLowerCase()
              ) {
                index1 = i;
              } else if (
                token.toLowerCase() ==
                paths[swapIndex][subswapIndex + 1].address.toLowerCase()
              ) {
                index2 = i;
              }
            }

            userData = ethers.solidityPacked(
              ["uint8", "uint8"],
              [index1, index2]
            );
          }

          const dexName = toCorrectDexName(path.exchange);

          let step: SwapStep = {
            dex: dexName,
            path: [
              paths[swapIndex][subswapIndex].address,
              paths[swapIndex][subswapIndex + 1].address,
            ],
            percent: path.percent,
            pool: path.address,
            userData,
            groupId: groupId,
            parentGroupId:
              pathIndex == 0 && subswapIndex == 0 ? parentGroupId : groupId - 1,
          };

          if (dexName == "") { // if unsupported dex appears, we recompose the route
            step = await this.recomposeStep(step);
            console.log("Recomposed step: ", step);
          }
          
          route.steps.push(step);
        }
      }
    }
    route.groupCount = currentGroupId;

    return {
      calldata: encodeSwapRoute(route),
      tokenInAddress: srcToken.address,
      tokenOutAddress: destToken.address,
      outputAmount: ethers.getBigInt(destAmount).toString(),
      gasAmountEstimated: gasUseEstimate,
      gasUSDEstimated: gasUseEstimateUSD,
      route: combineRoute({ paths, swaps })
    };
  }

  private async recomposeStep(step: SwapStep): Promise<SwapStep> {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.pulsechain.com");

    const pulsexV1Factory = new ethers.Contract(
      config.PulsexV1FactoryAddress,
      PulsexFactoryAbi,
      provider
    );

    const pulsexV2Factory = new ethers.Contract(
      config.PulsexV2FactoryAddress,
      PulsexFactoryAbi,
      provider
    );

    const pulsexV1Pair = await pulsexV1Factory.getPair(step.path[0], step.path[1]);
    const pulsexV2Pair = await pulsexV2Factory.getPair(step.path[0], step.path[1]);

    if (pulsexV2Pair != ethers.ZeroAddress) {
      step.dex = "pulsexV2";
      step.pool = pulsexV2Pair;
    } else if (pulsexV1Pair != ethers.ZeroAddress) {
      step.dex = "pulsexV1";
      step.pool = pulsexV1Pair;
    }

    return step;
  }
}
