import { OmniBridgeTransactionService } from './OmniBridgeTransactionService';

jest.mock('./OmniBridgeService', () => {
  return {
    OmniBridgeService: class {
      async getSupportedCurrencies() {
        return [
          {
            name: 'Token',
            symbol: 'TKN',
            decimals: 18,
            address: '0x0000000000000000000000000000000000000001',
            chainId: 1,
            logoURI: '',
            tags: [],
            network: 'ethereum',
          },
        ];
      }
    },
  };
});

const prismaStub = {
  omniBridgeTransaction: {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
  },
} as any;

describe('OmniBridgeTransactionService protections', () => {
  const txHash = '0x' + 'b'.repeat(64);
  const userAddress = '0x' + 'c'.repeat(40);

  beforeEach(() => {
    process.env.OMNI_MISS_TTL_MS = '60000';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.OMNI_MISS_TTL_MS;
  });

  it('caches failed lookups to avoid repeated RPC calls', async () => {
    const service = new OmniBridgeTransactionService(prismaStub);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const blockchainStub = {
      validateTransactionHash: jest.fn().mockReturnValue(true),
      validateNetworkId: jest.fn().mockReturnValue(true),
      getTransactionReceipt: jest.fn().mockResolvedValue(null),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn().mockReturnValue(false),
    };

    (service as any).blockchainService = blockchainStub;

    await expect(service.createTransactionFromTxHash(txHash, 1, userAddress)).rejects.toThrow(
      'Failed to create transaction from transaction hash',
    );

    expect((service as any).failedTransactionCache.size).toBe(1);

    await expect(service.createTransactionFromTxHash(txHash, 1, userAddress)).rejects.toThrow(
      'Transaction not found in bridge cache',
    );

    expect(blockchainStub.getTransactionReceipt).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('deduplicates in-flight requests for the same transaction hash', async () => {
    const service = new OmniBridgeTransactionService(prismaStub);

    const receipt: any = { blockNumber: 123n, logs: [] };
    let resolveReceipt: ((value: any) => void) | undefined;
    const receiptPromise = new Promise<any>((resolve) => {
      resolveReceipt = resolve;
    });

    const bridgeEvent = {
      token: '0x0000000000000000000000000000000000000001',
      sender: userAddress,
      value: '1000',
      messageId: '0x' + 'd'.repeat(64),
    };

    const blockchainStub = {
      validateTransactionHash: jest.fn().mockReturnValue(true),
      validateNetworkId: jest.fn().mockReturnValue(true),
      getTransactionReceipt: jest.fn().mockReturnValue(receiptPromise),
      extractTokensBridgingInitiatedEvent: jest.fn().mockReturnValue(bridgeEvent),
      getBlockTimestamp: jest.fn().mockResolvedValue(1700000000),
      isBridgeManagerContract: jest.fn().mockReturnValue(false),
    };

    (service as any).blockchainService = blockchainStub;

    const getTransactionSpy = jest
      .spyOn(service as any, 'getTransactionByMessageId')
      .mockResolvedValue(null);
    const createTransactionSpy = jest
      .spyOn(service as any, 'createTransaction')
      .mockResolvedValue({ messageId: bridgeEvent.messageId });

    const firstPromise = service.createTransactionFromTxHash(txHash, 1, userAddress);
    const secondPromise = service.createTransactionFromTxHash(txHash, 1, userAddress);

    expect(blockchainStub.getTransactionReceipt).toHaveBeenCalledTimes(1);

    resolveReceipt!(receipt);

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

    expect(firstResult).toEqual({ messageId: bridgeEvent.messageId });
    expect(secondResult).toEqual({ messageId: bridgeEvent.messageId });
    expect(createTransactionSpy).toHaveBeenCalledTimes(1);
    expect(blockchainStub.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(getTransactionSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects when the on-chain sender differs from the authenticated wallet', async () => {
    const service = new OmniBridgeTransactionService(prismaStub);
    const victimAddress = '0x' + 'd'.repeat(40);
    const bridgeEvent = {
      token: '0x0000000000000000000000000000000000000001',
      sender: victimAddress,
      value: '1000',
      messageId: '0x' + 'e'.repeat(64),
    };

    const blockchainStub = {
      validateTransactionHash: jest.fn().mockReturnValue(true),
      validateNetworkId: jest.fn().mockReturnValue(true),
      getTransactionReceipt: jest.fn().mockResolvedValue({ blockNumber: 123n, logs: [] }),
      extractTokensBridgingInitiatedEvent: jest.fn().mockReturnValue(bridgeEvent),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn().mockReturnValue(false),
    };

    (service as any).blockchainService = blockchainStub;

    const getTransactionSpy = jest
      .spyOn(service as any, 'getTransactionByMessageId')
      .mockResolvedValue(null);
    const createTransactionSpy = jest.spyOn(service as any, 'createTransaction');

    await expect(service.createTransactionFromTxHash(txHash, 1, userAddress)).rejects.toThrow(
      'Transaction sender does not match authenticated wallet',
    );

    expect(getTransactionSpy).not.toHaveBeenCalled();
    expect(createTransactionSpy).not.toHaveBeenCalled();
    expect(blockchainStub.getBlockTimestamp).not.toHaveBeenCalled();
    expect((service as any).failedTransactionCache.size).toBe(0);
  });

  it('accepts bridge manager events when the transaction origin matches the user', async () => {
    const service = new OmniBridgeTransactionService(prismaStub);
    const bridgeManagerAddress = '0x' + 'a'.repeat(40);
    const bridgeEvent = {
      token: '0x0000000000000000000000000000000000000001',
      sender: bridgeManagerAddress,
      value: '1000',
      messageId: '0x' + 'f'.repeat(64),
    };

    const blockchainStub = {
      validateTransactionHash: jest.fn().mockReturnValue(true),
      validateNetworkId: jest.fn().mockReturnValue(true),
      getTransactionReceipt: jest.fn().mockResolvedValue({ blockNumber: 123n, logs: [], from: userAddress }),
      extractTokensBridgingInitiatedEvent: jest.fn().mockReturnValue(bridgeEvent),
      getBlockTimestamp: jest.fn().mockResolvedValue(1700000000),
      isBridgeManagerContract: jest.fn().mockImplementation((_networkId, address) => {
        return address === bridgeManagerAddress.toLowerCase();
      }),
    };

    (service as any).blockchainService = blockchainStub;

    jest.spyOn(service as any, 'getTransactionByMessageId').mockResolvedValue(null);
    const createTransactionSpy = jest
      .spyOn(service as any, 'createTransaction')
      .mockResolvedValue({ messageId: bridgeEvent.messageId });

    const result = await service.createTransactionFromTxHash(txHash, 1, userAddress);

    expect(result).toEqual({ messageId: bridgeEvent.messageId });
    expect(createTransactionSpy).toHaveBeenCalled();
  });
});
