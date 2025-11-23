import { Contract, Interface, formatUnits, type Provider } from 'ethers';
import PulsexFactoryAbi from '../abis/PulsexFactory.json';
import type { PulsexConfig } from '../config/pulsex';
import type { PulsexToken } from '../types/pulsex';
import type { Address } from '../types/pulsex';
import { MulticallClient, type MulticallCall, type MulticallResult } from '../utils/multicall';
import { Logger } from '../utils/logger';

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
  private readonly multicallClient?: MulticallClient;
  private readonly pairInterface = new Interface(PAIR_ABI);
  private readonly logger = new Logger('PulseXPriceOracle');

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

    if (config.multicall?.enabled) {
      try {
        this.multicallClient = new MulticallClient(provider, {
          address: config.multicall.address,
          enabled: config.multicall.enabled,
          maxBatchSize: config.multicall.maxBatchSize,
          timeoutMs: config.multicall.timeoutMs,
        }, this.logger);
      } catch (error) {
        this.logger.debug('Failed to initialize Multicall client for price oracle', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    const pairData = await this.fetchPairData(
      this.wplsToken.address as Address,
      this.usdcToken.address as Address,
    );
    if (!pairData) {
      throw new Error('Unable to determine WPLS/USDC price from PulseX pairs');
    }

    const { reserveWpls, reserveUsdc } = this.mapReserves(
      pairData.token0,
      pairData.token1,
      pairData.reserve0,
      pairData.reserve1,
    );

    if (reserveWpls === 0n || reserveUsdc === 0n) {
      throw new Error('Unable to determine WPLS/USDC price from PulseX pairs');
    }

    const wplsFloat = Number(
      formatUnits(reserveWpls, this.wplsToken.decimals ?? 18),
    );
    const usdcFloat = Number(
      formatUnits(reserveUsdc, this.usdcToken.decimals ?? 6),
    );

    if (!Number.isFinite(wplsFloat) || wplsFloat === 0) {
      throw new Error('Unable to determine WPLS/USDC price from PulseX pairs');
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
    const priceInPls = await this.tryGetPriceInPls(tokenAddress);
    if (priceInPls !== null) {
      priceUsd = priceInPls * plsPriceUsd;
    }

    // If direct WPLS pair not found or empty, try USDC pair
    if (priceUsd === 0) {
      const priceInUsdc = await this.tryGetPriceInUsdc(tokenAddress);
      if (priceInUsdc !== null) {
        priceUsd = priceInUsdc;
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
    tokenAddress: string,
  ): Promise<number | null> {
    const pairData = await this.fetchPairData(
      tokenAddress as Address,
      this.wplsToken.address as Address,
    );
    if (!pairData) {
      return null;
    }

    const normalizedToken0 = pairData.token0.toLowerCase();
    const normalizedTokenAddress = tokenAddress.toLowerCase();

    const reserveToken =
      normalizedToken0 === normalizedTokenAddress
        ? pairData.reserve0
        : pairData.reserve1;
    const reserveWpls =
      normalizedToken0 === normalizedTokenAddress
        ? pairData.reserve1
        : pairData.reserve0;

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
  }

  private async tryGetPriceInUsdc(
    tokenAddress: string,
  ): Promise<number | null> {
    const pairData = await this.fetchPairData(
      tokenAddress as Address,
      this.usdcToken.address as Address,
    );
    if (!pairData) {
      return null;
    }

    const normalizedToken0 = pairData.token0.toLowerCase();
    const normalizedTokenAddress = tokenAddress.toLowerCase();

    const reserveToken =
      normalizedToken0 === normalizedTokenAddress
        ? pairData.reserve0
        : pairData.reserve1;
    const reserveUsdc =
      normalizedToken0 === normalizedTokenAddress
        ? pairData.reserve1
        : pairData.reserve0;

    if (reserveToken === 0n || reserveUsdc === 0n) {
      return null;
    }

    const decimals = await this.getDecimals(tokenAddress);
    if (decimals === null) return null;

    const usdcFloat = Number(
      formatUnits(reserveUsdc, this.usdcToken.decimals ?? 6),
    );
    const tokenFloat = Number(formatUnits(reserveToken, decimals));

    if (tokenFloat === 0) return null;

    return usdcFloat / tokenFloat;
  }

  private async fetchPairData(
    tokenA: Address,
    tokenB: Address,
  ): Promise<{
    pairAddress: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
  } | null> {
    const multicallResult = await this.tryFetchPairDataWithMulticall(
      tokenA,
      tokenB,
    );
    if (multicallResult) {
      return multicallResult;
    }

    for (const factory of this.factoryPriority) {
      let pairAddress: Address | null = null;
      try {
        pairAddress = (await factory.getPair(tokenA, tokenB)) as Address;
      } catch (error) {
        continue;
      }

      if (!pairAddress || this.isZeroAddress(pairAddress)) {
        continue;
      }

      const pairContract = new Contract(pairAddress, PAIR_ABI, this.provider);
      try {
        const [token0, token1, reserves] = await Promise.all([
          pairContract.token0(),
          pairContract.token1(),
          pairContract.getReserves(),
        ]);
        const reserve0 = BigInt((reserves as [bigint, bigint, number])[0]);
        const reserve1 = BigInt((reserves as [bigint, bigint, number])[1]);
        if (reserve0 === 0n || reserve1 === 0n) {
          continue;
        }

        return {
          pairAddress,
          token0: token0 as Address,
          token1: token1 as Address,
          reserve0,
          reserve1,
        };
      } catch (error) {
        continue;
      }
    }

    return null;
  }

  private async tryFetchPairDataWithMulticall(
    tokenA: Address,
    tokenB: Address,
  ): Promise<{
    pairAddress: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
  } | null> {
    if (!this.multicallClient || !this.multicallClient.isEnabled()) {
      return null;
    }

    const getPairCalls: MulticallCall[] = this.factoryPriority.map((factory) => ({
      target: factory.target as Address,
      callData: factory.interface.encodeFunctionData('getPair', [tokenA, tokenB]),
    }));

    let pairResults: MulticallResult[];
    try {
      pairResults = await this.multicallClient.execute(getPairCalls);
    } catch (error) {
      this.logger.debug('Multicall getPair stage failed (oracle)', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    let pairAddress: Address | null = null;
    let chosenIndex = -1;
    for (let i = 0; i < pairResults.length; i += 1) {
      const result = pairResults[i];
      if (!result?.success || !result.returnData) {
        continue;
      }
      try {
        const decoded = this.factoryPriority[i].interface.decodeFunctionResult(
          'getPair',
          result.returnData,
        );
        const candidate = decoded[0] as Address;
        if (candidate && !this.isZeroAddress(candidate)) {
          pairAddress = candidate;
          chosenIndex = i;
          break;
        }
      } catch (error) {
        continue;
      }
    }

    if (!pairAddress || chosenIndex < 0) {
      return null;
    }

    const pairCalls: MulticallCall[] = [
      {
        target: pairAddress,
        callData: this.pairInterface.encodeFunctionData('token0', []),
      },
      {
        target: pairAddress,
        callData: this.pairInterface.encodeFunctionData('token1', []),
      },
      {
        target: pairAddress,
        callData: this.pairInterface.encodeFunctionData('getReserves', []),
      },
    ];

    let pairDetailResults: MulticallResult[];
    try {
      pairDetailResults = await this.multicallClient.execute(pairCalls);
    } catch (error) {
      this.logger.debug('Multicall pair detail stage failed (oracle)', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (
      pairDetailResults.length < 3 ||
      !pairDetailResults[0]?.success ||
      !pairDetailResults[1]?.success ||
      !pairDetailResults[2]?.success
    ) {
      return null;
    }

    try {
      const decodedToken0 = this.pairInterface.decodeFunctionResult(
        'token0',
        pairDetailResults[0].returnData,
      );
      const decodedToken1 = this.pairInterface.decodeFunctionResult(
        'token1',
        pairDetailResults[1].returnData,
      );
      const decodedReserves = this.pairInterface.decodeFunctionResult(
        'getReserves',
        pairDetailResults[2].returnData,
      );

      const reserve0 = BigInt(decodedReserves[0] as bigint);
      const reserve1 = BigInt(decodedReserves[1] as bigint);
      if (reserve0 === 0n || reserve1 === 0n) {
        return null;
      }

      return {
        pairAddress,
        token0: decodedToken0[0] as Address,
        token1: decodedToken1[0] as Address,
        reserve0,
        reserve1,
      };
    } catch (error) {
      this.logger.debug('Failed to decode pair details via multicall (oracle)', {
        message: error instanceof Error ? error.message : String(error),
      });
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

