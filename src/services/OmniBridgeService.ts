import { promises as fs } from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { 
  OmniBridgeTokenList, 
  OmniBridgeCurrency, 
  OmniBridgeEstimateParams, 
  OmniBridgeEstimateResponse 
} from '../types/omnibridge';

export class OmniBridgeService {
  private tokenListPath: string;
  private cachedTokenList: OmniBridgeTokenList | null = null;
  private lastCacheTime: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

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
      const { tokenAddress, networkId, amount = '0' } = params;
      
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
