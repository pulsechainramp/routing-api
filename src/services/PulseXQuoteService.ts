import { Logger } from "../utils/logger";
import { ethers } from "ethers";
import { combineRoute, encodeSwapRoute, toCorrectDexName, getTokenDecimals, getTokenSymbol } from "../utils/web3";

import PulseXStableSwapPoolAbi from "../abis/PulseXStableSwapPool.json";
import PulsexFactoryAbi from "../abis/PulsexFactory.json";

import { SwapRoute, SwapStep } from "../types/swapmanager";
import { CombinedRoute, Route, PathToken, Swap, Subswap, PathInfo } from "../types/Quote";
import config from "../config";

interface QuoteParams {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
}

interface QuoteResponse {
  calldata: string;
  tokenInAdress: string;
  tokenOutAddress: string;
  outputAmount: string;
  gasAmountEstimated: number;
  gasUSDEstimated: number;
  route: CombinedRoute;
}


export class PulseXQuoteService {
  private logger: Logger;
  private provider: ethers.JsonRpcProvider;
  private pulsexV1Factory: ethers.Contract;
  private pulsexV2Factory: ethers.Contract;
  private pulsexV1Router: ethers.Contract;
  private pulsexV2Router: ethers.Contract;

  constructor() {
    this.logger = new Logger("PulseXQuoteService");
    this.provider = new ethers.JsonRpcProvider(config.RPC_URL);
    this.pulsexV1Factory = new ethers.Contract(
      config.PulsexV1FactoryAddress,
      PulsexFactoryAbi,
      this.provider
    );
    this.pulsexV2Factory = new ethers.Contract(
      config.PulsexV2FactoryAddress,
      PulsexFactoryAbi,
      this.provider
    );
    
    // Standard PancakeSwap router ABI for getAmountsOut
    const routerABI = [
      "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
      "function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)",
      "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
      "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
      "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
    ];
    
    this.pulsexV1Router = new ethers.Contract(
      config.PulsexV1RouterAddress,
      routerABI,
      this.provider
    );
    this.pulsexV2Router = new ethers.Contract(
      config.PulsexV2RouterAddress,
      routerABI,
      this.provider
    );
  }

  public async getQuote(params: QuoteParams): Promise<QuoteResponse> {
    try {
      this.logger.info("Getting PulseX quote", { 
        tokenIn: params.tokenInAddress, 
        tokenOut: params.tokenOutAddress, 
        amount: params.amount 
      });

      const isEthOut = params.tokenOutAddress === "PLS" || params.tokenOutAddress === ethers.ZeroAddress;
      params.tokenInAddress = params.tokenInAddress == "PLS" ? config.WPLS : params.tokenInAddress;
      params.tokenOutAddress = params.tokenOutAddress == "PLS" ? config.WPLS : params.tokenOutAddress;
      
      // First, try direct liquidity between tokenIn and tokenOut
      let route = await this.findDirectRoute(params.tokenInAddress, params.tokenOutAddress, params.amount);
      
      // If no direct route, try through PLS
      if (!route) {
        this.logger.info("No direct route found, trying through PLS");
        route = await this.findRouteThroughPLS(params.tokenInAddress, params.tokenOutAddress, params.amount);
      }

      if (!route) {
        throw new Error("No liquidity found for this token pair");
      }

      return await this.transformToQuoteResponse(route, params, isEthOut);
    } catch (error) {
      this.logger.error("Failed to get PulseX quote", { error });
      throw error;
    }
  }

  private async findDirectRoute(tokenIn: string, tokenOut: string, amount: string): Promise<Route | null> {
    try {
      // Check PulseX V2 first
      const v2Pair = await this.pulsexV2Factory.getPair(tokenIn, tokenOut);
      if (v2Pair !== ethers.ZeroAddress) {
        this.logger.info("Found PulseX V2 direct pair", { pair: v2Pair });
        return await this.createDirectRoute(tokenIn, tokenOut, amount, v2Pair, "PulseX V2");
      }

      // Check PulseX V1
      const v1Pair = await this.pulsexV1Factory.getPair(tokenIn, tokenOut);
      if (v1Pair !== ethers.ZeroAddress) {
        this.logger.info("Found PulseX V1 direct pair", { pair: v1Pair });
        return await this.createDirectRoute(tokenIn, tokenOut, amount, v1Pair, "PulseX V1");
      }

      return null;
    } catch (error) {
      this.logger.error("Error finding direct route", { error });
      return null;
    }
  }

  private async findRouteThroughPLS(tokenIn: string, tokenOut: string, amount: string): Promise<Route | null> {
    try {
      const plsAddress = ethers.ZeroAddress; // PLS is represented as zero address
      
      // Check if we can go tokenIn -> PLS
      const tokenInToPLS = await this.findDirectRoute(tokenIn, plsAddress, amount);
      if (!tokenInToPLS) {
        return null;
      }

      // Get the output amount from tokenIn -> PLS
      const plsAmount = await this.getAmountOut(tokenIn, plsAddress, amount, tokenInToPLS);
      if (!plsAmount) {
        return null;
      }

      // Check if we can go PLS -> tokenOut
      const plsToTokenOut = await this.findDirectRoute(plsAddress, tokenOut, plsAmount);
      if (!plsToTokenOut) {
        return null;
      }

      // Combine the routes
      return this.combineRoutes(tokenInToPLS, plsToTokenOut);
    } catch (error) {
      this.logger.error("Error finding route through PLS", { error });
      return null;
    }
  }

  private async createDirectRoute(tokenIn: string, tokenOut: string, amount: string, pairAddress: string, exchange: string): Promise<Route> {
    const tokenInInfo = await this.getTokenInfo(tokenIn);
    const tokenOutInfo = await this.getTokenInfo(tokenOut);

    const path: PathToken[] = [tokenInInfo, tokenOutInfo];
    const pathInfo: PathInfo = {
      percent: 100000, // 100% in basis points (100000 = 100%)
      address: pairAddress,
      exchange: exchange
    };

    const subswap: Subswap = {
      percent: 100000,
      paths: [pathInfo]
    };

    const swap: Swap = {
      percent: 100000,
      subswaps: [subswap]
    };

    return {
      paths: [path],
      swaps: [swap]
    };
  }

  private async getTokenInfo(tokenAddress: string): Promise<PathToken> {
    const decimals = await getTokenDecimals(tokenAddress);
    const symbol = await getTokenSymbol(tokenAddress);
    return {
      address: tokenAddress,
      symbol: symbol,
      decimals: decimals,
      chainId: 369 // PulseChain chain ID
    };
  }

  private async getAmountOut(tokenIn: string, tokenOut: string, amountIn: string, route: Route): Promise<string | null> {
    try {
      const path = [tokenIn, tokenOut];
      
      // Try PulseX V2 first
      try {
        const amounts = await this.pulsexV2Router.getAmountsOut(amountIn, path);
        if (amounts && amounts.length > 1) {
          return amounts[1].toString();
        }
      } catch (error) {
        this.logger.debug("PulseX V2 getAmountsOut failed, trying V1", { error });
      }
      
      // Try PulseX V1
      try {
        const amounts = await this.pulsexV1Router.getAmountsOut(amountIn, path);
        if (amounts && amounts.length > 1) {
          return amounts[1].toString();
        }
      } catch (error) {
        this.logger.error("Both PulseX V1 and V2 getAmountsOut failed", { error });
      }
      
      return null;
    } catch (error) {
      this.logger.error("Error getting amount out", { error });
      return null;
    }
  }

  private combineRoutes(route1: Route, route2: Route): Route {
    // Combine two routes into one
    const combinedPaths: PathToken[][] = [...route1.paths, ...route2.paths];
    const combinedSwaps: Swap[] = [...route1.swaps, ...route2.swaps];
    
    return {
      paths: combinedPaths,
      swaps: combinedSwaps
    };
  }

  private async transformToQuoteResponse(route: Route, params: QuoteParams, isEthOut: boolean): Promise<QuoteResponse> {
    // Calculate actual output amount
    const outputAmount = await this.calculateRouteOutput(route, params.amount);
    if (!outputAmount) {
      throw new Error("Failed to calculate output amount for route");
    }

    // Calculate gas estimation
    const gasEstimate = await this.estimateGas(route, params);
    
    const swapRoute: SwapRoute = {
      steps: [],
      deadline: Math.floor(Date.now() / 1000 + 1000 * 10),
      amountIn: params.amount,
      amountOutMin: outputAmount, // Use calculated output amount
      parentGroups: [],
      groupCount: 0,
      destination: ethers.ZeroAddress,
      tokenIn: params.tokenInAddress,
      tokenOut: params.tokenOutAddress,
      isETHOut: isEthOut,
    };

    let currentGroupId = 0;
    for (const [swapIndex, swap] of route.swaps.entries()) {
      const parentGroupId = currentGroupId++;
      swapRoute.parentGroups.push({ id: parentGroupId, percent: swap.percent });

      for (const [subswapIndex, subswap] of swap.subswaps.entries()) {
        const groupId = currentGroupId++;
        for (const [pathIndex, path] of subswap.paths.entries()) {
          const dexName = toCorrectDexName(path.exchange);
          
          const step: SwapStep = {
            dex: dexName,
            path: [
              route.paths[swapIndex][subswapIndex].address,
              route.paths[swapIndex][subswapIndex + 1]?.address || route.paths[swapIndex][subswapIndex].address,
            ],
            percent: path.percent,
            pool: path.address,
            userData: "0x",
            groupId: groupId,
            parentGroupId: pathIndex === 0 && subswapIndex === 0 ? parentGroupId : groupId - 1,
          };

          swapRoute.steps.push(step);
        }
      }
    }
    swapRoute.groupCount = currentGroupId;

    return {
      calldata: encodeSwapRoute(swapRoute),
      tokenInAdress: params.tokenInAddress,
      tokenOutAddress: params.tokenOutAddress,
      outputAmount: outputAmount,
      gasAmountEstimated: gasEstimate.gasAmount,
      gasUSDEstimated: gasEstimate.gasUSD,
      route: combineRoute(route)
    };
  }

  private async calculateRouteOutput(route: Route, amountIn: string): Promise<string | null> {
    try {
      let currentAmount = amountIn;
      
      for (const [swapIndex, swap] of route.swaps.entries()) {
        for (const [subswapIndex, subswap] of swap.subswaps.entries()) {
          for (const [pathIndex, path] of subswap.paths.entries()) {
            const tokenIn = route.paths[swapIndex][subswapIndex].address;
            const tokenOut = route.paths[swapIndex][subswapIndex + 1]?.address;
            
            if (!tokenOut) continue;
            
            const pathAmount = await this.getAmountOut(tokenIn, tokenOut, currentAmount, route);
            if (!pathAmount) {
              this.logger.error("Failed to get amount out for path", { tokenIn, tokenOut, currentAmount });
              return null;
            }
            
            // Apply the percentage for this path
            const pathPercent = path.percent / 100000; // Convert from basis points
            currentAmount = (BigInt(pathAmount) * BigInt(Math.floor(pathPercent * 100000)) / BigInt(100000)).toString();
          }
        }
      }
      
      return currentAmount;
    } catch (error) {
      this.logger.error("Error calculating route output", { error });
      return null;
    }
  }

  private async estimateGas(route: Route, params: QuoteParams): Promise<{ gasAmount: number; gasUSD: number }> {
    try {
      // Base gas for swap operations
      let baseGas = 150000; // Base gas for a simple swap
      
      // Add gas for each step in the route
      const stepGas = 50000; // Additional gas per step
      const totalSteps = route.swaps.reduce((total, swap) => 
        total + swap.subswaps.reduce((subTotal, subswap) => subTotal + subswap.paths.length, 0), 0
      );
      
      const estimatedGas = baseGas + (totalSteps * stepGas);
      
      // Get current gas price
      const feeData = await this.provider.getFeeData();
      const gasPrice = feeData.gasPrice || BigInt(1000000000); // 1 gwei default
      
      // Calculate gas cost in wei
      const gasCostWei = BigInt(estimatedGas) * gasPrice;
      
      // Convert to USD (simplified - you might want to get actual PLS price)
      const gasCostPLS = Number(ethers.formatEther(gasCostWei));
      const plsPriceUSD = 0.0001; // Placeholder PLS price in USD
      const gasCostUSD = gasCostPLS * plsPriceUSD;
      
      return {
        gasAmount: estimatedGas,
        gasUSD: gasCostUSD
      };
    } catch (error) {
      this.logger.error("Error estimating gas", { error });
      // Return fallback values
      return {
        gasAmount: 200000,
        gasUSD: 0.1
      };
    }
  }

}
