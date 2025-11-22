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

interface FailureCacheEntry {
  expiresAt: number;
}

export class PulseXPriceOracle {
  private cache?: PriceCacheEntry;
  private tokenPriceCache = new Map<string, PriceCacheEntry>();
  private tokenDecimalsCache = new Map<string, number>();
  private tokenFailureCache = new Map<string, FailureCacheEntry>();

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
    this.tokenPriceCache.clear();
    this.tokenDecimalsCache.clear();
    this.tokenFailureCache.clear();
  }

  public async getPlsPriceUsd(): Promise<number> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const price = await this.loadPrice();
    this.cache = {
      value: price,
      expiresAt: Date.now() + this.config.cacheTtlMs.priceOracle,
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

  public async getTokenPriceUsd(tokenAddress: string): Promise<number> {
    const normalizedAddress = tokenAddress.toLowerCase();

    const cached = this.tokenPriceCache.get(normalizedAddress);
    if (cached && cached.expiresAt > Date.now() && cached.value > 0) {
      return cached.value;
    }

    const failure = this.tokenFailureCache.get(normalizedAddress);
    if (failure && failure.expiresAt > Date.now()) {
      throw new Error('Token price unavailable');
    }

    const wplsAddress = this.wplsToken.address.toLowerCase();
    const usdcAddress = this.usdcToken.address.toLowerCase();

    // 1. If token is WPLS or PLS (native), return PLS price
    if (
      normalizedAddress === wplsAddress ||
      normalizedAddress === 'pls' ||
      this.isZeroAddress(normalizedAddress)
    ) {
      return this.getPlsPriceUsd();
    }

    // 2. If token is USDC, return 1.0 (approx)
    if (normalizedAddress === usdcAddress) {
      const value = 1.0;
      this.tokenPriceCache.set(normalizedAddress, {
        value,
        expiresAt: Date.now() + this.config.cacheTtlMs.priceOracle,
      });
      return value;
    }

    // 3. Get PLS price in USD
    const plsPriceUsd = await this.getPlsPriceUsd();

    let priceUsd = 0;

    // 4. Find pair with WPLS to get Token/WPLS price
    for (const factory of this.factoryPriority) {
      const priceInPls = await this.tryGetPriceInPls(factory, tokenAddress);
      if (priceInPls !== null) {
        priceUsd = priceInPls * plsPriceUsd;
        break;
      }
    }

    // If direct WPLS pair not found or empty, try USDC pair
    if (priceUsd === 0) {
      for (const factory of this.factoryPriority) {
        const priceInUsdc = await this.tryGetPriceInUsdc(factory, tokenAddress);
        if (priceInUsdc !== null) {
          priceUsd = priceInUsdc;
          break;
        }
      }
    }

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      this.tokenFailureCache.set(normalizedAddress, {
        expiresAt: Date.now() + 30_000, // short TTL for negative cache
      });
      throw new Error('Token price unavailable');
    }

    this.tokenFailureCache.delete(normalizedAddress);
    this.tokenPriceCache.set(normalizedAddress, {
      value: priceUsd,
      expiresAt: Date.now() + this.config.cacheTtlMs.priceOracle
    });

    return priceUsd;
  }

  private async getDecimals(tokenAddress: string): Promise<number | null> {
    const normalized = tokenAddress.toLowerCase();
    if (this.tokenDecimalsCache.has(normalized)) {
      return this.tokenDecimalsCache.get(normalized)!;
    }

    try {
      const tokenContract = new Contract(
        tokenAddress,
        ['function decimals() view returns (uint8)'],
        this.provider,
      );
      const decimals = Number(await tokenContract.decimals());
      this.tokenDecimalsCache.set(normalized, decimals);
      return decimals;
    } catch (e) {
      return null;
    }
  }

  private async tryGetPriceInPls(
    factory: Contract,
    tokenAddress: string,
  ): Promise<number | null> {
    try {
      const pairAddress = await factory.getPair(
        tokenAddress,
        this.wplsToken.address,
      );

      if (!pairAddress || this.isZeroAddress(pairAddress)) {
        return null;
      }

      const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
      const token0 = (await pairContract.token0()) as string;
      const [reserve0, reserve1] = await pairContract.getReserves();

      const normalizedToken0 = token0.toLowerCase();
      const normalizedTokenAddress = tokenAddress.toLowerCase();

      let reserveToken: bigint;
      let reserveWpls: bigint;

      if (normalizedToken0 === normalizedTokenAddress) {
        reserveToken = BigInt(reserve0);
        reserveWpls = BigInt(reserve1);
      } else {
        reserveToken = BigInt(reserve1);
        reserveWpls = BigInt(reserve0);
      }

      if (reserveToken === 0n || reserveWpls === 0n) {
        return null;
      }

      const decimals = await this.getDecimals(tokenAddress);
      if (decimals === null) return null;

      const wplsFloat = Number(
        formatUnits(reserveWpls, this.wplsToken.decimals ?? 18),
      );
      const tokenFloat = Number(formatUnits(reserveToken, decimals));

      if (tokenFloat === 0) return null;

      return wplsFloat / tokenFloat;

    } catch (error) {
      return null;
    }
  }

  private async tryGetPriceInUsdc(
    factory: Contract,
    tokenAddress: string,
  ): Promise<number | null> {
    try {
      const pairAddress = await factory.getPair(
        tokenAddress,
        this.usdcToken.address,
      );

      if (!pairAddress || this.isZeroAddress(pairAddress)) {
        return null;
      }

      const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
      const token0 = (await pairContract.token0()) as string;
      const [reserve0, reserve1] = await pairContract.getReserves();

      const normalizedToken0 = token0.toLowerCase();
      const normalizedTokenAddress = tokenAddress.toLowerCase();

      let reserveToken: bigint;
      let reserveUsdc: bigint;

      if (normalizedToken0 === normalizedTokenAddress) {
        reserveToken = BigInt(reserve0);
        reserveUsdc = BigInt(reserve1);
      } else {
        reserveToken = BigInt(reserve1);
        reserveUsdc = BigInt(reserve0);
      }

      if (reserveToken === 0n || reserveUsdc === 0n) {
        return null;
      }

      const decimals = await this.getDecimals(tokenAddress);
      if (decimals === null) return null;

      const usdcFloat = Number(formatUnits(reserveUsdc, this.usdcToken.decimals ?? 6));
      const tokenFloat = Number(formatUnits(reserveToken, decimals));

      if (tokenFloat === 0) return null;

      return usdcFloat / tokenFloat;

    } catch (error) {
      return null;
    }
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

