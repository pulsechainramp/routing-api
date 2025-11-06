import { ethers } from 'ethers';
import Bottleneck from 'bottleneck';
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
  private ethLimiter: Bottleneck;
  private plsLimiter: Bottleneck;

  constructor() {
    this.ethProvider = new ethers.JsonRpcProvider('https://eth-mainnet.public.blastapi.io');
    this.plsProvider = new ethers.JsonRpcProvider('https://rpc.pulsechain.com');
    this.omniBridgeInterface = new ethers.Interface(OmniBridgeABI);

    const ethConcurrency = Math.max(1, Number(process.env.RPC_ETH_MAX_CONCURRENCY ?? 5));
    const plsConcurrency = Math.max(1, Number(process.env.RPC_PLS_MAX_CONCURRENCY ?? 5));

    this.ethLimiter = new Bottleneck({ maxConcurrent: ethConcurrency });
    this.plsLimiter = new Bottleneck({ maxConcurrent: plsConcurrency });
  }

  private getLimiter(networkId: number): Bottleneck {
    switch (networkId) {
      case 1:
        return this.ethLimiter;
      case 369:
        return this.plsLimiter;
      default:
        throw new Error(`Unsupported network ID: ${networkId}`);
    }
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
      const limiter = this.getLimiter(networkId);
      return await limiter.schedule(() => provider.getTransactionReceipt(txHash));
    } catch (error) {
      console.error('Failed to get transaction receipt:', error);
      throw new Error('Failed to get transaction receipt');
    }
  }

  extractTokensBridgingInitiatedEvent(receipt: ethers.TransactionReceipt): TokensBridgingInitiatedEvent | null {
    for (const log of receipt.logs) {
      try {
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
      } catch {
        continue;
      }
    }

    return null;
  }

  // Get block timestamp
  async getBlockTimestamp(blockNumber: bigint, networkId: number): Promise<number> {
    try {
      const provider = this.getProvider(networkId);
      const limiter = this.getLimiter(networkId);
      const block = await limiter.schedule(() => provider.getBlock(blockNumber));
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
