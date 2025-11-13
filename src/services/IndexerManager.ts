import { ReferralFeeIndexer } from './ReferralFeeIndexer';
import { ReferralFeeService } from './ReferralFeeService';
import { PrismaClient } from '../generated/prisma-client';
import type { Provider } from 'ethers';

export class IndexerManager {
  private referralFeeIndexer: ReferralFeeIndexer;
  private isRunning: boolean = false;

  constructor(
    prisma: PrismaClient,
    provider: Provider,
    affiliateRouterAddress: string
  ) {
    const referralFeeService = new ReferralFeeService(prisma);
    this.referralFeeIndexer = new ReferralFeeIndexer(
      provider,
      affiliateRouterAddress,
      referralFeeService,
      prisma
    );
  }

  /**
   * Start all indexers automatically
   */
  async startAllIndexers(): Promise<void> {
    if (this.isRunning) {
      console.log('Indexers are already running');
      return;
    }

    try {
      console.log('Starting all indexers...');
      
      // Start referral fee indexer
      await this.referralFeeIndexer.startIndexing();
      
      this.isRunning = true;
      console.log('All indexers started successfully');
    } catch (error) {
      console.error('Error starting indexers:', error);
      throw error;
    }
  }

  /**
   * Check if indexers are running
   */
  isIndexersRunning(): boolean {
    return this.isRunning;
  }
} 
