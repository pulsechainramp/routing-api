import { ethers } from 'ethers';
import { ReferralFeeService } from './ReferralFeeService';
import { IndexingService } from './IndexingService';
import { ReferralFeeUpdateEvent } from '../types/referral';
import config from '../config';

export class ReferralFeeIndexer extends IndexingService {
  private provider: ethers.JsonRpcProvider;
  private affiliateRouterContract: ethers.Contract;
  private referralFeeService: ReferralFeeService;
  private isIndexing: boolean = false;
  private pollingInterval: number = 5000; // 5 seconds
  private isInitialScanComplete: boolean = false;
  private blockRange: number = 1000;

  constructor(
    rpcUrl: string,
    affiliateRouterAddress: string,
    referralFeeService: ReferralFeeService,
    prisma: any,
    indexerName: string = config.ReferralFeeIndexerName
  ) {
    super(prisma, indexerName);
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.affiliateRouterContract = new ethers.Contract(
      affiliateRouterAddress,
      ['event ReferralFeeAmountUpdated(address referrer, address token, uint256 amount)'],
      this.provider
    );
    this.referralFeeService = referralFeeService;
  }

  /**
   * Start indexing referral fee events
   */
  async startIndexing(): Promise<void> {
    if (this.isIndexing) {
      console.log('Referral fee indexing is already running');
      return;
    }

    this.isIndexing = true;
    console.log('Starting referral fee indexing...');

    try {
      console.log('Referral fee indexing started');

      // Phase 1: Scan from last indexed block to current block
      await this.performInitialScan();
      // Set indexing as active in database
      await this.setIndexingActive(true);

      // Phase 2: Start polling for new blocks
      this.startPolling();
    } catch (error) {
      console.error('Error starting indexing:', error);
      this.isIndexing = false;
      await this.setIndexingActive(false);
      throw error;
    }
  }

  /**
   * Stop indexing referral fee events
   */
  async stopIndexing(): Promise<void> {
    this.isIndexing = false;
    this.isInitialScanComplete = false;
    console.log('Stopping referral fee indexing...');

    try {
      await this.setIndexingActive(false);
    } catch (error) {
      console.error('Error stopping indexing:', error);
    }
  }

  /**
   * Phase 1: Scan from last indexed block to current block
   */
  private async performInitialScan(): Promise<void> {
    try {
      // Get or create indexing state
      const indexingState = await this.getOrCreateIndexingState();
      const lastIndexedBlock = indexingState.lastIndexedBlock;
      
      // Get current block number
      const currentBlock = await this.provider.getBlockNumber();
      
      if (currentBlock <= lastIndexedBlock) {
        console.log(`No new blocks to scan. Last indexed: ${lastIndexedBlock}, Current: ${currentBlock}`);
        this.isInitialScanComplete = true;
        return;
      }

      console.log(`Performing initial scan from block ${lastIndexedBlock + 1} to ${currentBlock}`);

      // Process blocks in batches to avoid overwhelming the RPC
      for (let blockNumber = lastIndexedBlock + 1; blockNumber <= currentBlock; blockNumber += this.blockRange) {
        const endBlock = Math.min(blockNumber + this.blockRange - 1, currentBlock);
        await this.processBlockRange(blockNumber, endBlock);
        
        // Update the last indexed block after each batch
        await this.updateLastIndexedBlock(endBlock);
        
        console.log(`Processed blocks ${blockNumber} to ${endBlock}`);
      }

      console.log(`Initial scan completed. Indexed up to block ${currentBlock}`);
      this.isInitialScanComplete = true;
    } catch (error) {
      console.error('Error during initial scan:', error);
      throw error;
    }
  }

  /**
   * Start polling for new blocks (Phase 2)
   */
  private startPolling(): void {
    if (!this.isIndexing || !this.isInitialScanComplete) return;

    console.log('Starting polling for new blocks...');

    this.pollForNewBlocks()
      .then(() => {
        // Schedule next poll
        setTimeout(() => this.startPolling(), this.pollingInterval);
      })
      .catch((error) => {
        console.error('Error during polling:', error);
        // Continue polling even if there's an error
        setTimeout(() => this.startPolling(), this.pollingInterval);
      });
  }

  /**
   * Poll for new blocks and process referral fee events
   */
  private async pollForNewBlocks(): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const indexingState = await this.getIndexingState();
      
      if (!indexingState || currentBlock <= indexingState.lastIndexedBlock) {
        return; // No new blocks
      }

      console.log(`Processing new blocks ${indexingState.lastIndexedBlock + 1} to ${currentBlock}`);

      // Process blocks in batches
      const batchSize = 10;
      for (let blockNumber = indexingState.lastIndexedBlock + 1; blockNumber <= currentBlock; blockNumber += batchSize) {
        const endBlock = Math.min(blockNumber + batchSize - 1, currentBlock);
        await this.processBlockRange(blockNumber, endBlock);
        
        // Update the last indexed block after each batch
        await this.updateLastIndexedBlock(endBlock);
      }

      console.log(`Polling completed. Indexed up to block ${currentBlock}`);
    } catch (error) {
      console.error('Error polling for new blocks:', error);
    }
  }

  /**
   * Process a range of blocks for referral fee events
   */
  private async processBlockRange(startBlock: number, endBlock: number): Promise<void> {
    try {
      // Get logs for ReferralFeeAmountUpdated events in the block range
      const logs = await this.affiliateRouterContract.queryFilter(
        this.affiliateRouterContract.filters.ReferralFeeAmountUpdated(),
        startBlock,
        endBlock
      );

      if (logs.length > 0) {
        console.log(`Found ${logs.length} ReferralFeeAmountUpdated events in blocks ${startBlock}-${endBlock}`);
      }

      // Process each event
      for (const log of logs) {
        try {
          const event = await this.parseLogToEvent(log);
          if (event) {
            console.log(`Processing referral fee event: ${event.referrer} -> ${event.token}: Raw amount: ${event.amount}`);
            await this.referralFeeService.processReferralFeeEvent(event);
            console.log(`Processed referral fee event: ${event.referrer} -> ${event.token}: ${event.amount}`);
          }
        } catch (error) {
          console.error('Error processing individual event:', error);
          // Continue processing other events
        }
      }
    } catch (error) {
      console.error(`Error processing blocks ${startBlock}-${endBlock}:`, error);
    }
  }

  /**
   * Parse a log entry to ReferralFeeUpdateEvent
   */
  private async parseLogToEvent(log: ethers.Log): Promise<ReferralFeeUpdateEvent | null> {
    try {
      // Parse the log using the contract interface
      const parsedLog = this.affiliateRouterContract.interface.parseLog({
        topics: log.topics,
        data: log.data
      });

      if (parsedLog && parsedLog.name === 'ReferralFeeAmountUpdated') {
        // Fetch block details to get timestamp
        const block = await this.provider.getBlock(log.blockNumber);
        const timestamp = block ? block.timestamp : 0;

        return {
          referrer: parsedLog.args[0] as string,
          token: parsedLog.args[1] as string,
          amount: parsedLog.args[2].toString(),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.index,
          timestamp: Number(timestamp)
        };
      }

      return null;
    } catch (error) {
      console.error('Error parsing log:', error);
      return null;
    }
  }

  /**
   * Process a specific transaction for referral fee events
   */
  async processTransaction(txHash: string): Promise<void> {
    try {
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) {
        console.log(`Transaction receipt not found for ${txHash}`);
        return;
      }

      // Find ReferralFeeAmountUpdated events in the transaction
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === (this.affiliateRouterContract.target as string).toLowerCase()) {
          const event = await this.parseLogToEvent(log);
          if (event) {
            await this.referralFeeService.processReferralFeeEvent(event);
            console.log(`Processed referral fee event from transaction ${txHash}: ${event.referrer} -> ${event.token}: ${event.amount}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing transaction ${txHash}:`, error);
    }
  }

  /**
   * Get indexing status
   */
  async getIndexingStatus(): Promise<{ 
    isIndexing: boolean; 
    isInitialScanComplete: boolean;
    lastIndexedBlock: number;
    isActive: boolean;
  }> {
    const indexingState = await this.getIndexingState();
    
    return {
      isIndexing: this.isIndexing,
      isInitialScanComplete: this.isInitialScanComplete,
      lastIndexedBlock: indexingState?.lastIndexedBlock || 0,
      isActive: indexingState?.isActive || false
    };
  }

  /**
   * Set polling interval
   */
  setPollingInterval(interval: number): void {
    this.pollingInterval = interval;
    console.log(`Polling interval set to ${interval}ms`);
  }

  /**
   * Manually trigger a scan from a specific block
   */
  async scanFromBlock(fromBlock: number): Promise<void> {
    try {
      console.log(`Manually scanning from block ${fromBlock}`);
      
      // Update the indexing state to start from the specified block
      await this.updateLastIndexedBlock(fromBlock - 1);
      
      // Perform the scan
      await this.performInitialScan();
    } catch (error) {
      console.error('Error during manual scan:', error);
      throw error;
    }
  }
} 