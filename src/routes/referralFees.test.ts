import fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ReferralFeeService } from '../services/ReferralFeeService';

describe('Referral fee routes security', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const otherWallet = '0x2222222222222222222222222222222222222222';
  const token = '0x0000000000000000000000000000000000000000';

  const originalEnv = {
    rateMax: process.env.REFERRAL_FEES_RATE_LIMIT_MAX,
    rateWindow: process.env.REFERRAL_FEES_RATE_LIMIT_WINDOW,
    admins: process.env.REFERRAL_FEES_ADMIN_ADDRESSES,
  };

  afterAll(() => {
    process.env.REFERRAL_FEES_RATE_LIMIT_MAX = originalEnv.rateMax;
    process.env.REFERRAL_FEES_RATE_LIMIT_WINDOW = originalEnv.rateWindow;
    process.env.REFERRAL_FEES_ADMIN_ADDRESSES = originalEnv.admins;
  });

  async function buildApp(adminAddresses = wallet) {
    process.env.REFERRAL_FEES_RATE_LIMIT_MAX = '10';
    process.env.REFERRAL_FEES_RATE_LIMIT_WINDOW = '1 minute';
    process.env.REFERRAL_FEES_ADMIN_ADDRESSES = adminAddresses;

    jest.resetModules();

    const { default: referralFeeRoutes } = await import('./referralFees');

    const serviceMock = {
      getReferralFee: jest.fn().mockResolvedValue({
        id: 'fee-1',
        referrer: wallet,
        token,
        amount: '100',
        lastUpdated: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }),
      getReferralFeesByReferrer: jest.fn().mockResolvedValue([
        {
          id: 'fee-1',
          referrer: wallet,
          token,
          amount: '100',
          lastUpdated: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
      getReferralFeesByToken: jest.fn().mockResolvedValue([
        {
          id: 'fee-1',
          referrer: wallet,
          token,
          amount: '100',
          lastUpdated: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ]),
      getTotalReferralFees: jest.fn().mockResolvedValue({
        totalAmount: '100',
        totalReferrers: 1,
        totalTokens: 1,
      }),
    } as unknown as ReferralFeeService;

    const app: FastifyInstance = fastify();

    app.decorate('authenticate', async function (request: any, reply: any) {
      const authHeader = request.headers?.authorization;
      if (!authHeader) {
        return reply.status(401).send({ success: false, error: 'Unauthorized' });
      }

      const sub = authHeader.replace(/^Bearer\s+/i, '');
      request.user = { sub };
    });

    await app.register(rateLimit, { global: false });
    await app.register(referralFeeRoutes, {
      prefix: '/referral-fees',
      referralFeeService: serviceMock,
    });

    await app.ready();
    return { app, serviceMock };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthenticated fee lookups', async () => {
    const { app, serviceMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/referral-fees/fee?referrer=${wallet}&token=${token}`,
      });

      expect(response.statusCode).toBe(401);
      expect(serviceMock.getReferralFee).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects fee lookups when the JWT subject differs from referrer', async () => {
    const { app, serviceMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/referral-fees/fee?referrer=${otherWallet}&token=${token}`,
        headers: {
          authorization: `Bearer ${wallet}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(serviceMock.getReferralFee).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('allows authenticated referrers to view their own fee', async () => {
    const { app, serviceMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/referral-fees/fee?referrer=${wallet}&token=${token}`,
        headers: {
          authorization: `Bearer ${wallet}`,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(serviceMock.getReferralFee).toHaveBeenCalledWith(wallet, token);
    } finally {
      await app.close();
    }
  });

  it('restricts referrer summaries to authenticated owners', async () => {
    const { app, serviceMock } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/referral-fees/referrer/${otherWallet}`,
        headers: {
          authorization: `Bearer ${wallet}`,
        },
      });

      expect(response.statusCode).toBe(401);
      expect(serviceMock.getReferralFeesByReferrer).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('requires admin privileges for token reports', async () => {
    const { app, serviceMock } = await buildApp(otherWallet);

    try {
      const unauth = await app.inject({
        method: 'GET',
        url: `/referral-fees/token/${token}`,
      });
      expect(unauth.statusCode).toBe(401);

      const forbidden = await app.inject({
        method: 'GET',
        url: `/referral-fees/token/${token}`,
        headers: {
          authorization: `Bearer ${wallet}`,
        },
      });
      expect(forbidden.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: `/referral-fees/token/${token}`,
        headers: {
          authorization: `Bearer ${otherWallet}`,
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(serviceMock.getReferralFeesByToken).toHaveBeenCalledWith(token);
    } finally {
      await app.close();
    }
  });

  it('requires admin privileges for totals', async () => {
    const { app, serviceMock } = await buildApp(otherWallet);

    try {
      const forbidden = await app.inject({
        method: 'GET',
        url: `/referral-fees/totals`,
        headers: {
          authorization: `Bearer ${wallet}`,
        },
      });
      expect(forbidden.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'GET',
        url: `/referral-fees/totals`,
        headers: {
          authorization: `Bearer ${otherWallet}`,
        },
      });
      expect(allowed.statusCode).toBe(200);
      expect(serviceMock.getTotalReferralFees).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
