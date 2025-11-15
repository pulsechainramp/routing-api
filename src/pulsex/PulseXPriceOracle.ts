import { Contract, formatUnits, type Provider } from 'ethers';
import PulsexFactoryAbi from '../abis/PulsexFactory.json';
import type { PulsexConfig } from '../config/pulsex';
import type { PulsexToken } from '../types/pulsex';

const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface PriceCacheEntry {
  value: number;
  expiresAt: number;
}

export class PulseXPriceOracle {
  private cache?: PriceCacheEntry;

  private readonly wplsToken: PulsexToken;
  private readonly usdcToken: PulsexToken;

  private readonly factoryPriority: Contract[];

  constructor(
    private readonly provider: Provider,
    private readonly config: PulsexConfig,
  ) {
    const wplsToken =
      config.connectorTokens.find((token) => token.isNative) ?? null;
    if (!wplsToken) {
      throw new Error('Missing WPLS metadata in PulsexConfig');
    }
    const usdcToken = config.usdStableToken ?? null;
    if (!usdcToken) {
      throw new Error('Missing USDC metadata in PulsexConfig');
    }

    this.wplsToken = wplsToken;
    this.usdcToken = usdcToken;

    this.factoryPriority = [
      new Contract(config.factories.v2, PulsexFactoryAbi, provider),
      new Contract(config.factories.v1, PulsexFactoryAbi, provider),
    ];
  }

  public clearCache(): void {
    this.cache = undefined;
  }

  public async getPlsPriceUsd(): Promise<number> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const price = await this.loadPrice();
    this.cache = {
      value: price,
      expiresAt: Date.now() + this.config.priceOracle.cacheTtlMs,
    };
    return price;
  }

  private async loadPrice(): Promise<number> {
    for (const factory of this.factoryPriority) {
      const price = await this.tryFactory(factory);
      if (price) {
        return price;
      }
    }

    throw new Error('Unable to determine WPLS/USDC price from PulseX pairs');
  }

  private async tryFactory(factory: Contract): Promise<number | null> {
    let pairAddress: string;
    try {
      pairAddress = await factory.getPair(
        this.wplsToken.address,
        this.usdcToken.address,
      );
    } catch (error) {
      return null;
    }

    if (!pairAddress || this.isZeroAddress(pairAddress)) {
      return null;
    }

    const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
    const token0 = (await pairContract.token0()) as string;
    const token1 = (await pairContract.token1()) as string;
    const [reserve0, reserve1] = await pairContract.getReserves();

    const { reserveWpls, reserveUsdc } = this.mapReserves(
      token0,
      token1,
      reserve0,
      reserve1,
    );

    if (reserveWpls === 0n || reserveUsdc === 0n) {
      return null;
    }

    const wplsFloat = Number(
      formatUnits(reserveWpls, this.wplsToken.decimals ?? 18),
    );
    const usdcFloat = Number(
      formatUnits(reserveUsdc, this.usdcToken.decimals ?? 6),
    );

    if (!Number.isFinite(wplsFloat) || wplsFloat === 0) {
      return null;
    }

    return usdcFloat / wplsFloat;
  }

  private mapReserves(
    token0: string,
    token1: string,
    reserve0: bigint | number,
    reserve1: bigint | number,
  ): { reserveWpls: bigint; reserveUsdc: bigint } {
    const normalizedToken0 = token0.toLowerCase();
    const normalizedToken1 = token1.toLowerCase();
    const wplsAddress = this.wplsToken.address.toLowerCase();
    const usdcAddress = this.usdcToken.address.toLowerCase();
    const reserve0Big = BigInt(reserve0);
    const reserve1Big = BigInt(reserve1);

    if (normalizedToken0 === wplsAddress && normalizedToken1 === usdcAddress) {
      return {
        reserveWpls: reserve0Big,
        reserveUsdc: reserve1Big,
      };
    }

    if (normalizedToken1 === wplsAddress && normalizedToken0 === usdcAddress) {
      return {
        reserveWpls: reserve1Big,
        reserveUsdc: reserve0Big,
      };
    }

    throw new Error('Pair tokens do not match expected WPLS/USDC order');
  }

  private isZeroAddress(value: string | undefined): boolean {
    if (!value) {
      return true;
    }
    const normalized = value.toLowerCase();
    return (
      normalized === '0x0' ||
      normalized === ZERO_ADDRESS ||
      normalized === ZERO_ADDRESS.toLowerCase()
    );
  }
}
