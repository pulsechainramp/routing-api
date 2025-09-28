import { ethers } from "ethers";
import config from "../config";
import { Group, SwapRoute, SwapStep } from "../types/swapmanager";
import { PathToken, CombinedRoute } from "../types/Quote";
import { encodeSwapRoute } from "../utils/web3";
import { StableThreePoolQuoter } from "./StableThreePoolQuoter";

// ---------- ABIs ----------
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)",
];
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

type Dex = "pulsexV1" | "pulsexV2";
type QuoteFn = (amountIn: bigint) => Promise<bigint>;

type TryOut = {
  id: string;                 // label key
  label: string;              // for UI
  dexPath: ("pulsexV1"|"pulsexV2"|"stable+v1"|"stable+v2");
  tokens: string[];           // path tokens for UI (2 or 3)
  out: QuoteFn;               // quote for any input
};

type SplitChoice = {
  totalOut: bigint;
  wA_bps: number;             // weight to routeA in bps (0..10000)
  routeA: TryOut;
  routeB?: TryOut;            // undefined => single route
};

const DECIMALS: Record<string, number> = {
  [String(config.WPLS ?? "").toLowerCase()]: 18,
  [String(config.USDC ?? "").toLowerCase()]: 6,
  [String(config.USDT ?? "").toLowerCase()]: 6,
  [String(config.DAI  ?? "").toLowerCase()]: 18,
};

// ---- Tunables (env overrides) ----
const DEADLINE_MS = Number(process.env.FALLBACK_DEADLINE_MS ?? 7500);
const TOPK = Number(process.env.FALLBACK_TOPK ?? 3);
const TERNARY_ITERS = Number(process.env.FALLBACK_TERNARY_ITERS ?? 6);
const CONCURRENCY = Number(process.env.FALLBACK_CONCURRENCY ?? 6);
const RESERVES_TTL_MS = Number(process.env.FALLBACK_RESERVES_TTL_MS ?? 10_000);

const FEE_V1_BPS = Number(process.env.PULSEX_V1_FEE_BPS ?? 29); // 0.29%
const FEE_V2_BPS = Number(process.env.PULSEX_V2_FEE_BPS ?? 29); // 0.29%

export class FallbackQuoterService {
  private provider: ethers.JsonRpcProvider;
  private stable: StableThreePoolQuoter;

  private factories: Record<Dex, ethers.Contract>;
  private feeBps: Record<Dex, number>;

  // pair address & reserves cache
  private pairAddrCache: Map<string, string> = new Map(); // key: `${dex}:${a}:${b}`
  private reservesCache: Map<string, { t: number, rIn: bigint, rOut: bigint }> = new Map(); // key `${dex}:${a}:${b}`

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://rpc.pulsechain.com");
    this.factories = {
      pulsexV1: new ethers.Contract(config.PulsexV1FactoryAddress, FACTORY_ABI, this.provider),
      pulsexV2: new ethers.Contract(config.PulsexV2FactoryAddress, FACTORY_ABI, this.provider),
    };
    this.feeBps = { pulsexV1: FEE_V1_BPS, pulsexV2: FEE_V2_BPS };
    this.stable = new StableThreePoolQuoter(this.provider, config.PulsexStablePoolAddress);
  }

  // ---------- public API ----------
  async quoteBestExactIn(
    tokenIn: string,
    tokenOut: string,
    amountInWei: bigint,
    tokenInMeta: PathToken,
    tokenOutMeta: PathToken
  ) {
    const isUSDCtoWPLS = eq(tokenIn, config.USDC) && eq(tokenOut, config.WPLS);
    const isWPLStoUSDC = eq(tokenIn, config.WPLS) && eq(tokenOut, config.USDC);

    // We optimized USDC <-> WPLS. For anything else fallback to simple direct best of V1/V2
    // (now extended to also try 2-hop via common connectors).
    if (!isUSDCtoWPLS && !isWPLStoUSDC) {
      return this.simpleBestExactIn(tokenIn, tokenOut, amountInWei, tokenInMeta, tokenOutMeta);
    }

    const start = Date.now();
    const deadline = () => Date.now() - start > DEADLINE_MS;

    // ---- build candidate legs ----
    const candidates: TryOut[] = [];

    // direct legs (USDC -> WPLS)
    for (const dex of ["pulsexV1","pulsexV2"] as const) {
      const fn: QuoteFn = async (amt) => this.localDexQuote(dex, tokenIn, tokenOut, amt);
      candidates.push({
        id: `${dex}-direct`,
        label: dex === "pulsexV1" ? "PulseX V1" : "PulseX V2",
        dexPath: dex,
        tokens: [tokenIn, tokenOut],
        out: fn,
      });
    }

    // stable legs: USDC -> {USDT,DAI} (stable) -> WPLS via V1/V2
    const stables = [req(config.USDT, "USDT"), req(config.DAI, "DAI")];
    for (const mid of stables) {
      for (const dex of ["pulsexV1","pulsexV2"] as const) {
        const fn: QuoteFn = async (amt) => {
          const midOut = await this.stable.quote(tokenIn, mid, amt);      // USDC -> {USDT|DAI}
          if (midOut === 0n) return 0n;
          return this.localDexQuote(dex, mid, tokenOut, midOut);          // {USDT|DAI} -> WPLS
        };
        candidates.push({
          id: `stable-${sym(mid)}-${dex}`,
          label: dex === "pulsexV1" ? "PulseX Stable + PulseX V1" : "PulseX Stable + PulseX V2",
          dexPath: dex === "pulsexV1" ? "stable+v1" : "stable+v2",
          tokens: [tokenIn, mid, tokenOut],
          out: fn,
        });
      }
    }

    // ---- single best (parallel) ----
    const singleList = await Promise.all(
      candidates.map(async (c) => ({ c, y: await c.out(amountInWei) }))
    );
    singleList.sort((a,b) => (a.y === b.y ? 0 : (a.y < b.y ? 1 : -1)));
    const singleBest = singleList[0];

    if (deadline()) {
      return this.finish([{ leg: singleBest.c, bps: 10_000 }], singleBest.y, tokenIn, tokenOut, amountInWei, tokenInMeta, tokenOutMeta);
    }

    // ---- pairwise splits among top-K singles ----
    const top = singleList.slice(0, Math.min(TOPK, singleList.length)).map(x => x.c);
    let bestTotal = singleBest.y;
    let bestLegs: { leg: TryOut, bps: number }[] = [{ leg: singleBest.c, bps: 10_000 }];

    const pairPromises: Promise<void>[] = [];
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const A = top[i], B = top[j];
        pairPromises.push(this.bestPairTernary(A, B, amountInWei, deadline).then(res => {
          if (res.totalOut > bestTotal) {
            bestTotal = res.totalOut;
            bestLegs = [
              { leg: res.routeA, bps: res.wA_bps },
              { leg: res.routeB!, bps: 10_000 - res.wA_bps },
            ];
          }
        }).catch(() => {}));
        if (pairPromises.length >= CONCURRENCY) {
          await Promise.race(pairPromises);
          // remove settled
          for (let k = pairPromises.length - 1; k >= 0; k--) {
            if ((pairPromises[k] as any).settled) pairPromises.splice(k,1);
          }
        }
      }
    }
    await Promise.allSettled(pairPromises);

    return this.finish(bestLegs, bestTotal, tokenIn, tokenOut, amountInWei, tokenInMeta, tokenOutMeta);
  }

  // ---------- single best (direct V1/V2 + minimal 2‑hop via connectors) ----------
  private async simpleBestExactIn(
    tokenIn: string,
    tokenOut: string,
    amountInWei: bigint,
    tokenInMeta: PathToken,
    tokenOutMeta: PathToken
  ) {
    const legs: TryOut[] = [];

    // (a) direct on V1/V2
    for (const dex of ["pulsexV1","pulsexV2"] as const) {
      legs.push({
        id: `${dex}-direct`,
        label: dex === "pulsexV1" ? "PulseX V1" : "PulseX V2",
        dexPath: dex,
        tokens: [tokenIn, tokenOut],
        out: (amt: bigint) => this.localDexQuote(dex, tokenIn, tokenOut, amt),
      });
    }

    // (b) 2‑hop via common connectors (WPLS/USDC/USDT/DAI)
    const connectors = [config.WPLS, config.USDC, config.USDT, config.DAI]
      .filter((a): a is string => typeof a === "string" && a.length > 0);

    for (const mid of connectors) {
      if (eq(mid, tokenIn) || eq(mid, tokenOut)) continue;
      for (const dex of ["pulsexV1","pulsexV2"] as const) {
        const fn: QuoteFn = async (amt) => {
          const midOut = await this.localDexQuote(dex, tokenIn, mid, amt); // tokenIn -> mid
          if (midOut === 0n) return 0n;
          return this.localDexQuote(dex, mid, tokenOut, midOut);          // mid -> tokenOut
        };
        legs.push({
          id: `${dex}-via-${sym(mid)}`,
          label: dex === "pulsexV1" ? `PulseX V1 (via ${sym(mid)})` : `PulseX V2 (via ${sym(mid)})`,
          dexPath: dex,
          tokens: [tokenIn, mid, tokenOut],
          out: fn,
        });
      }
    }

    const outs = await Promise.all(legs.map(async c => ({ c, y: await c.out(amountInWei) })));
    outs.sort((a,b) => (a.y === b.y ? 0 : (a.y < b.y ? 1 : -1)));
    const best = outs[0];

    return this.finish([{ leg: best.c, bps: 10_000 }], best.y, tokenIn, tokenOut, amountInWei, tokenInMeta, tokenOutMeta);
  }

  // ---------- pairwise ternary search ----------
  private async bestPairTernary(A: TryOut, B: TryOut, x: bigint, isDeadline: () => boolean): Promise<SplitChoice> {
    let lo = 0, hi = 10_000; // bps
    let bestY = 0n, bestW = 10_000;

    for (let it = 0; it < TERNARY_ITERS; it++) {
      if (isDeadline()) break;
      const m1 = Math.floor((2*lo + hi) / 3);
      const m2 = Math.floor((lo + 2*hi) / 3);

      const [y1, y2] = await Promise.all([m1, m2].map(async (w) => {
        const aIn = (x * BigInt(w)) / 10_000n;
        const bIn = x - aIn;
        const [ya, yb] = await Promise.all([A.out(aIn), B.out(bIn)]);
        return ya + yb;
      }));

      if (y1 <= y2) {
        lo = m1;
        if (y2 > bestY) { bestY = y2; bestW = m2; }
      } else {
        hi = m2;
        if (y1 > bestY) { bestY = y1; bestW = m1; }
      }
    }
    return { totalOut: bestY, wA_bps: bestW, routeA: A, routeB: B };
  }

  // ---------- finish: encode route + UI ----------
  private finish(
    legs: { leg: TryOut, bps: number }[],
    totalOut: bigint,
    tokenIn: string,
    tokenOut: string,
    amountInWei: bigint,
    tokenInMeta: PathToken,
    tokenOutMeta: PathToken
  ) {
    const steps: SwapStep[] = [];
    const combined: CombinedRoute = [{ percent: 100, subroutes: [] }];

    const mkTokens = (addrPath: string[]): PathToken[] => {
      const arr: PathToken[] = [];
      for (let i = 0; i < addrPath.length; i++) {
        if (i === 0) arr.push(tokenInMeta);
        else if (i === addrPath.length - 1) arr.push(tokenOutMeta);
        else {
          const a = addrPath[i];
          const d = DECIMALS[a.toLowerCase()] ?? 18;
          arr.push({ address: a, symbol: "", decimals: d, chainId: tokenInMeta.chainId });
        }
      }
      return arr;
    };

    let groupId = 1;
    for (const { leg, bps } of legs) {
      steps.push({
        dex: leg.dexPath.includes("v1") ? "pulsexV1" : "pulsexV2",
        path: leg.tokens.length === 2 ? leg.tokens : [leg.tokens[1], leg.tokens[2]], // encode the AMM hop part
        pool: ethers.ZeroAddress,
        percent: bps,        // UI divides by 1,000
        groupId,
        parentGroupId: 0,
        userData: "0x",
      });

      combined[0].subroutes.push({
        percent: Math.round(bps / 1000),
        paths: [{
          percent: 100,
          exchange: leg.label,
          tokens: mkTokens(leg.tokens),
        }],
      });
      groupId++;
    }

    const swapRoute: SwapRoute = {
      steps,
      parentGroups: [{ id: 0, percent: 100_000 } as Group],
      destination: ethers.ZeroAddress,
      tokenIn,
      tokenOut,
      groupCount: steps.length + 1,
      deadline: Math.floor(Date.now() / 1000 + 60 * 10),
      amountIn: amountInWei.toString(),
      amountOutMin: totalOut.toString(),
    };
    const routeBytes = encodeSwapRoute(swapRoute);

    return {
      success: true,
      destAmount: totalOut,
      routeBytes,
      combinedRoute: combined,
      gasAmountEstimated: 0,
      gasUSDEstimated: 0,
    };
  }

  // ---------- local CPMM math for V1/V2 ----------
  private async localDexQuote(dex: Dex, a: string, b: string, amountIn: bigint): Promise<bigint> {
    if (amountIn === 0n) return 0n;
    const [rIn, rOut] = await this.getReservesOrdered(dex, a, b);
    if (rIn === 0n || rOut === 0n) return 0n;
    const feeBps = this.feeBps[dex];
    const feeFactor = 10_000n - BigInt(feeBps);
    const amountInWithFee = amountIn * feeFactor;
    const numerator   = amountInWithFee * rOut;
    const denominator = rIn * 10_000n + amountInWithFee;
    return numerator / denominator;
  }

  private async getReservesOrdered(dex: Dex, a: string, b: string): Promise<[bigint,bigint]> {
    const key = `${dex}:${a.toLowerCase()}:${b.toLowerCase()}`;
    const now = Date.now();

    const hit = this.reservesCache.get(key);
    if (hit && (now - hit.t) < RESERVES_TTL_MS) return [hit.rIn, hit.rOut];

    const pair = await this.getPairAddress(dex, a, b);
    if (!pair || pair === ethers.ZeroAddress) { return [0n, 0n]; }

    const c = new ethers.Contract(pair, PAIR_ABI, this.provider);
    const [token0, reserves] = await Promise.all([c.token0().catch(() => ethers.ZeroAddress), c.getReserves().catch(() => null)]);
    if (!reserves || token0 === ethers.ZeroAddress) { return [0n, 0n]; }
    const a0 = token0.toLowerCase() === a.toLowerCase();

    const r0 = BigInt(reserves[0]);
    const r1 = BigInt(reserves[1]);
    const rIn  = a0 ? r0 : r1;
    const rOut = a0 ? r1 : r0;

    this.reservesCache.set(key, { t: now, rIn, rOut });
    return [rIn, rOut];
  }

  private async getPairAddress(dex: Dex, a: string, b: string): Promise<string> {
    const A = a.toLowerCase(), B = b.toLowerCase();
    const key = `${dex}:${A}:${B}`;
    const cached = this.pairAddrCache.get(key);
    if (cached) return cached;
    const pair = await this.factories[dex].getPair(a, b).catch(() => ethers.ZeroAddress);
    this.pairAddrCache.set(key, pair);
    return pair;
  }
}

// ---------- helpers ----------
function eq(a?: string, b?: string) {
  return a && b && a.toLowerCase() === b.toLowerCase();
}
function req<T>(v: T|undefined|null, name: string): T {
  if (v == null) throw new Error(`Missing config for ${name}`);
  return v;
}
function sym(a: string) {
  const s = a.toLowerCase();
  if (s === String(config.USDC).toLowerCase()) return "USDC";
  if (s === String(config.USDT).toLowerCase()) return "USDT";
  if (s === String(config.DAI ).toLowerCase()) return "DAI";
  if (s === String(config.WPLS).toLowerCase()) return "WPLS";
  return s.slice(0,6);
}
