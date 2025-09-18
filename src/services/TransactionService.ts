import { PrismaClient } from '../generated/prisma-client';
import { ChangeNowService } from './ChangeNowService';
import { RateService } from './RateService';

export interface CreateSwapParams {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: number;
  userAddress: string;
  fromNetwork?: string;
  toNetwork?: string;
  refundAddress?: string;
}

export interface SwapResponse {
  transactionId: string;
  payinAddress: string;
  expectedAmount: number;
  status: string;
  validUntil: string | null;
}

export class TransactionService {
  private prisma: PrismaClient;
  private changeNowService: ChangeNowService;
  private rateService: RateService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.changeNowService = new ChangeNowService();
    this.rateService = new RateService(prisma);
  }

  async createSwap(params: CreateSwapParams): Promise<SwapResponse> {
    const { fromCurrency, toCurrency, fromAmount, userAddress, fromNetwork, toNetwork, refundAddress } = params;

    // Get quote to validate amounts
    const quote = await this.rateService.getQuote({
      fromCurrency,
      toCurrency,
      amount: fromAmount,
      fromNetwork,
      toNetwork
    });

    // Create ChangeNow transaction
    const changenowTransaction = await this.changeNowService.createTransaction({
      fromCurrency,
      fromNetwork: fromNetwork || '',
      toCurrency,
      toNetwork: toNetwork || '',
      fromAmount: fromAmount.toString(),
      address: userAddress,
      refundAddress,
      flow: 'standard'
    });

    // Create transaction in database
    const transaction = await this.prisma.transaction.create({
      data: {
        changenowId: changenowTransaction.id,
        userAddress,
        fromCurrency,
        toCurrency,
        fromNetwork,
        toNetwork,
        fromAmount: fromAmount,
        expectedToAmount: quote.toAmount,
        status: 'pending',
        payinAddress: changenowTransaction.payinAddress,
        payoutAddress: changenowTransaction.payoutAddress,
        refundAddress,
        metadata: {
          quote: {
            fromCurrency: quote.fromCurrency,
            toCurrency: quote.toCurrency,
            fromAmount: quote.fromAmount,
            toAmount: quote.toAmount,
            rate: quote.rate,
            fees: quote.fees,
            minAmount: quote.minAmount,
            maxAmount: quote.maxAmount,
            validUntil: quote.validUntil
          },
          changenowResponse: {
            id: changenowTransaction.id,
            fromAmount: changenowTransaction.fromAmount,
            toAmount: changenowTransaction.toAmount,
            flow: changenowTransaction.flow,
            type: changenowTransaction.type,
            payinAddress: changenowTransaction.payinAddress,
            payoutAddress: changenowTransaction.payoutAddress,
            fromCurrency: changenowTransaction.fromCurrency,
            toCurrency: changenowTransaction.toCurrency
          }
        }
      }
    });

    console.log(`Created swap transaction: ${transaction.id}`);

    return {
      transactionId: transaction.id,
      payinAddress: transaction.payinAddress,
      expectedAmount: Number(transaction.expectedToAmount),
      status: transaction.status,
      validUntil: quote.validUntil
    };
  }

  async getTransaction(id: string) {
    return this.prisma.transaction.findUnique({
      where: { id }
    });
  }

  async getTransactionsByUser(userAddress: string, limit: number = 50, offset: number = 0) {
    return this.prisma.transaction.findMany({
      where: { userAddress },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    });
  }

  async updateTransactionStatus(
    id: string, 
    status: string, 
    additionalData?: {
      payinHash?: string;
      payoutHash?: string;
      toAmount?: number;
      depositReceivedAt?: Date;
      refundHash?: string;
      refundAmount?: number;
      errorMessage?: string;
    }
  ): Promise<void> {
    const updateData: any = {
      status,
      updatedAt: new Date()
    };

    if (additionalData) {
      if (additionalData.payinHash) updateData.payinHash = additionalData.payinHash;
      if (additionalData.payoutHash) updateData.payoutHash = additionalData.payoutHash;
      if (additionalData.toAmount) updateData.toAmount = additionalData.toAmount;
      if (additionalData.depositReceivedAt) updateData.depositReceivedAt = additionalData.depositReceivedAt;
      if (additionalData.refundHash) updateData.refundHash = additionalData.refundHash;
      if (additionalData.refundAmount) updateData.refundAmount = additionalData.refundAmount;
      if (additionalData.errorMessage) updateData.errorMessage = additionalData.errorMessage;
      if (status === 'finished') updateData.completedAt = new Date();
    }

    await this.prisma.transaction.update({
      where: { id },
      data: updateData
    });

    console.log(`Updated transaction ${id} status to: ${status}`);
  }

  async getTransactionStats() {
    const [total, pending, finished, failed] = await Promise.all([
      this.prisma.transaction.count(),
      this.prisma.transaction.count({ where: { status: 'pending' } }),
      this.prisma.transaction.count({ where: { status: 'finished' } }),
      this.prisma.transaction.count({ where: { status: 'failed' } })
    ]);

    return { total, pending, finished, failed };
  }
} 