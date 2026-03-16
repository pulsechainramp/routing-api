import axios, { AxiosInstance } from 'axios';
import { PrismaClient } from '../generated/prisma-client';
import { BlockchainService } from './BlockchainService';
import {
  OmniBridgeRequest,
  OmniBridgeExecution,
  OmniBridgeGraphQLResponse,
  OmniBridgeRequestsResponse,
  OmniBridgeExecutionsResponse,
  OmniBridgeTransactionCreate,
  OmniBridgeTransactionUpdate
} from '../types/omnibridge';

const BRIDGE_CACHE_MISS_ERROR = 'Transaction not found in bridge cache';
const SENDER_MISMATCH_ERROR = 'Transaction sender does not match authenticated wallet';
type BridgeStatusDetail = 'bridge_in_progress' | 'claim_required' | 'completed' | 'failed';

interface StatusAwareTransaction {
  status: string;
  sourceChainId: number;
  targetChainId: number;
  messageId: string;
  userAddress: string;
}

export class OmniBridgeTransactionService {
  private prisma: PrismaClient;
  private client: AxiosInstance;
  private blockchainService: BlockchainService;
  private ethereumGraphUrl: string;
  private pulsechainGraphUrl: string;
  private failedTransactionCache: Map<string, number>;
  private inflightTransactions: Map<string, Promise<any>>;
  private failureCacheTtlMs: number;
  private pulsechainTargetedLookupDisabledUntilMs: number;
  private pulsechainTargetedLookupFailureCount: number;

  constructor(prisma: PrismaClient, blockchainService: BlockchainService) {
    if (!blockchainService) {
      throw new Error('OmniBridgeTransactionService requires a BlockchainService instance');
    }
    this.prisma = prisma;
    this.blockchainService = blockchainService;
    this.ethereumGraphUrl = 'https://graph.ethereum.pulsechain.com/subgraphs/name/ethereum/bridge';
    this.pulsechainGraphUrl = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/bridge';
    
    this.client = axios.create({
      timeout: 10000
    });

    this.failureCacheTtlMs = Number(process.env.OMNI_MISS_TTL_MS ?? 10 * 60 * 1000);
    this.failedTransactionCache = new Map();
    this.inflightTransactions = new Map();
    this.pulsechainTargetedLookupDisabledUntilMs = 0;
    this.pulsechainTargetedLookupFailureCount = 0;
  }

  // Create a new bridge transaction from source chain data
  async createTransaction(data: OmniBridgeTransactionCreate) {
    try {
      // Format amount to ensure it's a valid string representation
      const formattedAmount = this.formatAmountForStorage(data.amount);
      
      return await this.prisma.omniBridgeTransaction.create({
        data: {
          messageId: data.messageId,
          userAddress: data.userAddress,
          sourceChainId: data.sourceChainId,
          targetChainId: data.targetChainId,
          sourceTxHash: data.sourceTxHash,
          tokenAddress: data.tokenAddress,
          tokenSymbol: data.tokenSymbol,
          tokenDecimals: data.tokenDecimals,
          amount: formattedAmount,
          sourceTimestamp: data.sourceTimestamp,
          encodedData: data.encodedData
        }
      });
    } catch (error) {
      console.error('Failed to create OmniBridge transaction:', error);
      console.log(data)
      throw new Error('Failed to create transaction');
    }
  }

  private getFailureCacheKey(txHash: string, networkId: number): string {
    return `${networkId}:${txHash.toLowerCase()}`;
  }

  private hasRecentFailure(cacheKey: string): boolean {
    const expiresAt = this.failedTransactionCache.get(cacheKey);
    if (!expiresAt) {
      return false;
    }

    if (Date.now() > expiresAt) {
      this.failedTransactionCache.delete(cacheKey);
      return false;
    }

    return true;
  }

  private rememberFailure(cacheKey: string): void {
    if (this.failureCacheTtlMs <= 0) {
      return;
    }

    this.failedTransactionCache.set(cacheKey, Date.now() + this.failureCacheTtlMs);
  }

  // Utility function to format amount for database storage
  private formatAmountForStorage(amount: string): string {
    try {
      // Remove any leading zeros and ensure it's a valid number string
      const cleanAmount = amount.replace(/^0+/, '') || '0';
      
      // Validate that it's a valid number
      if (!/^\d+$/.test(cleanAmount)) {
        throw new Error('Invalid amount format');
      }
      
      return cleanAmount;
    } catch (error) {
      console.error('Failed to format amount for storage:', error);
      return '0';
    }
  }

  // Update transaction with execution data
  async updateTransaction(messageId: string, data: OmniBridgeTransactionUpdate) {
    try {
      const updatedTransaction = await this.prisma.omniBridgeTransaction.update({
        where: { messageId },
        data: {
          targetTxHash: data.targetTxHash,
          status: data.status,
          targetTimestamp: data.targetTimestamp,
          updatedAt: new Date()
        }
      });
      
      // Add human-readable amount for consistency
      return {
        ...updatedTransaction,
        humanReadableAmount: this.formatWeiToHumanReadable(updatedTransaction.amount, updatedTransaction.tokenDecimals)
      };
    } catch (error) {
      console.error('Failed to update OmniBridge transaction:', error);
      throw new Error('Failed to update transaction');
    }
  }

  // Get transaction by message ID
  async getTransactionByMessageId(messageId: string) {
    try {
      const transaction = await this.prisma.omniBridgeTransaction.findUnique({
        where: { messageId }
      });
      
      if (transaction) {
        // Add human-readable amount for display
        return {
          ...transaction,
          humanReadableAmount: this.formatWeiToHumanReadable(transaction.amount, transaction.tokenDecimals)
        };
      }
      
      return transaction;
    } catch (error) {
      console.error('Failed to get transaction by message ID:', error);
      throw new Error('Failed to get transaction');
    }
  }

  // Utility function to convert wei to human readable format
  private formatWeiToHumanReadable(weiAmount: string, decimals: number): string {
    try {
      const { ethers } = require('ethers');
      return ethers.formatUnits(weiAmount, decimals);
    } catch (error) {
      console.error('Failed to convert wei to human readable:', error);
      return weiAmount;
    }
  }

  // Get all transactions for a user
  async getUserTransactions(userAddress: string, limit: number = 50, offset: number = 0) {
    try {
      const transactions = await this.prisma.omniBridgeTransaction.findMany({
        where: { userAddress },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset
      });
      
      // Add human-readable amounts for display
      const withAmounts = transactions.map(transaction => ({
        ...transaction,
        humanReadableAmount: this.formatWeiToHumanReadable(transaction.amount, transaction.tokenDecimals)
      }));

      return await this.enrichTransactionsWithStatusMeta(withAmounts as any[]);
    } catch (error) {
      console.error('Failed to get user transactions:', error);
      throw new Error('Failed to get user transactions');
    }
  }

  // Get pending transactions that need execution status updates
  async getPendingTransactions() {
    try {
      return await this.prisma.omniBridgeTransaction.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' }
      });
    } catch (error) {
      console.error('Failed to get pending transactions:', error);
      throw new Error('Failed to get pending transactions');
    }
  }

  // Fetch bridge requests from Ethereum GraphQL (ETH to PLS)
  async fetchEthereumRequests(userAddress: string, first: number = 1000, skip: number = 0): Promise<OmniBridgeRequest[]> {
    try {
      const query = `
        query getRequests($user: String!, $first: Int!, $skip: Int!) {
          requests: userRequests(
            where: { user: $user }
            orderBy: txHash
            orderDirection: desc
            first: $first
            skip: $skip
          ) {
            user: recipient
            txHash
            messageId
            timestamp
            amount
            token
            decimals
            symbol
            encodedData
            message {
              txHash
              messageId: msgId
              messageData: msgData
              signatures
            }
          }
        }
      `;

      const response = await this.client.post<OmniBridgeGraphQLResponse<OmniBridgeRequestsResponse>>(
        this.ethereumGraphUrl,
        {
          query,
          variables: { user: userAddress, first, skip }
        }
      );

      return response.data.data.requests;
    } catch (error) {
      console.error('Failed to fetch Ethereum requests:', error);
      throw new Error('Failed to fetch Ethereum requests');
    }
  }

  // Fetch bridge requests from PulseChain GraphQL (PLS to ETH)
  async fetchPulsechainRequests(userAddress: string, first: number = 1000, skip: number = 0): Promise<OmniBridgeRequest[]> {
    try {
      const query = `
        query getRequests($user: String!, $first: Int!, $skip: Int!) {
          requests: userRequests(
            where: { user: $user }
            orderBy: txHash
            orderDirection: desc
            first: $first
            skip: $skip
          ) {
            user: recipient
            txHash
            messageId
            timestamp
            amount
            token
            decimals
            symbol
            encodedData
            message {
              txHash
              messageId: msgId
              messageData: msgData
              signatures
            }
          }
        }
      `;

      const response = await this.client.post<OmniBridgeGraphQLResponse<OmniBridgeRequestsResponse>>(
        this.pulsechainGraphUrl,
        {
          query,
          variables: { user: userAddress, first, skip }
        }
      );

      return response.data.data.requests;
    } catch (error) {
      console.error('Failed to fetch PulseChain requests:', error);
      throw new Error('Failed to fetch PulseChain requests');
    }
  }

  // Fetch specific PulseChain requests by message IDs (PLS to ETH)
  async fetchPulsechainRequestsByMessageIds(
    userAddress: string,
    messageIds: string[],
    first: number = 1000,
    skip: number = 0
  ): Promise<OmniBridgeRequest[]> {
    try {
      const query = `
        query getRequestsByMessageIds($user: String!, $first: Int!, $skip: Int!, $messageIds: [Bytes!]) {
          requests: userRequests(
            where: { user: $user, messageId_in: $messageIds }
            orderBy: txHash
            orderDirection: desc
            first: $first
            skip: $skip
          ) {
            user: recipient
            txHash
            messageId
            timestamp
            amount
            token
            decimals
            symbol
            encodedData
            message {
              txHash
              messageId: msgId
              messageData: msgData
              signatures
            }
          }
        }
      `;

      const response = await this.client.post<OmniBridgeGraphQLResponse<OmniBridgeRequestsResponse>>(
        this.pulsechainGraphUrl,
        {
          query,
          variables: {
            user: userAddress,
            first,
            skip,
            messageIds,
          }
        }
      );

      return response.data.data.requests;
    } catch (error) {
      console.error('Failed to fetch PulseChain requests by message IDs:', error);
      throw new Error('Failed to fetch PulseChain requests by message IDs');
    }
  }

  // Fetch bridge executions from Ethereum GraphQL (PLS to ETH executions)
  async fetchEthereumExecutions(messageIds: string[], first: number = 1000, skip: number = 0): Promise<OmniBridgeExecution[]> {
    try {
      const query = `
        query getExecutions($first: Int!, $skip: Int!, $messageIds: [Bytes!]) {
          executions(
            where: { messageId_in: $messageIds }
            first: $first
            skip: $skip
            orderBy: txHash
            orderDirection: desc
          ) {
            txHash
            messageId
            token
            status
          }
        }
      `;

      const response = await this.client.post<OmniBridgeGraphQLResponse<OmniBridgeExecutionsResponse>>(
        this.ethereumGraphUrl,
        {
          query,
          variables: { first, skip, messageIds }
        }
      );

      return response.data.data.executions;
    } catch (error) {
      console.error('Failed to fetch Ethereum executions:', error);
      throw new Error('Failed to fetch Ethereum executions');
    }
  }

  // Fetch bridge executions from PulseChain GraphQL (ETH to PLS executions)
  async fetchPulsechainExecutions(messageIds: string[], first: number = 1000, skip: number = 0): Promise<OmniBridgeExecution[]> {
    try {
      const query = `
        query getExecutions($first: Int!, $skip: Int!, $messageIds: [Bytes!]) {
          executions(
            where: { messageId_in: $messageIds }
            first: $first
            skip: $skip
            orderBy: txHash
            orderDirection: desc
          ) {
            txHash
            messageId
            token
            status
          }
        }
      `;

      const response = await this.client.post<OmniBridgeGraphQLResponse<OmniBridgeExecutionsResponse>>(
        this.pulsechainGraphUrl,
        {
          query,
          variables: { first, skip, messageIds }
        }
      );

      return response.data.data.executions;
    } catch (error) {
      console.error('Failed to fetch PulseChain executions:', error);
      throw new Error('Failed to fetch PulseChain executions');
    }
  }

  // Process and sync user transactions (both directions)
  async syncUserTransactions(userAddress: string) {
    try {
      // Fetch all requests from both chains
      const [ethereumRequests, pulsechainRequests] = await Promise.all([
        this.fetchEthereumRequests(userAddress),
        this.fetchPulsechainRequests(userAddress)
      ]);
      
      // Process Ethereum requests (ETH to PLS)
      for (const request of ethereumRequests) {
        const existingTransaction = await this.getTransactionByMessageId(request.messageId);
        
        if (!existingTransaction) {
          await this.createTransaction({
            messageId: request.messageId,
            userAddress: userAddress,
            sourceChainId: 1, // Ethereum
            targetChainId: 369, // PulseChain
            sourceTxHash: request.txHash,
            tokenAddress: request.token,
            tokenSymbol: request.symbol,
            tokenDecimals: request.decimals,
            amount: request.amount,
            sourceTimestamp: new Date(parseInt(request.timestamp) * 1000),
            encodedData: request.encodedData
          });
        }
      }

      // Process PulseChain requests (PLS to ETH)
      for (const request of pulsechainRequests) {
        const existingTransaction = await this.getTransactionByMessageId(request.messageId);
        
        if (!existingTransaction) {
          await this.createTransaction({
            messageId: request.messageId,
            userAddress: userAddress,
            sourceChainId: 369, // PulseChain
            targetChainId: 1, // Ethereum
            sourceTxHash: request.txHash,
            tokenAddress: request.token,
            tokenSymbol: request.symbol,
            tokenDecimals: request.decimals,
            amount: request.amount,
            sourceTimestamp: new Date(parseInt(request.timestamp) * 1000),
            encodedData: request.encodedData
          });
        }
      }

      // Get all user transactions and update execution status
      const userTransactions = await this.getUserTransactions(userAddress, 1000, 0);
      const pendingTransactions = userTransactions.filter((tx: any) => tx.status === 'pending');

      // Group pending transactions by direction
      const ethToPlsPending = pendingTransactions.filter((tx: any) => tx.sourceChainId === 1);
      const plsToEthPending = pendingTransactions.filter((tx: any) => tx.sourceChainId === 369);

      // Update ETH to PLS executions
      if (ethToPlsPending.length > 0) {
        const messageIds = ethToPlsPending.map((tx: any) => tx.messageId);
        const executions = await this.fetchPulsechainExecutions(messageIds);
        
        for (const execution of executions) {
          await this.updateTransaction(execution.messageId, {
            targetTxHash: execution.txHash,
            status: execution.status ? 'executed' : 'failed',
            targetTimestamp: new Date()
          });
        }
      }

      // Update PLS to ETH executions
      if (plsToEthPending.length > 0) {
        const messageIds = plsToEthPending.map((tx: any) => tx.messageId);
        const executions = await this.fetchEthereumExecutions(messageIds);
        
        for (const execution of executions) {
          await this.updateTransaction(execution.messageId, {
            targetTxHash: execution.txHash,
            status: execution.status ? 'executed' : 'failed',
            targetTimestamp: new Date()
          });
        }
      }

      return await this.getUserTransactions(userAddress);
    } catch (error) {
      console.error('Failed to sync user transactions:', error);
      throw new Error('Failed to sync user transactions');
    }
  }

  // Create transaction from transaction hash and network ID (frontend sends tx hash and network)
  async createTransactionFromTxHash(txHash: string, networkId: number, userAddress: string) {
    const cacheKey = this.getFailureCacheKey(txHash, networkId);

    try {
      // Validate inputs
      if (!this.blockchainService.validateTransactionHash(txHash)) {
        throw new Error('Invalid transaction hash format');
      }

      if (!this.blockchainService.validateNetworkId(networkId)) {
        throw new Error('Invalid network ID. Supported: 1 (Ethereum), 369 (PulseChain)');
      }

      if (this.hasRecentFailure(cacheKey)) {
        throw new Error(BRIDGE_CACHE_MISS_ERROR);
      }

      if (this.inflightTransactions.has(cacheKey)) {
        return await this.inflightTransactions.get(cacheKey)!;
      }

      const work = (async () => {
        const receipt = await this.blockchainService.getTransactionReceipt(txHash, networkId);

        if (!receipt) {
          this.rememberFailure(cacheKey);
          throw new Error('Transaction receipt not found');
        }

        const bridgeEvent = this.blockchainService.extractTokensBridgingInitiatedEvent(receipt, networkId);

        if (!bridgeEvent) {
          this.rememberFailure(cacheKey);
          throw new Error('No TokensBridgingInitiated event found in transaction');
        }

        const normalizedClaimedAddress = userAddress.toLowerCase();
        const normalizedEventSender = bridgeEvent.sender.toLowerCase();
        const normalizedTxOrigin = (receipt.from ?? '').toLowerCase();

        let expectedSender = normalizedEventSender;

        if (this.blockchainService.isBridgeManagerContract(networkId, normalizedEventSender)) {
          if (!normalizedTxOrigin) {
            throw new Error('Unable to determine transaction origin');
          }
          expectedSender = normalizedTxOrigin;
        }

        if (expectedSender !== normalizedClaimedAddress) {
          throw new Error(SENDER_MISMATCH_ERROR);
        }

        // Check if transaction already exists
        const existingTransaction = await this.getTransactionByMessageId(bridgeEvent.messageId);
        if (existingTransaction) {
          return existingTransaction;
        }

        // Determine direction based on network ID
        const sourceChainId = networkId;
        const targetChainId = networkId === 1 ? 369 : 1; // 1 -> 369, 369 -> 1

        const timestamp = await this.blockchainService.getBlockTimestamp(BigInt(receipt.blockNumber), networkId);

        // Get token information from the OmniBridge service
        const omniBridgeService = new (await import('./OmniBridgeService')).OmniBridgeService();
        const currencies = await omniBridgeService.getSupportedCurrencies();
        
        // Find token info (handle native tokens with zero address)
        let tokenInfo = currencies.find(currency => 
          currency.address.toLowerCase() === bridgeEvent.token.toLowerCase() && 
          currency.chainId === networkId
        );

        // If not found and token is zero address, look for native token
        if (!tokenInfo && bridgeEvent.token.toLowerCase() === '0x0000000000000000000000000000000000000000') {
          tokenInfo = currencies.find(currency => 
            currency.chainId === networkId && 
            (currency.symbol === 'ETH' || currency.symbol === 'PLS')
          );
        }

        if (!tokenInfo) {
          throw new Error('Token not found in supported currencies');
        }

        this.failedTransactionCache.delete(cacheKey);

        // Create the transaction record
        return await this.createTransaction({
          messageId: bridgeEvent.messageId,
          userAddress: userAddress,
          sourceChainId,
          targetChainId,
          sourceTxHash: txHash,
          tokenAddress: bridgeEvent.token,
          tokenSymbol: tokenInfo.symbol,
          tokenDecimals: tokenInfo.decimals,
          amount: bridgeEvent.value,
          sourceTimestamp: new Date(timestamp * 1000),
          encodedData: undefined // We don't have this from the event
        });
      })();

      this.inflightTransactions.set(cacheKey, work);

      return await work;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === BRIDGE_CACHE_MISS_ERROR || error.message === SENDER_MISMATCH_ERROR)
      ) {
        throw error;
      }

      console.error('Failed to create transaction from transaction hash:', error);
      throw new Error('Failed to create transaction from transaction hash');
    } finally {
      this.inflightTransactions.delete(cacheKey);
    }
  }

  // Create transaction from message ID only (frontend sends only message ID)
  async createTransactionFromMessageId(messageId: string, userAddress: string) {
    try {
      // Check if transaction already exists
      const existingTransaction = await this.getTransactionByMessageId(messageId);
      if (existingTransaction) {
        return existingTransaction;
      }

      // Try to find the request in both chains
      let request: OmniBridgeRequest | null = null;
      let sourceChainId = 0;
      let targetChainId = 0;

      // Try Ethereum first (ETH to PLS)
      try {
        const ethereumRequests = await this.fetchEthereumRequests(userAddress, 1000, 0);
        const ethRequest = ethereumRequests.find(req => req.messageId === messageId);
        if (ethRequest) {
          request = ethRequest;
          sourceChainId = 1; // Ethereum
          targetChainId = 369; // PulseChain
        }
      } catch (error) {
        console.error('Failed to fetch from Ethereum:', error);
      }

      // Try PulseChain if not found in Ethereum (PLS to ETH)
      if (!request) {
        try {
          const pulsechainRequests = await this.fetchPulsechainRequests(userAddress, 1000, 0);
          const plsRequest = pulsechainRequests.find(req => req.messageId === messageId);
          if (plsRequest) {
            request = plsRequest;
            sourceChainId = 369; // PulseChain
            targetChainId = 1; // Ethereum
          }
        } catch (error) {
          console.error('Failed to fetch from PulseChain:', error);
        }
      }

      if (!request) {
        throw new Error('Transaction not found in either chain');
      }

      // Create the transaction record
      return await this.createTransaction({
        messageId: request.messageId,
        userAddress: userAddress,
        sourceChainId,
        targetChainId,
        sourceTxHash: request.txHash,
        tokenAddress: request.token,
        tokenSymbol: request.symbol,
        tokenDecimals: request.decimals,
        amount: request.amount,
        sourceTimestamp: new Date(parseInt(request.timestamp) * 1000),
        encodedData: request.encodedData
      });
    } catch (error) {
      console.error('Failed to create transaction from message ID:', error);
      throw new Error('Failed to create transaction from message ID');
    }
  }

  // Get transaction status by message ID (handles both directions)
  async getTransactionStatus(messageId: string) {
    try {
      let transaction = await this.getTransactionByMessageId(messageId);
      
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      // If transaction is pending, try to fetch latest execution status
      if (transaction.status === 'pending') {
        try {
          let executions: OmniBridgeExecution[] = [];
          
          // Determine which chain to query based on direction
          if (transaction.sourceChainId === 1 && transaction.targetChainId === 369) {
            // ETH to PLS - check PulseChain executions
            executions = await this.fetchPulsechainExecutions([messageId]);
          } else if (transaction.sourceChainId === 369 && transaction.targetChainId === 1) {
            // PLS to ETH - check Ethereum executions
            executions = await this.fetchEthereumExecutions([messageId]);
          }
          
          if (executions.length > 0) {
            const execution = executions[0];
            transaction = await this.updateTransaction(messageId, {
              targetTxHash: execution.txHash,
              status: execution.status ? 'executed' : 'failed',
              targetTimestamp: new Date()
            });
          }
        } catch (error) {
          console.error('Failed to fetch execution status:', error);
          // Continue with existing transaction data
        }
      }

      const [enrichedTransaction] = await this.enrichTransactionsWithStatusMeta([transaction as any]);
      return enrichedTransaction ?? transaction;
    } catch (error) {
      console.error('Failed to get transaction status:', error);
      throw new Error('Failed to get transaction status');
    }
  }

  private hasRelaySignatures(request: OmniBridgeRequest): boolean {
    const signatures = request.message?.signatures;
    if (typeof signatures !== 'string') {
      return false;
    }

    const normalized = signatures.trim().toLowerCase();
    return normalized.length > 2 && normalized !== '0x';
  }

  private getPositiveEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return Math.floor(parsed);
  }

  private getNonNegativeEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }

    return Math.floor(parsed);
  }

  private getTargetedLookupRetryDelayMs(failureCount: number): number {
    const baseDelayMs = this.getPositiveEnvInt(
      'OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_BASE_MS',
      30_000
    );
    const maxDelayMs = this.getPositiveEnvInt(
      'OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_MAX_MS',
      900_000
    );

    const exponent = Math.max(failureCount - 1, 0);
    const scaledDelay = baseDelayMs * 2 ** exponent;
    return Math.min(scaledDelay, maxDelayMs);
  }

  private isTargetedLookupDisabled(nowMs: number = Date.now()): boolean {
    return this.pulsechainTargetedLookupDisabledUntilMs > nowMs;
  }

  private markTargetedLookupSuccess(): void {
    this.pulsechainTargetedLookupFailureCount = 0;
    this.pulsechainTargetedLookupDisabledUntilMs = 0;
  }

  private markTargetedLookupFailure(error: unknown): void {
    this.pulsechainTargetedLookupFailureCount += 1;
    const retryDelayMs = this.getTargetedLookupRetryDelayMs(
      this.pulsechainTargetedLookupFailureCount
    );
    this.pulsechainTargetedLookupDisabledUntilMs = Date.now() + retryDelayMs;
    console.error(
      `Targeted claimability lookup failed; disabling targeted lookup for ${retryDelayMs}ms:`,
      error
    );
  }

  private chunkArray<T>(values: T[], chunkSize: number): T[][] {
    if (values.length === 0) {
      return [];
    }

    const chunks: T[][] = [];
    for (let i = 0; i < values.length; i += chunkSize) {
      chunks.push(values.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async fetchPulsechainRequestsByMessageIdsChunked(
    userAddress: string,
    messageIds: string[]
  ): Promise<OmniBridgeRequest[]> {
    const chunkSize = this.getPositiveEnvInt(
      'OMNIBRIDGE_CLAIMABILITY_MESSAGE_CHUNK_SIZE',
      100
    );

    const uniqueIds = Array.from(new Set(messageIds.map((id) => id.toLowerCase())));
    const chunks = this.chunkArray(uniqueIds, chunkSize);

    const requests: OmniBridgeRequest[] = [];
    for (const chunk of chunks) {
      const first = Math.max(chunk.length, 1);
      const chunkRequests = await this.fetchPulsechainRequestsByMessageIds(
        userAddress,
        chunk,
        first,
        0
      );
      requests.push(...chunkRequests);
    }

    return requests;
  }

  private async scanPulsechainRequestsForMessageIds(
    userAddress: string,
    requestedIds: Set<string>
  ): Promise<OmniBridgeRequest[]> {
    const pageSize = this.getPositiveEnvInt(
      'OMNIBRIDGE_CLAIMABILITY_PAGE_SIZE',
      1000
    );
    const maxPages = this.getNonNegativeEnvInt(
      'OMNIBRIDGE_CLAIMABILITY_MAX_PAGES',
      0
    );

    const remaining = new Set(requestedIds);
    const requests: OmniBridgeRequest[] = [];

    let page = 0;
    while (remaining.size > 0 && (maxPages === 0 || page < maxPages)) {
      const skip = page * pageSize;
      const batch = await this.fetchPulsechainRequests(userAddress, pageSize, skip);

      if (!batch.length) {
        break;
      }

      for (const request of batch) {
        const messageId = request.messageId.toLowerCase();
        if (!remaining.has(messageId)) {
          continue;
        }

        requests.push(request);
        remaining.delete(messageId);

        if (remaining.size === 0) {
          break;
        }
      }

      if (batch.length < pageSize) {
        break;
      }

      page += 1;
    }

    if (remaining.size > 0 && maxPages > 0) {
      console.warn(
        `Claimability fallback scan reached page cap (${maxPages}) with ${remaining.size} message IDs unresolved`
      );
    }

    return requests;
  }

  private async getClaimableMessageIdSet(userAddress: string, messageIds: string[]): Promise<Set<string>> {
    if (!userAddress || messageIds.length === 0) {
      return new Set();
    }

    const requestedIds = new Set(messageIds.map((id) => id.toLowerCase()));

    try {
      let requests: OmniBridgeRequest[] = [];

      if (!this.isTargetedLookupDisabled()) {
        try {
          // Preferred path: query only specific message IDs to avoid pagination blind spots.
          requests = await this.fetchPulsechainRequestsByMessageIdsChunked(
            userAddress,
            Array.from(requestedIds)
          );
          this.markTargetedLookupSuccess();
        } catch (targetedError) {
          this.markTargetedLookupFailure(targetedError);
          requests = await this.scanPulsechainRequestsForMessageIds(userAddress, requestedIds);
        }
      } else {
        requests = await this.scanPulsechainRequestsForMessageIds(userAddress, requestedIds);
      }

      const claimable = requests
        .filter((request) => requestedIds.has(request.messageId.toLowerCase()))
        .filter((request) => this.hasRelaySignatures(request))
        .map((request) => request.messageId.toLowerCase());

      return new Set(claimable);
    } catch (error) {
      console.error('Failed to fetch PulseChain claimability status:', error);
      return new Set();
    }
  }

  private decorateTransactionStatus<T extends StatusAwareTransaction>(
    transaction: T,
    claimableMessageIds: Set<string>
  ): T & { statusDetail: BridgeStatusDetail; isClaimable: boolean } {
    const isPending = transaction.status === 'pending';
    const isPulseToEth =
      transaction.sourceChainId === 369 && transaction.targetChainId === 1;
    const isClaimable =
      isPending &&
      isPulseToEth &&
      claimableMessageIds.has(transaction.messageId.toLowerCase());

    let statusDetail: BridgeStatusDetail = 'bridge_in_progress';
    if (transaction.status === 'executed') {
      statusDetail = 'completed';
    } else if (transaction.status === 'failed') {
      statusDetail = 'failed';
    } else if (isClaimable) {
      statusDetail = 'claim_required';
    }

    return {
      ...transaction,
      statusDetail,
      isClaimable,
    };
  }

  private async enrichTransactionsWithStatusMeta<T extends StatusAwareTransaction>(
    transactions: T[]
  ): Promise<Array<T & { statusDetail: BridgeStatusDetail; isClaimable: boolean }>> {
    if (!transactions.length) {
      return [];
    }

    const pendingPlsToEthByUser = new Map<string, string[]>();

    transactions.forEach((transaction) => {
      const isPendingPlsToEth =
        transaction.status === 'pending' &&
        transaction.sourceChainId === 369 &&
        transaction.targetChainId === 1;

      if (!isPendingPlsToEth || !transaction.userAddress) {
        return;
      }

      const user = transaction.userAddress.toLowerCase();
      const existing = pendingPlsToEthByUser.get(user) ?? [];
      existing.push(transaction.messageId);
      pendingPlsToEthByUser.set(user, existing);
    });

    const claimableMessageIds = new Set<string>();

    const claimabilityLookups = Array.from(pendingPlsToEthByUser.entries()).map(
      async ([userAddress, messageIds]) => {
        const claimableForUser = await this.getClaimableMessageIdSet(userAddress, messageIds);
        claimableForUser.forEach((id) => claimableMessageIds.add(id));
      }
    );

    if (claimabilityLookups.length > 0) {
      await Promise.all(claimabilityLookups);
    }

    return transactions.map((transaction) =>
      this.decorateTransactionStatus(transaction, claimableMessageIds)
    );
  }
}
