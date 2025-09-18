import { ethers } from 'ethers';
import OmniBridgeABI from '../abis/OmniBridge.json';

export interface TransactionLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

export interface TokensBridgingInitiatedEvent {
  token: string;
  sender: string;
  value: string;
  messageId: string;
}

export class BlockchainService {
  private ethProvider: ethers.JsonRpcProvider;
  private plsProvider: ethers.JsonRpcProvider;
  private omniBridgeInterface: ethers.Interface;

  constructor() {
    this.ethProvider = new ethers.JsonRpcProvider('https://eth-mainnet.public.blastapi.io');
    this.plsProvider = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
    this.omniBridgeInterface = new ethers.Interface(OmniBridgeABI);
  }

  // Get provider based on network ID
  private getProvider(networkId: number): ethers.JsonRpcProvider {
    switch (networkId) {
      case 1: // Ethereum
        return this.ethProvider;
      case 369: // PulseChain
        return this.plsProvider;
      default:
        throw new Error(`Unsupported network ID: ${networkId}`);
    }
  }

  // Get transaction receipt
  async getTransactionReceipt(txHash: string, networkId: number): Promise<ethers.TransactionReceipt | null> {
    try {
      const provider = this.getProvider(networkId);
      return await provider.getTransactionReceipt(txHash);
    } catch (error) {
      console.error('Failed to get transaction receipt:', error);
      throw new Error('Failed to get transaction receipt');
    }
  }

  // Parse transaction logs to find TokensBridgingInitiated event
  async parseTokensBridgingInitiatedEvent(txHash: string, networkId: number): Promise<TokensBridgingInitiatedEvent | null> {
    try {
      const receipt = await this.getTransactionReceipt(txHash, networkId);
      
      if (!receipt) {
        throw new Error('Transaction receipt not found');
      }

      // Find the TokensBridgingInitiated event in the logs
      for (const log of receipt.logs) {
        try {
          // Try to parse the log as TokensBridgingInitiated event
          const parsedLog = this.omniBridgeInterface.parseLog({
            topics: log.topics,
            data: log.data
          });

          if (parsedLog && parsedLog.name === 'TokensBridgingInitiated') {
            return {
              token: parsedLog.args[0] as string,
              sender: parsedLog.args[1] as string,
              value: parsedLog.args[2].toString(),
              messageId: parsedLog.args[3] as string
            };
          }
        } catch (parseError) {
          // This log is not a TokensBridgingInitiated event, continue to next log
          continue;
        }
      }

      // No TokensBridgingInitiated event found
      return null;
    } catch (error) {
      console.error('Failed to parse TokensBridgingInitiated event:', error);
      throw new Error('Failed to parse bridge event');
    }
  }

  // Get transaction details
  async getTransactionDetails(txHash: string, networkId: number) {
    try {
      const provider = this.getProvider(networkId);
      const [transaction, receipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash)
      ]);

      if (!transaction || !receipt) {
        throw new Error('Transaction not found');
      }

      return {
        transaction,
        receipt,
        blockNumber: receipt.blockNumber,
        timestamp: await this.getBlockTimestamp(BigInt(receipt.blockNumber), networkId)
      };
    } catch (error) {
      console.error('Failed to get transaction details:', error);
      throw new Error('Failed to get transaction details');
    }
  }

  // Get block timestamp
  async getBlockTimestamp(blockNumber: bigint, networkId: number): Promise<number> {
    try {
      const provider = this.getProvider(networkId);
      const block = await provider.getBlock(blockNumber);
      return Number(block?.timestamp) || 0;
    } catch (error) {
      console.error('Failed to get block timestamp:', error);
      return 0;
    }
  }

  // Validate transaction hash format
  validateTransactionHash(txHash: string): boolean {
    return /^0x[a-fA-F0-9]{64}$/.test(txHash);
  }

  // Validate network ID
  validateNetworkId(networkId: number): boolean {
    return networkId === 1 || networkId === 369;
  }
} 