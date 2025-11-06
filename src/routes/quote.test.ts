import fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import quoteRoutes from './quote';
import { PiteasService } from '../services/PiteasService';
import { PulseXQuoteService } from '@/services/PulseXQuoteService';

describe('Quote route amount validation', () => {
  const tokenIn = '0x1111111111111111111111111111111111111111';
  const tokenOut = '0x2222222222222222222222222222222222222222';

  async function buildApp() {
    const app = fastify({ logger: false });

    app.setErrorHandler((err, _req, reply) => {
      const status =
        typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;

      const isValidation = err?.validation || err?.code === 'FST_ERR_VALIDATION';
      const message = isValidation
        ? 'Invalid request'
        : status >= 500
          ? 'Internal Server Error'
          : 'Bad Request';

      reply.code(isValidation ? 400 : status).send({ error: message });
    });

    await app.register(rateLimit, { global: false });

    const piteasService = {
      getQuote: jest.fn().mockResolvedValue({ ok: true })
    } as unknown as PiteasService;

    const pulseXQuoteService = {
      getQuote: jest.fn().mockResolvedValue({ ok: true })
    } as unknown as PulseXQuoteService;

    await app.register(quoteRoutes, {
      prefix: '/quote',
      piteasService,
      pulseXQuoteService
    });

    await app.ready();

    return { app, piteasService, pulseXQuoteService };
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejects NaN query amounts before hitting the Piteas service', async () => {
    const { app, piteasService } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/quote?tokenInAddress=${tokenIn}&tokenOutAddress=${tokenOut}&amount=NaN`,
        remoteAddress: '203.0.113.5'
      });

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body);
      expect(payload.error).toBe('Invalid request');
      expect(piteasService.getQuote).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects scientific-notation amounts on the PulseX quote endpoint', async () => {
    const { app, pulseXQuoteService } = await buildApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/quote/pulsex?tokenInAddress=${tokenIn}&tokenOutAddress=${tokenOut}&amount=1e100000`,
        remoteAddress: '203.0.113.5'
      });

      expect(response.statusCode).toBe(400);
      const payload = JSON.parse(response.body);
      expect(payload.error).toBe('Invalid request');
      expect(pulseXQuoteService.getQuote).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
