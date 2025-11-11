import { ethers, type Provider } from 'ethers';
import Bottleneck from 'bottleneck';
import OmniBridgeABI from '../abis/OmniBridge.json';

const DEFAULT_OMNIBRIDGE_CONTRACTS: Record<number, string[]> = {
  1: [
    // Ethereum Foreign OmniBridge proxy stack
    '0x88ad09518695c6c3712ac10a214be5109a655671',
    '0xe20e337db2a00b1c37139c873b92a0aad3f468bf',
    // PulseBridge BridgeManager contracts (emit TokensBridgingInitiated)
    '0x1715a3E4A142d8b698131108995174F37aEBA10D',
    '0x8AC4ae65b3656e26dC4e0e69108B392283350f55'
  ],
  369: [
    // PulseChain Home OmniBridge contracts
    '0x4fd0aaa7506f3d9cb8274bdb946ec42a1b8751ef',
    '0x0e18d0d556b652794ef12bf68b2dc857ef5f3996'
  ]
};

const BRIDGE_MANAGER_CONTRACTS: Record<number, string[]> = {
  1: [
    '0x1715a3E4A142d8b698131108995174F37aEBA10D',
    '0x8AC4ae65b3656e26dC4e0e69108B392283350f55'
  ],
  369: []
};

const OMNIBRIDGE_ENV_KEYS: Record<number, string> = {
  1: 'OMNIBRIDGE_ETH_CONTRACTS',
  369: 'OMNIBRIDGE_PLS_CONTRACTS'
};

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
  private ethProvider: Provider;
  private plsProvider: Provider;
  private omniBridgeInterface: ethers.Interface;
  private ethLimiter: Bottleneck;
  private plsLimiter: Bottleneck;
  private omniBridgeContracts: Map<number, Set<string>>;
  private bridgeManagerContracts: Map<number, Set<string>>;

  constructor(
    ethProvider: Provider,
    pulsechainProvider: Provider
  ) {
    if (!ethProvider) {
      throw new Error('BlockchainService requires an Ethereum provider');
    }
    if (!pulsechainProvider) {
      throw new Error('BlockchainService requires a PulseChain provider');
    }

    this.ethProvider = ethProvider;
    this.plsProvider = pulsechainProvider;
    this.omniBridgeInterface = new ethers.Interface(OmniBridgeABI);

    const ethConcurrency = Math.max(1, Number(process.env.RPC_ETH_MAX_CONCURRENCY ?? 5));
    const plsConcurrency = Math.max(1, Number(process.env.RPC_PLS_MAX_CONCURRENCY ?? 5));

    this.ethLimiter = new Bottleneck({ maxConcurrent: ethConcurrency });
    this.plsLimiter = new Bottleneck({ maxConcurrent: plsConcurrency });

    this.omniBridgeContracts = new Map();
    this.bridgeManagerContracts = new Map();
    this.configureOmniBridgeContracts();
    this.configureBridgeManagerContracts();
  }

  private configureOmniBridgeContracts(): void {
    for (const [networkIdString, defaults] of Object.entries(DEFAULT_OMNIBRIDGE_CONTRACTS)) {
      const networkId = Number(networkIdString);
      const envKey = OMNIBRIDGE_ENV_KEYS[networkId];
      const override = envKey ? process.env[envKey] : undefined;
      const addressList = this.parseContractAddresses(override, defaults);
      this.omniBridgeContracts.set(networkId, new Set(addressList));
    }
  }

  private configureBridgeManagerContracts(): void {
    for (const [networkIdString, defaults] of Object.entries(BRIDGE_MANAGER_CONTRACTS)) {
      const networkId = Number(networkIdString);
      const addressList = this.parseContractAddresses(undefined, defaults);
      this.bridgeManagerContracts.set(networkId, new Set(addressList));
    }
  }

  private parseContractAddresses(override: string | undefined, defaults: string[]): string[] {
    const entries = (override ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);

    const source = [...defaults, ...entries];
    const seen = new Set<string>();

    for (const address of source) {
      try {
        const normalized = ethers.getAddress(address).toLowerCase();
        seen.add(normalized);
      } catch {
        throw new Error(`Invalid OmniBridge contract address configured: ${address}`);
      }
    }

    return Array.from(seen);
  }

  private getAllowedOmniBridgeContracts(networkId: number): Set<string> {
    const contracts = this.omniBridgeContracts.get(networkId);
    if (!contracts || contracts.size === 0) {
      throw new Error(`OmniBridge contracts not configured for network ${networkId}`);
    }
    return contracts;
  }

  isBridgeManagerContract(networkId: number, address: string): boolean {
    const contracts = this.bridgeManagerContracts.get(networkId);
    if (!contracts || contracts.size === 0) {
      return false;
    }
    return contracts.has(address.toLowerCase());
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
  private getProvider(networkId: number): Provider {
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

  extractTokensBridgingInitiatedEvent(
    receipt: ethers.TransactionReceipt,
    networkId: number
  ): TokensBridgingInitiatedEvent | null {
    const allowedContracts = this.getAllowedOmniBridgeContracts(networkId);

    for (const log of receipt.logs) {
      if (!allowedContracts.has(log.address.toLowerCase())) {
        continue;
      }

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
