import { PrismaClient } from '../generated/prisma-client';
import { IndexingStateResponse } from '../types/referral';
import config from '../config';

export abstract class IndexingService {
  protected prisma: PrismaClient;
  protected indexerName: string;

  constructor(prisma: PrismaClient, indexerName: string) {
    this.prisma = prisma;
    this.indexerName = indexerName;
  }

  getIndexerStartBlock(): number {
    return this.indexerName === config.ReferralFeeIndexerName ? config.ReferralFeeIndexStartBlock : 0;
  }

  /**
   * Get or create indexing state for a specific indexer
   */
  async getOrCreateIndexingState(): Promise<IndexingStateResponse> {
    try {
      let indexingState = await this.prisma.indexingState.findUnique({
        where: { indexerName: this.indexerName }
      });

      if (!indexingState) {
        indexingState = await this.prisma.indexingState.create({
          data: {
            indexerName: this.indexerName,
            lastIndexedBlock: this.getIndexerStartBlock(),
            isActive: false
          }
        });
      }

      return {
        id: indexingState.id,
        indexerName: indexingState.indexerName,
        lastIndexedBlock: indexingState.lastIndexedBlock,
        lastIndexedAt: indexingState.lastIndexedAt.toISOString(),
        isActive: indexingState.isActive,
        createdAt: indexingState.createdAt.toISOString(),
        updatedAt: indexingState.updatedAt.toISOString()
      };
    } catch (error) {
      console.error('Error getting or creating indexing state:', error);
      throw error;
    }
  }

  /**
   * Update the last indexed block number
   */
  async updateLastIndexedBlock(blockNumber: number): Promise<void> {
    try {
      await this.prisma.indexingState.update({
        where: { indexerName: this.indexerName },
        data: {
          lastIndexedBlock: blockNumber,
          lastIndexedAt: new Date()
        }
      });
    } catch (error) {
      console.error('Error updating last indexed block:', error);
      throw error;
    }
  }

  /**
   * Set indexing active status
   */
  async setIndexingActive(isActive: boolean): Promise<void> {
    try {
      await this.prisma.indexingState.update({
        where: { indexerName: this.indexerName },
        data: {
          isActive,
          updatedAt: new Date()
        }
      });
    } catch (error) {
      console.error('Error setting indexing active status:', error);
      throw error;
    }
  }

  /**
   * Get current indexing state
   */
  async getIndexingState(): Promise<IndexingStateResponse | null> {
    try {
      const indexingState = await this.prisma.indexingState.findUnique({
        where: { indexerName: this.indexerName }
      });

      if (!indexingState) {
        return null;
      }

      return {
        id: indexingState.id,
        indexerName: indexingState.indexerName,
        lastIndexedBlock: indexingState.lastIndexedBlock,
        lastIndexedAt: indexingState.lastIndexedAt.toISOString(),
        isActive: indexingState.isActive,
        createdAt: indexingState.createdAt.toISOString(),
        updatedAt: indexingState.updatedAt.toISOString()
      };
    } catch (error) {
      console.error('Error getting indexing state:', error);
      throw error;
    }
  }

  /**
   * Get the last indexed block number
   */
  async getLastIndexedBlock(): Promise<number> {
    const indexingState = await this.getIndexingState();
    return indexingState?.lastIndexedBlock || 0;
  }

  /**
   * Check if indexing is currently active
   */
  async isIndexingActive(): Promise<boolean> {
    const indexingState = await this.getIndexingState();
    return indexingState?.isActive || false;
  }
} 