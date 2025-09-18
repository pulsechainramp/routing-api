import axios, { AxiosInstance } from 'axios';
import { PrismaClient } from '../generated/prisma-client';
import { BlockchainService, TokensBridgingInitiatedEvent } from './BlockchainService';
import {
  OmniBridgeRequest,
  OmniBridgeExecution,
  OmniBridgeGraphQLResponse,
  OmniBridgeRequestsResponse,
  OmniBridgeExecutionsResponse,
  OmniBridgeTransactionCreate,
  OmniBridgeTransactionUpdate
} from '../types/omnibridge';

export class OmniBridgeTransactionService {
  private prisma: PrismaClient;
  private client: AxiosInstance;
  private blockchainService: BlockchainService;
  private ethereumGraphUrl: string;
  private pulsechainGraphUrl: string;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.blockchainService = new BlockchainService();
    this.ethereumGraphUrl = 'https://graph.ethereum.pulsechain.com/subgraphs/name/ethereum/bridge';
    this.pulsechainGraphUrl = 'https://graph.pulsechain.com/subgraphs/name/pulsechain/bridge';
    
    this.client = axios.create({
      timeout: 10000
    });
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
      return transactions.map(transaction => ({
        ...transaction,
        humanReadableAmount: this.formatWeiToHumanReadable(transaction.amount, transaction.tokenDecimals)
      }));
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
    try {
      // Validate inputs
      if (!this.blockchainService.validateTransactionHash(txHash)) {
        throw new Error('Invalid transaction hash format');
      }

      if (!this.blockchainService.validateNetworkId(networkId)) {
        throw new Error('Invalid network ID. Supported: 1 (Ethereum), 369 (PulseChain)');
      }

      // Parse the transaction logs to get the TokensBridgingInitiated event
      const bridgeEvent = await this.blockchainService.parseTokensBridgingInitiatedEvent(txHash, networkId);
      
      if (!bridgeEvent) {
        throw new Error('No TokensBridgingInitiated event found in transaction');
      }

      // Check if transaction already exists
      const existingTransaction = await this.getTransactionByMessageId(bridgeEvent.messageId);
      if (existingTransaction) {
        return existingTransaction;
      }

      // Get transaction details for timestamp
      const txDetails = await this.blockchainService.getTransactionDetails(txHash, networkId);
      
      // Determine direction based on network ID
      const sourceChainId = networkId;
      const targetChainId = networkId === 1 ? 369 : 1; // 1 -> 369, 369 -> 1

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
        sourceTimestamp: new Date(txDetails.timestamp * 1000),
        encodedData: undefined // We don't have this from the event
      });
    } catch (error) {
      console.error('Failed to create transaction from transaction hash:', error);
      throw new Error('Failed to create transaction from transaction hash');
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

      return transaction;
    } catch (error) {
      console.error('Failed to get transaction status:', error);
      throw new Error('Failed to get transaction status');
    }
  }
} 