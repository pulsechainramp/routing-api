import { Contract, type Provider } from 'ethers';
import PulseXStableSwapPoolAbi from '../abis/PulseXStableSwapPool.json';
import { MAX_STABLE_COINS, STABLE_INDEX_TTL_MS } from '../config/pulsex';
import type { Address } from '../types/pulsex';

type StablePoolContract = Contract & {
  coins(index: number): Promise<string>;
  ['get_dy(int128,int128,uint256)'](i: bigint, j: bigint, amount: bigint): Promise<bigint>;
  ['get_dy(uint256,uint256,uint256)'](i: bigint, j: bigint, amount: bigint): Promise<bigint>;
};

interface IndexCache {
  expiresAt: number;
  map: Map<string, number>;
}

export class StableThreePoolQuoter {
  private readonly contract: StablePoolContract;
  private indexCache?: IndexCache;

  constructor(provider: Provider, poolAddress: Address) {
    this.contract = new Contract(
      poolAddress,
      PulseXStableSwapPoolAbi,
      provider,
    ) as StablePoolContract;
  }

  public async quoteStableOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    if (amountIn < 0n) {
      throw new Error('amountIn must be non-negative');
    }

    const indexMap = await this.loadIndexMap();
    const tokenInIndex = indexMap.get(tokenIn.toLowerCase());
    if (tokenInIndex === undefined) {
      throw new Error(`Token ${tokenIn} is not supported by the stable pool`);
    }

    const tokenOutIndex = indexMap.get(tokenOut.toLowerCase());
    if (tokenOutIndex === undefined) {
      throw new Error(`Token ${tokenOut} is not supported by the stable pool`);
    }

    if (amountIn === 0n) {
      return 0n;
    }

    if (tokenInIndex === tokenOutIndex) {
      return amountIn;
    }

    return this.callGetDy(tokenInIndex, tokenOutIndex, amountIn);
  }

  private async loadIndexMap(): Promise<Map<string, number>> {
    if (this.indexCache && this.indexCache.expiresAt > Date.now()) {
      return this.indexCache.map;
    }

    const map = new Map<string, number>();
    let lastError: unknown;
    for (let index = 0; index < MAX_STABLE_COINS; index += 1) {
      try {
        const coinAddress = await this.contract.coins(index);
        map.set(coinAddress.toLowerCase(), index);
      } catch (error) {
        lastError = error;
        break;
      }
    }

    if (map.size !== MAX_STABLE_COINS) {
      if (this.indexCache?.map) {
        return this.indexCache.map;
      }
      const message =
        lastError instanceof Error
          ? lastError.message
          : lastError !== undefined
          ? String(lastError)
          : 'unknown error';
      throw new Error(`Failed to load stable pool coins: ${message}`);
    }

    this.indexCache = {
      expiresAt: Date.now() + STABLE_INDEX_TTL_MS,
      map,
    };

    return map;
  }

  private async callGetDy(tokenInIndex: number, tokenOutIndex: number, amountIn: bigint): Promise<bigint> {
    const i = BigInt(tokenInIndex);
    const j = BigInt(tokenOutIndex);

    try {
      return await this.contract['get_dy(int128,int128,uint256)'](i, j, amountIn);
    } catch (firstError) {
      try {
        return await this.contract['get_dy(uint256,uint256,uint256)'](i, j, amountIn);
      } catch (secondError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(`Stable pool quote failed: ${firstMessage}; ${secondMessage}`);
      }
    }
  }
}
