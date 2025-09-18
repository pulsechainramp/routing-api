import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { 
  OmniBridgeTokenList, 
  OmniBridgeCurrency, 
  OmniBridgeEstimateParams, 
  OmniBridgeEstimateResponse 
} from '../types/omnibridge';

export class OmniBridgeService {
  private client: AxiosInstance;
  private tokenListUrl: string;
  private cachedTokenList: OmniBridgeTokenList | null = null;
  private lastCacheTime: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.tokenListUrl = 'https://bridge.mypinata.cloud/ipfs/bafybeif242ld54nzjg2aqxvfse23wpbkqbyqasj3usgslccuajnykonzo4/pulsebridge.tokenlist.json';
    
    this.client = axios.create({
      timeout: 10000
    });
  }

  private async fetchTokenList(): Promise<OmniBridgeTokenList> {
    try {
      const response = await this.client.get<OmniBridgeTokenList>(this.tokenListUrl);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch OmniBridge token list:', error);
      throw new Error('Failed to fetch supported tokens');
    }
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
        logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png', // Using WETH icon
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
        logoURI: 'https://tokens.app.pulsex.com/images/tokens/0xA1077a294dDE1B09bB078844df40758a5D0f9a27.png', // Using WPLS icon
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

      // Convert wei amount to human-readable format first
      const humanReadableAmount = ethers.formatUnits(amount, token.decimals);
      
      // Calculate fee based on network
      let feePercentage = 0;
      if (networkId === 369) { // PulseChain
        feePercentage = 0.3; // 0.3%
      } else if (networkId === 1) { // Ethereum
        feePercentage = 0; // 0%
      } else {
        feePercentage = 0; // Default to 0% for unknown networks
      }

      // Calculate fee on human-readable amount
      const feeAmount = (parseFloat(humanReadableAmount) * feePercentage) / 100;
      const estimatedHumanAmount = parseFloat(humanReadableAmount) - feeAmount;

      // Convert back to wei format for response
      const feeWei = ethers.parseUnits(feeAmount.toString(), token.decimals).toString();
      const estimatedAmountWei = ethers.parseUnits(estimatedHumanAmount.toString(), token.decimals).toString();

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

  // Utility function to calculate fee and return wei amounts
  calculateFeeInWei(weiAmount: string, decimals: number, feePercentage: number): {
    feeWei: string;
    estimatedAmountWei: string;
    humanReadableAmount: string;
    feeHuman: string;
    estimatedHuman: string;
  } {
    try {
      // Convert wei to human readable
      const humanReadableAmount = ethers.formatUnits(weiAmount, decimals);
      
      // Calculate fee on human readable amount
      const feeAmount = (parseFloat(humanReadableAmount) * feePercentage) / 100;
      const estimatedHumanAmount = parseFloat(humanReadableAmount) - feeAmount;
      
      // Convert back to wei
      const feeWei = ethers.parseUnits(feeAmount.toString(), decimals).toString();
      const estimatedAmountWei = ethers.parseUnits(estimatedHumanAmount.toString(), decimals).toString();
      
      return {
        feeWei,
        estimatedAmountWei,
        humanReadableAmount,
        feeHuman: feeAmount.toString(),
        estimatedHuman: estimatedHumanAmount.toString()
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