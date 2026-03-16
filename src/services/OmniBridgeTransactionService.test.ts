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
    findMany: jest.fn().mockResolvedValue([]),
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
    delete process.env.OMNIBRIDGE_CLAIMABILITY_PAGE_SIZE;
    delete process.env.OMNIBRIDGE_CLAIMABILITY_MAX_PAGES;
    delete process.env.OMNIBRIDGE_CLAIMABILITY_MESSAGE_CHUNK_SIZE;
    delete process.env.OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_BASE_MS;
    delete process.env.OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_MAX_MS;
  });

  it('caches failed lookups to avoid repeated RPC calls', async () => {
    const blockchainStub = {
      validateTransactionHash: jest.fn().mockReturnValue(true),
      validateNetworkId: jest.fn().mockReturnValue(true),
      getTransactionReceipt: jest.fn().mockResolvedValue(null),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn().mockReturnValue(false),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

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

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);

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

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);

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

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);

    jest.spyOn(service as any, 'getTransactionByMessageId').mockResolvedValue(null);
    const createTransactionSpy = jest
      .spyOn(service as any, 'createTransaction')
      .mockResolvedValue({ messageId: bridgeEvent.messageId });

    const result = await service.createTransactionFromTxHash(txHash, 1, userAddress);

    expect(result).toEqual({ messageId: bridgeEvent.messageId });
    expect(createTransactionSpy).toHaveBeenCalled();
  });

  it('marks pending PulseChain->Ethereum transactions as claimable when signatures exist', async () => {
    const messageId = '0x' + '1'.repeat(64);
    prismaStub.omniBridgeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-1',
        messageId,
        userAddress,
        sourceChainId: 369,
        targetChainId: 1,
        sourceTxHash: txHash,
        targetTxHash: null,
        tokenAddress: '0x0000000000000000000000000000000000000001',
        tokenSymbol: 'USDC from Ethereum',
        tokenDecimals: 6,
        amount: '3000000',
        status: 'pending',
        sourceTimestamp: new Date().toISOString(),
        targetTimestamp: null,
        encodedData: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const blockchainStub = {
      validateTransactionHash: jest.fn(),
      validateNetworkId: jest.fn(),
      getTransactionReceipt: jest.fn(),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn(),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);
    const fetchByIdsSpy = jest
      .spyOn(service as any, 'fetchPulsechainRequestsByMessageIds')
      .mockResolvedValueOnce([
      {
        user: userAddress,
        txHash,
        messageId,
        timestamp: '1700000000',
        amount: '3000000',
        token: '0x0000000000000000000000000000000000000001',
        decimals: 6,
        symbol: 'USDC from Ethereum',
        encodedData: '0x',
        message: {
          txHash,
          messageId,
          messageData: null,
          signatures: '0x1234',
        },
      },
    ]);
    const fallbackSpy = jest.spyOn(service, 'fetchPulsechainRequests');

    const transactions = await service.getUserTransactions(userAddress);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      status: 'pending',
      statusDetail: 'claim_required',
      isClaimable: true,
    });
    expect(fetchByIdsSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('keeps pending Ethereum->PulseChain transactions as in-progress', async () => {
    prismaStub.omniBridgeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-2',
        messageId: '0x' + '2'.repeat(64),
        userAddress,
        sourceChainId: 1,
        targetChainId: 369,
        sourceTxHash: txHash,
        targetTxHash: null,
        tokenAddress: '0x0000000000000000000000000000000000000001',
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        amount: '3000000',
        status: 'pending',
        sourceTimestamp: new Date().toISOString(),
        targetTimestamp: null,
        encodedData: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const blockchainStub = {
      validateTransactionHash: jest.fn(),
      validateNetworkId: jest.fn(),
      getTransactionReceipt: jest.fn(),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn(),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);
    const pulseRequestsSpy = jest.spyOn(service, 'fetchPulsechainRequests');

    const transactions = await service.getUserTransactions(userAddress);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      status: 'pending',
      statusDetail: 'bridge_in_progress',
      isClaimable: false,
    });
    expect(pulseRequestsSpy).not.toHaveBeenCalled();
  });

  it('retries targeted lookup after cooldown instead of disabling it permanently', async () => {
    process.env.OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_BASE_MS = '60000';
    process.env.OMNIBRIDGE_CLAIMABILITY_TARGETED_RETRY_MAX_MS = '60000';

    const messageId = '0x' + '8'.repeat(64);
    const normalizedMessageId = messageId.toLowerCase();
    const blockchainStub = {
      validateTransactionHash: jest.fn(),
      validateNetworkId: jest.fn(),
      getTransactionReceipt: jest.fn(),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn(),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);
    const targetedSpy = jest
      .spyOn(service as any, 'fetchPulsechainRequestsByMessageIds')
      .mockRejectedValueOnce(new Error('temporary subgraph failure'))
      .mockResolvedValueOnce([
        {
          user: userAddress,
          txHash,
          messageId,
          timestamp: '1700000000',
          amount: '3000000',
          token: '0x0000000000000000000000000000000000000001',
          decimals: 6,
          symbol: 'USDC from Ethereum',
          encodedData: '0x',
          message: {
            txHash,
            messageId,
            messageData: null,
            signatures: '0x1234',
          },
        },
      ]);
    const fallbackSpy = jest
      .spyOn(service as any, 'scanPulsechainRequestsForMessageIds')
      .mockResolvedValue([]);

    const firstAttempt = await (service as any).getClaimableMessageIdSet(userAddress, [messageId]);
    expect(firstAttempt.has(normalizedMessageId)).toBe(false);
    expect(targetedSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect((service as any).pulsechainTargetedLookupDisabledUntilMs).toBeGreaterThan(Date.now());

    const secondAttempt = await (service as any).getClaimableMessageIdSet(userAddress, [messageId]);
    expect(secondAttempt.has(normalizedMessageId)).toBe(false);
    expect(targetedSpy).toHaveBeenCalledTimes(1);
    expect(fallbackSpy).toHaveBeenCalledTimes(2);

    (service as any).pulsechainTargetedLookupDisabledUntilMs = Date.now() - 1;

    const thirdAttempt = await (service as any).getClaimableMessageIdSet(userAddress, [messageId]);
    expect(thirdAttempt.has(normalizedMessageId)).toBe(true);
    expect(targetedSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to paginated request scan when targeted lookup is unavailable', async () => {
    process.env.OMNIBRIDGE_CLAIMABILITY_PAGE_SIZE = '2';
    process.env.OMNIBRIDGE_CLAIMABILITY_MAX_PAGES = '3';

    const messageId = '0x' + '3'.repeat(64);
    prismaStub.omniBridgeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-3',
        messageId,
        userAddress,
        sourceChainId: 369,
        targetChainId: 1,
        sourceTxHash: txHash,
        targetTxHash: null,
        tokenAddress: '0x0000000000000000000000000000000000000001',
        tokenSymbol: 'USDT from Ethereum',
        tokenDecimals: 6,
        amount: '3000000',
        status: 'pending',
        sourceTimestamp: new Date().toISOString(),
        targetTimestamp: null,
        encodedData: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const blockchainStub = {
      validateTransactionHash: jest.fn(),
      validateNetworkId: jest.fn(),
      getTransactionReceipt: jest.fn(),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn(),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);

    jest
      .spyOn(service as any, 'fetchPulsechainRequestsByMessageIds')
      .mockRejectedValueOnce(new Error('messageId_in not supported'));

    const firstPage = [
      {
        user: userAddress,
        txHash: '0x' + '4'.repeat(64),
        messageId: '0x' + '5'.repeat(64),
        timestamp: '1700000000',
        amount: '1',
        token: '0x0000000000000000000000000000000000000001',
        decimals: 6,
        symbol: 'USDT from Ethereum',
        encodedData: '0x',
        message: {
          txHash: '0x' + '4'.repeat(64),
          messageId: '0x' + '5'.repeat(64),
          messageData: null,
          signatures: '0x',
        },
      },
      {
        user: userAddress,
        txHash: '0x' + '6'.repeat(64),
        messageId: '0x' + '7'.repeat(64),
        timestamp: '1700000000',
        amount: '1',
        token: '0x0000000000000000000000000000000000000001',
        decimals: 6,
        symbol: 'USDT from Ethereum',
        encodedData: '0x',
        message: {
          txHash: '0x' + '6'.repeat(64),
          messageId: '0x' + '7'.repeat(64),
          messageData: null,
          signatures: '0x',
        },
      },
    ];

    const secondPage = [
      {
        user: userAddress,
        txHash,
        messageId,
        timestamp: '1700000000',
        amount: '3000000',
        token: '0x0000000000000000000000000000000000000001',
        decimals: 6,
        symbol: 'USDT from Ethereum',
        encodedData: '0x',
        message: {
          txHash,
          messageId,
          messageData: null,
          signatures: '0xbeef',
        },
      },
    ];

    const fallbackSpy = jest
      .spyOn(service, 'fetchPulsechainRequests')
      .mockResolvedValueOnce(firstPage as any)
      .mockResolvedValueOnce(secondPage as any);

    const transactions = await service.getUserTransactions(userAddress);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      status: 'pending',
      statusDetail: 'claim_required',
      isClaimable: true,
    });
    expect(fallbackSpy).toHaveBeenNthCalledWith(1, userAddress, 2, 0);
    expect(fallbackSpy).toHaveBeenNthCalledWith(2, userAddress, 2, 2);
  });

  it('supports unbounded fallback scan when OMNIBRIDGE_CLAIMABILITY_MAX_PAGES is 0', async () => {
    process.env.OMNIBRIDGE_CLAIMABILITY_PAGE_SIZE = '1';
    process.env.OMNIBRIDGE_CLAIMABILITY_MAX_PAGES = '0';

    const messageId = '0x' + '9'.repeat(64);
    prismaStub.omniBridgeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'tx-4',
        messageId,
        userAddress,
        sourceChainId: 369,
        targetChainId: 1,
        sourceTxHash: txHash,
        targetTxHash: null,
        tokenAddress: '0x0000000000000000000000000000000000000001',
        tokenSymbol: 'USDT from Ethereum',
        tokenDecimals: 6,
        amount: '3000000',
        status: 'pending',
        sourceTimestamp: new Date().toISOString(),
        targetTimestamp: null,
        encodedData: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const blockchainStub = {
      validateTransactionHash: jest.fn(),
      validateNetworkId: jest.fn(),
      getTransactionReceipt: jest.fn(),
      extractTokensBridgingInitiatedEvent: jest.fn(),
      getBlockTimestamp: jest.fn(),
      isBridgeManagerContract: jest.fn(),
    };

    const service = new OmniBridgeTransactionService(prismaStub, blockchainStub as any);

    jest
      .spyOn(service as any, 'fetchPulsechainRequestsByMessageIds')
      .mockRejectedValueOnce(new Error('messageId_in temporarily unavailable'));

    let pageCallCount = 0;
    const fallbackSpy = jest
      .spyOn(service, 'fetchPulsechainRequests')
      .mockImplementation(async () => {
        pageCallCount += 1;
        if (pageCallCount === 27) {
          return [
            {
              user: userAddress,
              txHash,
              messageId,
              timestamp: '1700000000',
              amount: '3000000',
              token: '0x0000000000000000000000000000000000000001',
              decimals: 6,
              symbol: 'USDT from Ethereum',
              encodedData: '0x',
              message: {
                txHash,
                messageId,
                messageData: null,
                signatures: '0xbeef',
              },
            },
          ] as any;
        }

        return [
          {
            user: userAddress,
            txHash: '0x' + pageCallCount.toString(16).padStart(64, '0'),
            messageId: '0x' + (1000 + pageCallCount).toString(16).padStart(64, '0'),
            timestamp: '1700000000',
            amount: '1',
            token: '0x0000000000000000000000000000000000000001',
            decimals: 6,
            symbol: 'USDT from Ethereum',
            encodedData: '0x',
            message: {
              txHash: '0x' + pageCallCount.toString(16).padStart(64, '0'),
              messageId: '0x' + (1000 + pageCallCount).toString(16).padStart(64, '0'),
              messageData: null,
              signatures: '0x',
            },
          },
        ] as any;
      });

    const transactions = await service.getUserTransactions(userAddress);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      status: 'pending',
      statusDetail: 'claim_required',
      isClaimable: true,
    });
    expect(fallbackSpy).toHaveBeenCalledTimes(27);
  });
});
