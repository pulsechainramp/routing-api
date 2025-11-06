import fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { OmniBridgeTransactionService } from '../../services/OmniBridgeTransactionService';

describe('OmniBridge transaction route security', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const txHash = '0x' + 'a'.repeat(64);

  const originalEnv = {
    rateMax: process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_MAX,
    rateWindow: process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_WINDOW,
    rateBan: process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_BAN,
  };

  afterAll(() => {
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_MAX = originalEnv.rateMax;
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_WINDOW = originalEnv.rateWindow;
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_BAN = originalEnv.rateBan;
  });

  async function buildApp() {
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_MAX = '1';
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_WINDOW = '1 minute';
    process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_BAN = '0';

    jest.resetModules();
    const { transactionRoutes } = await import('./transactions');

    const createTransactionMock = jest.fn().mockResolvedValue({ messageId: 'msg-1' });
    const serviceMock = {
      createTransactionFromTxHash: createTransactionMock,
      getTransactionStatus: jest.fn(),
      getUserTransactions: jest.fn(),
      syncUserTransactions: jest.fn(),
    } as unknown as OmniBridgeTransactionService;

    const app: FastifyInstance = fastify();

    try {
      app.decorate('authenticate', async function (request: any, reply: any) {
        const authHeader = request.headers?.authorization;
        if (!authHeader) {
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        }

        const sub = authHeader.replace(/^Bearer\s+/i, '');
        request.user = { sub };
      });

      await app.register(rateLimit, { global: false });
      await app.register(transactionRoutes, {
        prefix: '/exchange/omnibridge',
        omniBridgeTransactionService: serviceMock,
      });

      await app.ready();
    } catch (error) {
      console.error('buildApp error', error);
      throw error;
    }

    return { app, createTransactionMock };
  }

  afterEach(async () => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated callers', async () => {
    const { app, createTransactionMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/exchange/omnibridge/transaction',
        payload: {
          txHash,
          networkId: 1,
          userAddress: wallet,
        },
        remoteAddress: '203.0.113.5',
      });

      expect(response.statusCode).toBe(401);
      expect(createTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects subject/address mismatches', async () => {
    const { app, createTransactionMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/exchange/omnibridge/transaction',
        headers: {
          authorization: `Bearer ${wallet}`,
        },
        payload: {
          txHash,
          networkId: 1,
          userAddress: '0x2222222222222222222222222222222222222222',
        },
        remoteAddress: '203.0.113.5',
      });

      expect(response.statusCode).toBe(401);
      expect(createTransactionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('applies per-user rate limiting before invoking RPC work', async () => {
    const { app, createTransactionMock } = await buildApp();

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/exchange/omnibridge/transaction',
        headers: {
          authorization: `Bearer ${wallet}`,
        },
        payload: {
          txHash,
          networkId: 1,
          userAddress: wallet,
        },
        remoteAddress: '203.0.113.5',
      });

      expect(first.statusCode).toBe(200);
      expect(createTransactionMock).toHaveBeenCalledTimes(1);

      const second = await app.inject({
        method: 'POST',
        url: '/exchange/omnibridge/transaction',
        headers: {
          authorization: `Bearer ${wallet}`,
        },
        payload: {
          txHash,
          networkId: 1,
          userAddress: wallet,
        },
        remoteAddress: '203.0.113.5',
      });

      expect(second.statusCode).toBe(429);
      expect(createTransactionMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
