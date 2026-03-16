import { promises as fs } from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { 
  OmniBridgeTokenList, 
  OmniBridgeCurrency, 
  OmniBridgeEstimateParams, 
  OmniBridgeEstimateResponse 
} from '../types/omnibridge';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type Counterpart = {
  chainId: number;
  address: string;
};

type TokenEndpoint = {
  chainId: number;
  address: string;
};

const SUPPORTED_COUNTERPART_PAIRS: Array<[TokenEndpoint, TokenEndpoint]> = [
  // Native ETH <-> bridged WETH on PulseChain
  [{ chainId: 1, address: ZERO_ADDRESS }, { chainId: 369, address: '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C' }],
  // Core bridged assets (Ethereum <-> PulseChain "from Ethereum")
  [{ chainId: 1, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }, { chainId: 369, address: '0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C' }],
  [{ chainId: 1, address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' }, { chainId: 369, address: '0xefD766cCb38EaF1dfd701853BFCe31359239F305' }],
  [{ chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }, { chainId: 369, address: '0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07' }],
  [{ chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }, { chainId: 369, address: '0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f' }],
  [{ chainId: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' }, { chainId: 369, address: '0xb17D901469B9208B17d916112988A3FeD19b5cA1' }],
  // Additional explicit bridge pairs
  [{ chainId: 1, address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' }, { chainId: 369, address: '0x57fde0a71132198BBeC939B98976993d8D89D225' }],
  [{ chainId: 1, address: '0x4AC429A7cdf2b533E2c0cFF1b017F2c344E864e2' }, { chainId: 369, address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' }],
  // Native PLS <-> wrapped/bridged representations on Ethereum
  [{ chainId: 369, address: ZERO_ADDRESS }, { chainId: 1, address: '0xA882606494D86804B5514E07e6Bd2D6a6eE6d68A' }],
  [{ chainId: 369, address: ZERO_ADDRESS }, { chainId: 1, address: '0x97Ac4a2439A47c07ad535bb1188c989dae755341' }],
];

export class OmniBridgeService {
  private tokenListPath: string;
  private cachedTokenList: OmniBridgeTokenList | null = null;
  private lastCacheTime: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private readonly counterpartsBySource = this.buildCounterpartMap();

  constructor() {
    this.tokenListPath = path.join(__dirname, '..', 'data', 'pulsebridge.tokenlist.json');
  }

  private async fetchTokenList(): Promise<OmniBridgeTokenList> {
    const candidatePaths = [
      this.tokenListPath,
      path.join(process.cwd(), 'src', 'data', 'pulsebridge.tokenlist.json'),
      path.join(process.cwd(), 'dist', 'data', 'pulsebridge.tokenlist.json')
    ];

    for (const candidate of candidatePaths) {
      try {
        const raw = await fs.readFile(candidate, 'utf-8');
        return JSON.parse(raw) as OmniBridgeTokenList;
      } catch (error) {
        // try next candidate
      }
    }

    console.error('Failed to load OmniBridge token list from any local path');
    throw new Error('Failed to load supported tokens');
  }

  private async getCachedTokenList(): Promise<OmniBridgeTokenList> {
    const now = Date.now();
    
    // Return cached data if it's still valid
    if (this.cachedTokenList && (now - this.lastCacheTime) < this.CACHE_DURATION) {
      return this.cachedTokenList;
    }

    // Fetch new data and cache it
    this.cachedTokenList = await this.fetchTokenList();
    this.lastCacheTime = now;
    
    return this.cachedTokenList;
  }

  async getSupportedCurrencies(): Promise<OmniBridgeCurrency[]> {
    try {
      const tokenList = await this.getCachedTokenList();
      
      // Map existing tokens
      const currencies = tokenList.tokens.map(token => ({
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        address: token.address,
        chainId: token.chainId,
        logoURI: token.logoURI,
        tags: token.tags,
        network: token.chainId === 1 ? 'ethereum' : token.chainId === 369 ? 'pulsechain' : `chain-${token.chainId}`
      }));

      // Add native ETH token for Ethereum chain
      const ethToken: OmniBridgeCurrency = {
        name: 'Ethereum',
        symbol: 'ETH',
        decimals: 18,
        address: '0x0000000000000000000000000000000000000000', // Zero address for native token
        chainId: 1,
        logoURI: '/token-logos/eth/0x0000000000000000000000000000000000000000.png', // Local bundled icon
        tags: ['priority', 'verified'],
        network: 'ethereum'
      };

      // Add native PLS token for PulseChain
      const plsToken: OmniBridgeCurrency = {
        name: 'Pulse',
        symbol: 'PLS',
        decimals: 18,
        address: '0x0000000000000000000000000000000000000000', // Zero address for native token
        chainId: 369,
        logoURI: '/token-logos/pulsex/369/0x0000000000000000000000000000000000000000.png', // Local bundled icon
        tags: ['priority', 'verified'],
        network: 'pulsechain'
      };

      // Add native tokens to the beginning of the list
      return [ethToken, plsToken, ...currencies];
    } catch (error) {
      console.error('Failed to get supported currencies:', error);
      throw new Error('Failed to fetch supported currencies');
    }
  }

  async getEstimatedAmount(params: OmniBridgeEstimateParams): Promise<OmniBridgeEstimateResponse> {
    try {
      const { tokenAddress, networkId, amount = '0', targetChainId } = params;
      
      // Get supported currencies to check if token is supported
      const currencies = await this.getSupportedCurrencies();
      const token = currencies.find(currency => 
        currency.address.toLowerCase() === tokenAddress.toLowerCase() && 
        currency.chainId === networkId
      );

      if (!token) {
        return {
          tokenAddress,
          networkId,
          amount,
          estimatedAmount: '0',
          fee: '0',
          feePercentage: 0,
          isSupported: false
        };
      }

      if (
        targetChainId &&
        !this.hasCounterpartOnTargetByAddress(token, targetChainId, currencies)
      ) {
        return {
          tokenAddress,
          networkId,
          amount,
          estimatedAmount: '0',
          fee: '0',
          feePercentage: 0,
          isSupported: false
        };
      }

      // Calculate fee based on network (expressed as basis points to avoid floats)
      let feeBps = 0; // basis points, e.g. 30 = 0.3%
      if (networkId === 369) { // PulseChain
        feeBps = 30;
      } else if (networkId === 1) { // Ethereum
        feeBps = 0;
      } else {
        feeBps = 0;
      }

      const feePercentage = feeBps / 100; // maintain existing response contract
      const { feeWei, estimatedAmountWei } = this.calculateFeeInWei(amount, token.decimals, feeBps);

      return {
        tokenAddress,
        networkId,
        amount,
        estimatedAmount: estimatedAmountWei,
        fee: feeWei,
        feePercentage,
        isSupported: true
      };
    } catch (error) {
      console.error('Failed to get estimated amount:', error);
      throw new Error('Failed to calculate estimate');
    }
  }

  private normalizeTokenKey(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  private buildCounterpartMap(): Map<string, Counterpart[]> {
    const map = new Map<string, Counterpart[]>();

    const appendUniqueCounterpart = (
      sourceKey: string,
      counterpart: Counterpart
    ) => {
      const existing = map.get(sourceKey) ?? [];
      const exists = existing.some(
        (item) =>
          item.chainId === counterpart.chainId &&
          item.address === counterpart.address
      );

      if (!exists) {
        existing.push(counterpart);
        map.set(sourceKey, existing);
      }
    };

    for (const [left, right] of SUPPORTED_COUNTERPART_PAIRS) {
      const leftKey = this.normalizeTokenKey(left.chainId, left.address);
      const rightKey = this.normalizeTokenKey(right.chainId, right.address);

      appendUniqueCounterpart(leftKey, {
        chainId: right.chainId,
        address: right.address.toLowerCase(),
      });

      appendUniqueCounterpart(rightKey, {
        chainId: left.chainId,
        address: left.address.toLowerCase(),
      });
    }

    return map;
  }

  private hasCounterpartOnTargetByAddress(
    token: OmniBridgeCurrency,
    targetChainId: number,
    currencies: OmniBridgeCurrency[]
  ): boolean {
    const sourceKey = this.normalizeTokenKey(token.chainId, token.address);
    const counterparts = this.counterpartsBySource.get(sourceKey) ?? [];
    const targetCounterparts = counterparts.filter(
      (counterpart) => counterpart.chainId === targetChainId
    );

    if (!targetCounterparts.length) {
      return false;
    }

    const availableTargetKeys = new Set(
      currencies
        .filter((currency) => currency.chainId === targetChainId)
        .map((currency) =>
          this.normalizeTokenKey(currency.chainId, currency.address)
        )
    );

    return targetCounterparts.some((counterpart) =>
      availableTargetKeys.has(
        this.normalizeTokenKey(counterpart.chainId, counterpart.address)
      )
    );
  }

  async isTokenSupported(tokenAddress: string, networkId: number): Promise<boolean> {
    try {
      const currencies = await this.getSupportedCurrencies();
      
      // Check for exact match first
      const exactMatch = currencies.some(currency => 
        currency.address.toLowerCase() === tokenAddress.toLowerCase() && 
        currency.chainId === networkId
      );
      
      if (exactMatch) return true;
      
      // Check for native tokens (ETH/PLS) with zero address
      if (tokenAddress.toLowerCase() === '0x0000000000000000000000000000000000000000') {
        return currencies.some(currency => 
          currency.chainId === networkId && 
          (currency.symbol === 'ETH' || currency.symbol === 'PLS')
        );
      }
      
      return false;
    } catch (error) {
      console.error('Failed to check token support:', error);
      return false;
    }
  }

  // Utility function to convert wei amount to human readable format
  formatWeiToHumanReadable(weiAmount: string, decimals: number): string {
    try {
      return ethers.formatUnits(weiAmount, decimals);
    } catch (error) {
      console.error('Failed to convert wei to human readable:', error);
      return weiAmount;
    }
  }

  // Utility function to convert human readable to wei
  parseHumanReadableToWei(amount: string, decimals: number): string {
    try {
      const wei = ethers.parseUnits(amount, decimals);
      return wei.toString();
    } catch (error) {
      console.error('Failed to convert human readable to wei:', error);
      return '0';
    }
  }

  // Utility function to calculate fee using integer math
  calculateFeeInWei(weiAmount: string, decimals: number, feeBps: number): {
    feeWei: string;
    estimatedAmountWei: string;
    humanReadableAmount: string;
    feeHuman: string;
    estimatedHuman: string;
  } {
    try {
      const amountWei = BigInt(weiAmount);
      const feeBpsBigInt = BigInt(feeBps);
      const bpsDivisor = 10000n;

      const feeWeiBigInt = (amountWei * feeBpsBigInt) / bpsDivisor;
      const estimatedWeiBigInt = amountWei - feeWeiBigInt;

      const humanReadableAmount = ethers.formatUnits(amountWei, decimals);
      const feeHuman = ethers.formatUnits(feeWeiBigInt, decimals);
      const estimatedHuman = ethers.formatUnits(estimatedWeiBigInt, decimals);

      return {
        feeWei: feeWeiBigInt.toString(),
        estimatedAmountWei: estimatedWeiBigInt.toString(),
        humanReadableAmount,
        feeHuman,
        estimatedHuman
      };
    } catch (error) {
      console.error('Failed to calculate fee:', error);
      return {
        feeWei: '0',
        estimatedAmountWei: weiAmount,
        humanReadableAmount: '0',
        feeHuman: '0',
        estimatedHuman: '0'
      };
    }
  }
} 
