import { ethers } from "ethers";
import config from "../config";

const ABI_POOL = [
  // coins
  "function coins(uint256) view returns (address)",
  // two common get_dy variants used by Curve-style stables
  "function get_dy(uint256,uint256,uint256) view returns (uint256)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
];

// TTL for stable 3‑pool index cache (default 10m; override with STABLE_INDEX_TTL_MS)
const STABLE_INDEX_TTL_MS = Number(process.env.STABLE_INDEX_TTL_MS ?? 600_000);

type IndexCache = {
  byAddr: Map<string, number>;
  addrs: string[];
};

export class StableThreePoolQuoter {
  private provider: ethers.JsonRpcProvider;
  private pool: ethers.Contract; // <-- must be a Contract, not string
  private idx: IndexCache = { byAddr: new Map(), addrs: [] };
  private idxFetchedAt = 0; // unix ms timestamp when `idx` was built

  // memoize quotes: key = `${i}-${j}-${amount}`
  private cache = new Map<string, Promise<bigint>>();

  constructor(provider: ethers.JsonRpcProvider, poolAddr?: string) {
    this.provider = provider;
    const addr = poolAddr || config.PulsexStablePoolAddress;
    if (!addr) throw new Error("Stable pool address missing (PulsexStablePoolAddress)");
    this.pool = new ethers.Contract(addr, ABI_POOL, this.provider);
  }

  private async ensureCoins(force = false): Promise<void> {
    // Respect TTL
    const now = Date.now();
    if (!force && this.idx.addrs.length && (now - this.idxFetchedAt) < STABLE_INDEX_TTL_MS) {
      return;
    }

    try {
      const coins = await Promise.all([0, 1, 2].map((i) => this.pool.coins(i)));
      const addrs = coins.map((a: string) => ethers.getAddress(a));
      const byAddr = new Map<string, number>(addrs.map((a, i) => [a.toLowerCase(), i]));
      this.idx = { addrs, byAddr };
      this.idxFetchedAt = now;
    } catch (e) {
      // If discovery fails, drop cache so next attempt retries cleanly
      this.invalidateIndex();
      throw e;
    }
  }


  private async tokenIndex(addr: string): Promise<number> {
    await this.ensureCoins();
    const i = this.idx.byAddr.get(addr.toLowerCase());
    return i ?? -1;
  }

  private async callGetDy(i: number, j: number, dx: bigint): Promise<bigint> {
    // try uint256 variant first, then int128
    try {
      const y: bigint = await this.pool["get_dy(uint256,uint256,uint256)"](i, j, dx);
      return y;
    } catch {
      const y: bigint = await this.pool["get_dy(int128,int128,uint256)"](i, j, dx);
      return y;
    }
  }

  /**
   * Quote tokenIn -> tokenOut through the 3-coin stable pool.
   * Returns 0n if either token is not in the pool or identical.
   * dx is in tokenIn's base units; the return is in tokenOut's base units.
   */
  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> {
    try {
      const i = await this.tokenIndex(tokenIn);
      const j = await this.tokenIndex(tokenOut);
      if (i < 0 || j < 0 || i === j) return 0n;

      const key = `${i}-${j}-${amountIn.toString()}`;
      const hit = this.cache.get(key);
      if (hit) return hit;

      const p = this.callGetDy(i, j, amountIn).catch((err) => {
        // Pool might have changed — drop index so next request re-discovers coins
        this.invalidateIndex();
        return 0n;
      });
      this.cache.set(key, p);
      return p;
    } catch {
      return 0n;
    }
  }

  private invalidateIndex() {
    this.idx = { byAddr: new Map(), addrs: [] };
    this.idxFetchedAt = 0;
  }
}
