import fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyJwt from '@fastify/jwt';
import { SiweMessage } from 'siwe';
import type { AuthService } from '../services/AuthService';

describe('auth routes host binding', () => {
  const walletAddress = '0x1111111111111111111111111111111111111111';
  const siweUri = 'https://pulsechainramp.com';
  const originalDomainEnv = process.env.SIWE_DOMAIN;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterAll(() => {
    process.env.SIWE_DOMAIN = originalDomainEnv;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  async function buildApp() {
    process.env.SIWE_DOMAIN = 'pulsechainramp.com,localhost';
    process.env.JWT_SECRET = 'test-secret';

    const { default: authRoutes } = await import('./auth');

    const authServiceMock = {
      generateNonce: jest.fn().mockReturnValue('ABCD1234'),
      consumeNonce: jest.fn().mockReturnValue(true)
    } as unknown as AuthService;

    const app: FastifyInstance = fastify();
    await app.register(rateLimit, { global: false });
    await app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
    await app.register(authRoutes, {
      prefix: '/auth',
      authService: authServiceMock
    });

    await app.ready();
    return { app, authServiceMock };
  }

  function buildMessage(domain: string, nonce = 'abcd1234') {
    const message = new SiweMessage({
      domain,
      address: walletAddress,
      statement: 'Test SIWE login',
      uri: siweUri,
      version: '1',
      chainId: 369,
      nonce,
      issuedAt: new Date().toISOString()
    });

    return message.prepareMessage();
  }

  it('rejects SIWE challenge requests from untrusted hosts', async () => {
    const { app, authServiceMock } = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/auth/challenge?address=${walletAddress}`,
        headers: {
          host: 'attacker.tld'
        }
      });

      expect(response.statusCode).toBe(400);
      expect(authServiceMock.generateNonce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('includes the allowed host as the SIWE domain in challenges', async () => {
    const { app, authServiceMock } = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/auth/challenge?address=${walletAddress}`,
        headers: {
          host: 'pulsechainramp.com'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message).toContain('pulsechainramp.com');
      expect(authServiceMock.generateNonce).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects SIWE verification when the Host header is untrusted', async () => {
    const { app, authServiceMock } = await buildApp();
    try {
      const message = buildMessage('pulsechainramp.com');
      const response = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        headers: {
          'content-type': 'application/json',
          host: 'attacker.tld'
        },
        payload: {
          message,
          signature: '0xdead'
        }
      });

      expect(response.statusCode).toBe(401);
      expect(authServiceMock.consumeNonce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects SIWE verification when the signed domain differs from the request host', async () => {
    const { app, authServiceMock } = await buildApp();
    try {
      const message = buildMessage('localhost');
      const response = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        headers: {
          'content-type': 'application/json',
          host: 'pulsechainramp.com'
        },
        payload: {
          message,
          signature: '0xdead'
        }
      });

      expect(response.statusCode).toBe(401);
      expect(authServiceMock.consumeNonce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('verifies SIWE messages only when Host header and domain both match the allowlist', async () => {
    const { app, authServiceMock } = await buildApp();
    const verifySpy = jest
      .spyOn(SiweMessage.prototype, 'verify')
      .mockResolvedValue({
        success: true,
        data: { address: walletAddress }
      } as any);

    try {
      const nonce = 'nonce1234';
      const message = buildMessage('pulsechainramp.com', nonce);
      const response = await app.inject({
        method: 'POST',
        url: '/auth/verify',
        headers: {
          'content-type': 'application/json',
          host: 'pulsechainramp.com'
        },
        payload: {
          message,
          signature: '0xbeef'
        }
      });

      expect(response.statusCode).toBe(200);
      const parsed = response.json();
      expect(parsed.address).toBe(walletAddress.toLowerCase());
      expect(typeof parsed.token).toBe('string');
      expect(authServiceMock.consumeNonce).toHaveBeenCalledWith(nonce, walletAddress.toLowerCase());
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy.mock.calls[0][0]).toMatchObject({
        domain: 'pulsechainramp.com'
      });
    } finally {
      verifySpy.mockRestore();
      await app.close();
    }
  });
});
