import { AxiosInstance } from "axios";
import { Logger } from "../utils/logger";
import { RateLimiter } from "./RateLimiter";
import { ProxyManager } from "./ProxyManager";
import { ethers } from "ethers";
import { combineRoute, encodeSwapRoute, toCorrectDexName } from "../utils/web3";

import PulseXStableSwapPoolAbi from "../abis/PulseXStableSwapPool.json";
import PulsexFactoryAbi from "../abis/PulsexFactory.json";

import { SwapRoute, SwapStep } from "../types/swapmanager";
import { CombinedRoute } from "../types/Quote";
import { QuoteResponse } from "../types/QuoteResponse";
import config from "../config";

interface QuoteParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
}


export class PiteasService {
  private proxyManager: ProxyManager;
  private logger: Logger;
  private rateLimiter: RateLimiter;
  private baseUrl: string;

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
      // Create new axios instance with new proxy for each request
      const axiosInstance = this.proxyManager.createAxiosInstance();
      const proxy = this.proxyManager.getCurrentProxy();
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
        proxy.url
      );

      const isEthOut = params.tokenOutAddress == "PLS" || params.tokenOutAddress == ethers.ZeroAddress;
      return await this.transformQuoteData(response.data, isEthOut);
    } catch (error) {
      this.logger.error("Failed to fetch quote from Piteas", { error });
      throw error;
    }
  }

  private async transformQuoteData(piteasData: any, isEthOut: boolean): Promise<QuoteResponse> {
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
    const amountIn = ethers.getBigInt(srcAmount).toString();
    const amountOutMin = ethers.getBigInt(destAmount).toString();
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

    const route: SwapRoute = {
      steps: [],
      deadline,
      amountIn,
      amountOutMin,
      parentGroups: [],
      groupCount: 0,
      destination: ethers.ZeroAddress,
      tokenIn: srcToken.address,
      tokenOut: destToken.address,
      isETHOut: isEthOut,
    };

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
      amountIn,
      minAmountOut: amountOutMin,
      outputAmount: ethers.getBigInt(destAmount).toString(),
      deadline,
      gasAmountEstimated: gasUseEstimate,
      gasUSDEstimated: Number(gasUseEstimateUSD ?? 0),
      route: combineRoute({ paths, swaps }),
    };
  }

  private async recomposeStep(step: SwapStep): Promise<SwapStep> {
    const pulsexV1Factory = new ethers.Contract(
      config.PulsexV1FactoryAddress,
      PulsexFactoryAbi,
      new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.pulsechain.com")
    );

    const pulsexV2Factory = new ethers.Contract(
      config.PulsexV2FactoryAddress,
      PulsexFactoryAbi,
      new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.pulsechain.com")
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
