import { SwapRoute } from "../types/swapmanager";
import { Route, CombinedRoute } from "../types/Quote";
import { AbiCoder, ParamType } from "ethers";
import { ethers } from "ethers";

export const toCorrectDexName = (dex: string) => {
  if (!dex) return '';
  if (dex === "PulseX V1") return "pulsexV1";
  if (dex === "PulseX V2") return "pulsexV2";
  if (dex === "9inch V2") return "9inchV2";
  if (dex === "9inch V3") return "9inchV3";
  if (dex === "9mm V3") return "9mmV3";
  if (dex === "9mm V2") return "9mmV2";
  if (dex === "Phux") return "phux";
  if (dex === "PulseX Stable") return "pulsexStable";
  if (dex === "pDex V3") return "pDexV3";
  if (dex.toLowerCase().includes("dextop")) return "dexTop";
  if (dex.toLowerCase().includes("tide")) return "tide";
  return "";
};


// ABI for encoding/decoding
const SWAP_ROUTE_ABI = [
  ParamType.from({
      name: 'SwapRoute',
      type: 'tuple',
      components: [
          {
              name: 'steps',
              type: 'tuple[]',
              components: [
                  { name: 'dex', type: 'string' },
                  { name: 'path', type: 'address[]' },
                  { name: 'pool', type: 'address' },
                  { name: 'percent', type: 'uint256' },
                  { name: 'groupId', type: 'uint256' },
                  { name: 'parentGroupId', type: 'uint256' },
                  { name: 'userData', type: 'bytes' }
              ]
          },
          {
              name: 'parentGroups',
              type: 'tuple[]',
              components: [
                  { name: 'id', type: 'uint256' },
                  { name: 'percent', type: 'uint256' }
              ]
          },
          { name: 'destination', type: 'address' },
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'groupCount', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMin', type: 'uint256' }
      ]
  })
];

export function encodeSwapRoute(route: SwapRoute): string {
  // Encode the route using ethers.js
  const abiCoder = new AbiCoder();
  return abiCoder.encode(SWAP_ROUTE_ABI, [route]);
}

export function combineRoute(route: Route): CombinedRoute {
  return route.swaps.map((swap, swapIdx) => ({
      percent: swap.percent / 1000,
      subroutes: swap.subswaps.map((subswap, subswapIdx) => ({
        percent: subswap.percent / 1000,
        paths: subswap.paths.map((path, pathIdx) => {
          // Get the tokens for this path from the corresponding paths array
          const pathArr = route?.paths?.[swapIdx];
          const tokens =
            Array.isArray(pathArr) &&
            subswapIdx >= 0 &&
            subswapIdx + 1 < pathArr.length &&
            pathArr[subswapIdx] &&
            pathArr[subswapIdx + 1]
              ? [pathArr[subswapIdx], pathArr[subswapIdx + 1]]
              : [];
          // Remove "address" field
          const { address, percent, ...rest } = path;
          return {
            ...rest,
            percent: percent / 1000,
            tokens,
          };
        }),
      })),
    }));
}

// Token utility functions
// ERC20 ABI for getting token decimals
const ERC20_ABI = [
  'function decimals() view returns (uint8)'
];

// Provider instance for token contract calls
let provider: ethers.JsonRpcProvider | null = null;

/**
 * Get the provider instance, creating it if it doesn't exist
 */
function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.pulsechain.com');
  }
  return provider;
}

/**
 * Get token decimals from contract
 */
export async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    // Handle ETH case (0x0 address)
    if (tokenAddress === '0x0000000000000000000000000000000000000000' || 
        tokenAddress === '0x0' || 
        tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000') {
      return 18; // ETH has 18 decimals
    }

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());
    const decimals = await tokenContract.decimals();
    return Number(decimals);
  } catch (error) {
    console.error(`Error getting decimals for token ${tokenAddress}:`, error);
    // Default to 18 decimals if we can't get the actual decimals
    return 18;
  }
}

/**
 * Format token amount using proper decimals
 */
export async function formatTokenAmount(amount: string, tokenAddress: string): Promise<string> {
  try {
    const decimals = await getTokenDecimals(tokenAddress);
    const formattedAmount = ethers.formatUnits(amount, decimals);
    return formattedAmount;
  } catch (error) {
    console.error(`Error formatting amount ${amount} for token ${tokenAddress}:`, error);
    // Return original amount if formatting fails
    return amount;
  }
}