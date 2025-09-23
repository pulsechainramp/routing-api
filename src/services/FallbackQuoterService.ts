import { ethers } from 'ethers';
import config from '../config';
import { Group, SwapRoute, SwapStep } from '../types/swapmanager';
import { PathToken, CombinedRoute } from '../types/Quote';
import { encodeSwapRoute } from '../utils/web3';

const ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)'
];

type FallbackQuote = {
  success: boolean;
  destAmount: bigint;
  routeBytes: string;
  combinedRoute: CombinedRoute;
  gasAmountEstimated: number;
  gasUSDEstimated: number;
};

type RouterDex = 'pulsexV1' | 'pulsexV2';
type RouterSpec = { dex: RouterDex; address: string };

/**
 * Simple V2-style fallback using only PulseX v1/v2 routers.
 * Extendable later for other trusted V2 routers.
 */
export class FallbackQuoterService {
  private provider: ethers.JsonRpcProvider;
  private routers: Array<{ dex: 'pulsexV2' | 'pulsexV1'; address: string }>;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.pulsechain.com');
    this.routers = ([
        { dex: 'pulsexV2' as const, address: config.PulsexV2RouterAddress },
        { dex: 'pulsexV1' as const, address: config.PulsexV1RouterAddress },
    ] as const).filter(r => r.address && r.address !== ethers.ZeroAddress) as RouterSpec[];
  }

  /**
   * Try: direct [in->out], [in->WPLS->out], [in->USDC->out], [in->DAI->out]
   */
  async quoteBestExactIn(
    tokenIn: string,
    tokenOut: string,
    amountInWei: bigint,
    tokenInMeta: PathToken,
    tokenOutMeta: PathToken,
  ): Promise<FallbackQuote> {
    if (!this.routers.length) return { success: false, destAmount: 0n, routeBytes: '0x', combinedRoute: [], gasAmountEstimated: 0, gasUSDEstimated: 0 };

    const connectors = [config.WPLS, config.USDC, config.DAI].filter(
        (addr): addr is string => !!addr && addr !== ethers.ZeroAddress
    );
    const candidatePaths: string[][] = [
      [tokenIn, tokenOut],
      ...connectors.map(c => [tokenIn, c, tokenOut]),
    ];

    const enableThreeHop =
    (process.env.FALLBACK_ENABLE_THREE_HOP ?? 'false').toLowerCase() === 'true';

    if (enableThreeHop) {
        const W = config.WPLS;
        const stables = [config.USDC, config.DAI].filter(
            (s): s is string => !!s && s !== ethers.ZeroAddress
        );

        if (W && W !== ethers.ZeroAddress && stables.length) {
            for (const S of stables) {
            // in -> WPLS -> S -> out
            const p1 = [tokenIn, W, S, tokenOut];
            // in -> S -> WPLS -> out
            const p2 = [tokenIn, S, W, tokenOut];

            // avoid degenerate loops / duplicates
            if (new Set(p1).size === p1.length) candidatePaths.push(p1);
            if (new Set(p2).size === p2.length) candidatePaths.push(p2);
            }
        }
    }

    let best: { dex: 'pulsexV2' | 'pulsexV1'; path: string[]; out: bigint } | null = null;

    for (const r of this.routers) {
      const router = new ethers.Contract(r.address, ROUTER_ABI, this.provider);
      for (const p of candidatePaths) {
        if (new Set(p).size !== p.length) continue; // skip degenerate loops
        try {
          const amounts: bigint[] = await router.getAmountsOut(amountInWei, p);
          const out = amounts[amounts.length - 1];
          if (!best || out > best.out) best = { dex: r.dex, path: p, out };
        } catch {
          // ignore paths that don't exist
        }
      }
    }
    if (!best) return { success: false, destAmount: 0n, routeBytes: '0x', combinedRoute: [], gasAmountEstimated: 0, gasUSDEstimated: 0 };

    // Build a single-step SwapRoute compatible with your encoder
    const step: SwapStep = {
      dex: best.dex,
      path: best.path,
      pool: ethers.ZeroAddress, // optional: resolve pairs if you want, not required by encoder
      percent: 100_000,         // 100.000% (since combineRoute divides by 1000)
      groupId: 1,
      parentGroupId: 0,
      userData: '0x',
    };

    const swapRoute: SwapRoute = {
      steps: [step],
      parentGroups: [{ id: 0, percent: 100_000 } as Group],
      destination: ethers.ZeroAddress,
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      groupCount: 2,
      deadline: Math.floor(Date.now() / 1000 + 60 * 10),
      amountIn: amountInWei.toString(),
      amountOutMin: best.out.toString(), // UI can still apply slippage tolerance
    };

    // Encode with your existing helper
    const routeBytes = encodeSwapRoute(swapRoute);

    // Minimal "combinedRoute" for your debug/UI panel
    const combinedRoute: CombinedRoute = [{
      percent: 100,
      subroutes: [{
        percent: 100,
        paths: [{
          percent: 100,
          exchange: best.dex === 'pulsexV2' ? 'PulseX V2' : 'PulseX V1',
          tokens: this.pathToTokens(best.path, tokenInMeta, tokenOutMeta),
        }]
      }]
    }];

    return {
      success: true,
      destAmount: best.out,
      routeBytes,
      combinedRoute,
      gasAmountEstimated: 0,
      gasUSDEstimated: 0,
    };
  }

  private pathToTokens(path: string[], inMeta: PathToken, outMeta: PathToken): PathToken[] {
    // We only know edge tokens; for connectors we only fill addresses/decimals=18
    const tokens: PathToken[] = [];
    for (let i = 0; i < path.length; i++) {
      const addr = path[i];
      if (i === 0) tokens.push(inMeta);
      else if (i === path.length - 1) tokens.push(outMeta);
      else tokens.push({ address: addr, symbol: '', decimals: 18, chainId: inMeta.chainId });
    }
    return tokens;
  }
}
