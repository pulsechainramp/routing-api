import fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import quoteRoutes from './quote';
import { PiteasService } from '../services/PiteasService';
import { PulseXQuoteService } from '@/services/PulseXQuoteService';
import { AbiCoder, ParamType, Wallet, ZeroAddress } from 'ethers';
import config from '../config';
import { SignedQuoteIntegrity } from '../types/QuoteResponse';

describe('Quote route amount validation', () => {
  const tokenIn = '0x1111111111111111111111111111111111111111';
  const tokenOut = '0x2222222222222222222222222222222222222222';
  const TEST_SIGNING_KEY =
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const testWallet = new Wallet(TEST_SIGNING_KEY);
  const abiCoder = new AbiCoder();
  const SWAP_ROUTE_ABI = [
    ParamType.from({
      name: 'SwapRoute',
      type: 'tuple',
      components: [
        {
          name: 'steps',
          type: 'tuple[]',
          components: [
            { name: 'dex', type: 'string' },
            { name: 'path', type: 'address[]' },
            { name: 'pool', type: 'address' },
            { name: 'percent', type: 'uint256' },
            { name: 'groupId', type: 'uint256' },
            { name: 'parentGroupId', type: 'uint256' },
            { name: 'userData', type: 'bytes' },
          ],
        },
        {
          name: 'parentGroups',
          type: 'tuple[]',
          components: [
            { name: 'id', type: 'uint256' },
            { name: 'percent', type: 'uint256' },
          ],
        },
        { name: 'destination', type: 'address' },
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'groupCount', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMin', type: 'uint256' },
        { name: 'isETHOut', type: 'bool' },
      ],
    }),
  ];

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

  const buildRouteCalldata = (
    amountIn: string,
    minAmountOut: string,
    deadline: number,
    overrides?: { tokenIn?: string; tokenOut?: string; destination?: string }
  ) => {
    const routeTokenIn = overrides?.tokenIn ?? tokenIn;
    const routeTokenOut = overrides?.tokenOut ?? tokenOut;
    const destination = overrides?.destination ?? ZeroAddress;

    return abiCoder.encode(SWAP_ROUTE_ABI, [
      [
        [],
        [],
        destination,
        routeTokenIn,
        routeTokenOut,
        0,
        BigInt(deadline),
        BigInt(amountIn),
        BigInt(minAmountOut),
        false,
      ],
    ]);
  };

  beforeAll(() => {
    process.env.QUOTE_SIGNING_PRIVATE_KEY = TEST_SIGNING_KEY;
    process.env.QUOTE_SIGNER_ADDRESS = testWallet.address;
    process.env.QUOTE_CHAIN_ID = '369';
  });

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

  it('attests a valid quote payload', async () => {
    const { app } = await buildApp();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const amountInWei = '1000000000000000000';
    const minAmountOutWei = '950000000000000000';
    const calldata = buildRouteCalldata(amountInWei, minAmountOutWei, deadline);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/quote/attest',
        payload: {
          quote: {
            calldata,
            tokenInAddress: tokenIn,
            tokenOutAddress: tokenOut,
            amountIn: amountInWei,
            minAmountOut: minAmountOutWei,
            outputAmount: '1000000000000000000',
            deadline,
            gasUSDEstimated: 1,
            gasAmountEstimated: 210000,
            route: [],
          },
          context: {
            tokenInAddress: tokenIn,
            tokenOutAddress: tokenOut,
            amountInWei,
            minAmountOutWei,
            slippageBps: 50,
            recipient: tokenIn,
            routerAddress: config.AffiliateRouterAddress,
            chainId: 369,
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { integrity: SignedQuoteIntegrity };
      expect(body.integrity).toBeDefined();
      expect(body.integrity.signature).toMatch(/^0x/);
    } finally {
      await app.close();
    }
  });

  it('attests when the UI selects the native token alias but the quote routes through WPLS', async () => {
    const { app } = await buildApp();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const amountInWei = '2000000000000000000';
    const minAmountOutWei = '1800000000000000000';
    const calldata = buildRouteCalldata(amountInWei, minAmountOutWei, deadline, {
      tokenIn: config.WPLS,
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/quote/attest',
        payload: {
          quote: {
            calldata,
            tokenInAddress: config.WPLS,
            tokenOutAddress: tokenOut,
            amountIn: amountInWei,
            minAmountOut: minAmountOutWei,
            outputAmount: '2100000000000000000',
            deadline,
            gasUSDEstimated: 1,
            gasAmountEstimated: 210000,
            route: [],
          },
          context: {
            tokenInAddress: ZeroAddress,
            tokenOutAddress: tokenOut,
            amountInWei,
            minAmountOutWei,
            slippageBps: 50,
            recipient: tokenIn,
            routerAddress: config.AffiliateRouterAddress,
            chainId: 369,
          },
        },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('rejects attestation when the minimum output is lower than UI tolerance', async () => {
    const { app } = await buildApp();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const amountInWei = '1000000000000000000';
    const minAmountOutWei = '900000000000000000';
    const calldata = buildRouteCalldata(amountInWei, minAmountOutWei, deadline);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/quote/attest',
        payload: {
          quote: {
            calldata,
            tokenInAddress: tokenIn,
            tokenOutAddress: tokenOut,
            amountIn: amountInWei,
            minAmountOut: minAmountOutWei,
            outputAmount: '950000000000000000',
            deadline,
            gasUSDEstimated: 1,
            gasAmountEstimated: 210000,
            route: [],
          },
          context: {
            tokenInAddress: tokenIn,
            tokenOutAddress: tokenOut,
            amountInWei,
            minAmountOutWei: '940000000000000000',
            slippageBps: 50,
            recipient: tokenIn,
            routerAddress: config.AffiliateRouterAddress,
            chainId: 369,
          },
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
