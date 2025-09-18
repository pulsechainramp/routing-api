import { PrismaClient } from '../generated/prisma-client';
import { ChangeNowService } from './ChangeNowService';

export interface QuoteResponse {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  toAmount: number;
  rate: number;
  fees: {
    depositFee: number;
    withdrawalFee: number;
  };
  minAmount: number;
  maxAmount: number | null;
  validUntil: string | null;
}

export class RateService {
  private prisma: PrismaClient;
  private changeNowService: ChangeNowService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.changeNowService = new ChangeNowService();
  }

  async getQuote(params: {
    fromCurrency: string;
    toCurrency: string;
    amount: number;
    fromNetwork?: string;
    toNetwork?: string;
    flow?: 'standard' | 'fixed-rate';
  }): Promise<QuoteResponse> {
    const { fromCurrency, toCurrency, amount, fromNetwork, toNetwork, flow = 'standard' } = params;

    // Get exchange range
    const range = await this.getExchangeRange(fromCurrency, toCurrency, fromNetwork, toNetwork, flow);
    
    // Validate amount
    if (amount < range.minAmount) {
      throw new Error(`Amount too small. Minimum: ${range.minAmount}`);
    }
    if (range.maxAmount && amount > range.maxAmount) {
      throw new Error(`Amount too large. Maximum: ${range.maxAmount}`);
    }

    // Get estimate from ChangeNow
    const estimate = await this.changeNowService.getEstimatedAmount({
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      fromNetwork,
      toNetwork,
      flow,
      type: 'direct'
    });

    return {
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount: estimate.toAmount,
      rate: estimate.toAmount / amount,
      fees: {
        depositFee: estimate.depositFee,
        withdrawalFee: estimate.withdrawalFee
      },
      minAmount: range.minAmount,
      maxAmount: range.maxAmount,
      validUntil: estimate.validUntil
    };
  }

  async getExchangeRange(
    fromCurrency: string,
    toCurrency: string,
    fromNetwork?: string,
    toNetwork?: string,
    flow: 'standard' | 'fixed-rate' = 'standard'
  ): Promise<{ minAmount: number; maxAmount: number | null }> {
    // Check cache first
    const cached = await this.prisma.rateCache.findUnique({
      where: {
        fromCurrency_toCurrency: {
          fromCurrency,
          toCurrency
        }
      }
    });

    if (cached && this.isRateValid(cached)) {
      return {
        minAmount: Number(cached.minAmount),
        maxAmount: cached.maxAmount ? Number(cached.maxAmount) : null
      };
    }

    // Get fresh data from ChangeNow
    const range = await this.changeNowService.getExchangeRange(
      fromCurrency, toCurrency, fromNetwork, toNetwork, flow
    );

    // Update cache
    await this.prisma.rateCache.upsert({
      where: {
        fromCurrency_toCurrency: {
          fromCurrency,
          toCurrency
        }
      },
      update: {
        minAmount: range.minAmount,
        maxAmount: range.maxAmount,
        validUntil: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
      },
      create: {
        fromCurrency,
        toCurrency,
        fromNetwork: fromNetwork || undefined,
        toNetwork: toNetwork || undefined,
        minAmount: range.minAmount,
        maxAmount: range.maxAmount,
        rate: 0, // Not used for range
        validUntil: new Date(Date.now() + 5 * 60 * 1000)
      }
    });

    return {
      minAmount: range.minAmount,
      maxAmount: range.maxAmount
    };
  }

  private isRateValid(cachedRate: { validUntil: Date }): boolean {
    return new Date() < cachedRate.validUntil;
  }

  async refreshRates(): Promise<void> {
    // Clear expired cache entries
    await this.prisma.rateCache.deleteMany({
      where: {
        validUntil: {
          lt: new Date()
        }
      }
    });

    console.log('Refreshed rate cache');
  }
} 