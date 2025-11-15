import { ethers } from 'ethers';
import pulsexConfig from '../config/pulsex';
import type { PulsexProtocol, PulsexQuoteResult, RouteLegSummary, SplitRouteMeta } from '../types/pulsex';
import { PulseXQuoteService } from './PulseXQuoteService';

jest.mock('../utils/web3', () => ({
  setPulsechainProviderForWeb3: jest.fn(),
  getTokenDecimals: jest.fn().mockResolvedValue(18),
  getTokenSymbol: jest.fn().mockResolvedValue('TOK'),
  encodeSwapRoute: jest.fn().mockReturnValue('0xdeadbeef'),
  toCorrectDexName: jest.fn((dex: string) => dex),
}));

const createLeg = (
  tokenIn: string,
  tokenOut: string,
  pool: string,
  protocol: PulsexProtocol = 'PULSEX_V2',
): RouteLegSummary => ({
  protocol,
  tokenIn: {
    address: tokenIn as `0x${string}`,
    decimals: 18,
    symbol: 'IN',
  },
  tokenOut: {
    address: tokenOut as `0x${string}`,
    decimals: 18,
    symbol: 'OUT',
  },
  poolAddress: pool as `0x${string}`,
});

const baseQuoteResult = (
  legs: RouteLegSummary[],
  overrides: Partial<PulsexQuoteResult> = {},
): PulsexQuoteResult => ({
  request: {} as any,
  totalAmountOut: 2_000n,
  routerAddress: pulsexConfig.routers.default,
  singleRoute: legs,
  gasEstimate: 150_000n,
  gasUsd: 0.42,
  ...overrides,
});

const createSplitRoute = (shareBps: number, legs: RouteLegSummary[]): SplitRouteMeta => ({
  shareBps,
  amountIn: BigInt(shareBps),
  amountOut: BigInt(shareBps * 2),
  legs,
});

describe('PulseXQuoteService', () => {
  const provider = new ethers.JsonRpcProvider();

  it('normalizes native tokens before requesting a quote', async () => {
    const quoter = {
      quoteBestExactIn: jest.fn().mockResolvedValue(baseQuoteResult([createLeg('0x1', '0x2', '0x3')])),
    };

    const service = new PulseXQuoteService(provider, quoter as any);
    await service.getQuote({
      tokenInAddress: 'PLS',
      tokenOutAddress: '0x0000000000000000000000000000000000000011',
      amount: '1000',
    });

    expect(quoter.quoteBestExactIn).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenIn: expect.objectContaining({
          address: pulsexConfig.connectorTokens.find((token) => token.isNative)?.address,
        }),
      }),
    );
  });

  it('maps PulsexQuoteResult into a QuoteResponse shape', async () => {
    const legs = [
      createLeg(
        pulsexConfig.connectorTokens.find((token) => token.isNative)!.address,
        '0x00000000000000000000000000000000000000bb',
        '0x00000000000000000000000000000000000000aa',
      ),
    ];
    const quoter = {
      quoteBestExactIn: jest.fn().mockResolvedValue(baseQuoteResult(legs)),
    };

    const service = new PulseXQuoteService(provider, quoter as any);
    const quote = await service.getQuote({
      tokenInAddress: 'PLS',
      tokenOutAddress: '0x00000000000000000000000000000000000000bb',
      amount: '1000',
      allowedSlippage: 1,
    });

    expect(quote.tokenInAddress).toBe(ethers.ZeroAddress);
    expect(quote.tokenOutAddress).toBe('0x00000000000000000000000000000000000000bb');
    expect(quote.outputAmount).toBe('2000');
    expect(quote.gasAmountEstimated).toBe(150_000);
    expect(quote.gasUSDEstimated).toBeCloseTo(0.42);
    expect(quote.route).toHaveLength(1);
    expect(quote.calldata).toBe('0xdeadbeef');
  });

  it('builds multi-hop connector routes into CombinedRoute output', async () => {
    const connector = '0x0000000000000000000000000000000000000c01';
    const target = '0x0000000000000000000000000000000000000c02';
    const legs = [
      createLeg(
        pulsexConfig.connectorTokens.find((token) => token.isNative)!.address,
        connector,
        '0x0000000000000000000000000000000000000c11',
        'PULSEX_V2',
      ),
      createLeg(connector, target, '0x0000000000000000000000000000000000000c22', 'PULSEX_V1'),
    ];

    const quoter = {
      quoteBestExactIn: jest.fn().mockResolvedValue(baseQuoteResult(legs)),
    };

    const service = new PulseXQuoteService(provider, quoter as any);
    const quote = await service.getQuote({
      tokenInAddress: 'PLS',
      tokenOutAddress: target,
      amount: '1000',
      allowedSlippage: 0.5,
    });

    expect(quote.route).toHaveLength(1);
    const [combined] = quote.route;
    expect(combined.subroutes).toHaveLength(legs.length);
    expect(combined.subroutes[0].paths[0].tokens.map((t) => t.address)).toEqual([
      legs[0].tokenIn.address,
      legs[0].tokenOut.address,
    ]);
    expect(combined.subroutes[1].paths[0].tokens.map((t) => t.address)).toEqual([
      legs[1].tokenIn.address,
      legs[1].tokenOut.address,
    ]);
  });

  it('prefers split routes and preserves share weights / stable dex labels', async () => {
    const stableLeg = createLeg(
      '0x0000000000000000000000000000000000000d01',
      '0x0000000000000000000000000000000000000d02',
      '0x0000000000000000000000000000000000000d11',
      'PULSEX_STABLE',
    );
    const v2Leg = createLeg(
      '0x0000000000000000000000000000000000000d03',
      '0x0000000000000000000000000000000000000d04',
      '0x0000000000000000000000000000000000000d22',
      'PULSEX_V2',
    );

    const splitRoutes = [
      createSplitRoute(7000, [stableLeg]),
      createSplitRoute(3000, [v2Leg]),
    ];

    const quoter = {
      quoteBestExactIn: jest.fn().mockResolvedValue(
        baseQuoteResult([], {
          splitRoutes,
          singleRoute: undefined,
        }),
      ),
    };

    const service = new PulseXQuoteService(provider, quoter as any);
    const quote = await service.getQuote({
      tokenInAddress: stableLeg.tokenIn.address,
      tokenOutAddress: v2Leg.tokenOut.address,
      amount: '10000',
    });

    expect(quote.route).toHaveLength(2);
    expect(quote.route[0].percent).toBe(70);
    expect(quote.route[1].percent).toBe(30);
    expect(quote.route[0].subroutes[0].paths[0].exchange).toBe('PulseX Stable');
  });

  it('computes golden minAmountOut based on slippage input', async () => {
    const legs = [
      createLeg(
        pulsexConfig.connectorTokens.find((token) => token.isNative)!.address,
        '0x0000000000000000000000000000000000000e01',
        '0x0000000000000000000000000000000000000e11',
        'PULSEX_V2',
      ),
    ];

    const quoter = {
      quoteBestExactIn: jest.fn().mockResolvedValue(
        baseQuoteResult(legs, {
          totalAmountOut: 5_000n,
        }),
      ),
    };

    const service = new PulseXQuoteService(provider, quoter as any);
    const quote = await service.getQuote({
      tokenInAddress: 'PLS',
      tokenOutAddress: '0x0000000000000000000000000000000000000e01',
      amount: '1000',
      allowedSlippage: 2,
    });

    expect(quote.outputAmount).toBe('5000');
    expect(quote.minAmountOut).toBe('4900');
  });
});
