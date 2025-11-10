import { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../utils/logger';
import { PiteasService } from '../services/PiteasService';
import { PulseXQuoteService } from '@/services/PulseXQuoteService';
import { QUOTE_AMOUNT_REGEX } from '../constants/quote';
import { QuoteAttestationRequest } from '../types/QuoteAttestation';
import { QuoteResponse } from '../types/QuoteResponse';
import { decodeSwapRouteSummary } from '../utils/routeEncoding';
import { signQuoteResponse } from '../utils/quoteIntegrity';
import config from '../config';

const logger = new Logger('QuoteController');

interface QuoteQuery {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
}

class InvalidQuoteAmountError extends Error {
  constructor() {
    super('Invalid quote amount');
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const normalizeAddress = (value: string | undefined | null): string =>
  (value ?? '').trim().toLowerCase();

const isNativeAddress = (value: string): boolean => {
  const normalized = normalizeAddress(value);
  if (!normalized) {
    return false;
  }

  return (
    normalized === 'pls' ||
    normalized === '0x0' ||
    normalized === ZERO_ADDRESS ||
    normalized === normalizeAddress(config.WPLS)
  );
};

const addressesMatch = (a?: string | null, b?: string | null): boolean => {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  return isNativeAddress(left) && isNativeAddress(right);
};

const assertCondition = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

export class QuoteController {
  constructor(private piteasService: PiteasService, private pulseXQuoteService: PulseXQuoteService) {}

  async getQuote(request: FastifyRequest<{ Querystring: QuoteQuery }>, reply: FastifyReply) {
    try {
      const { 
        tokenInAddress, 
        tokenOutAddress, 
        amount, 
        allowedSlippage = 0.5,
        account 
      } = request.query;

      const normalizedAmount = this.normalizeAmount(amount);

      const quote = await this.piteasService.getQuote({
        tokenInAddress,
        tokenOutAddress,
        amount: normalizedAmount,
        allowedSlippage,
        account
      });

      return await signQuoteResponse(quote, { allowedSlippage });
    } catch (error) {
      if (error instanceof InvalidQuoteAmountError) {
        reply.code(400).send({ error: 'Invalid request' });
        return;
      }
      logger.error('Error fetching quote', { error });
      reply.code(500).send({ error: 'Failed to fetch quote' });
    }
  }

  async getPulseXQuote(request: FastifyRequest<{ Querystring: QuoteQuery }>, reply: FastifyReply) {
    try {
      const { tokenInAddress, tokenOutAddress, amount, allowedSlippage = 0.5, account } = request.query;
      const normalizedAmount = this.normalizeAmount(amount);

      const quote = await this.pulseXQuoteService.getQuote({
        tokenInAddress,
        tokenOutAddress,
        amount: normalizedAmount,
        allowedSlippage,
        account
      });

      return await signQuoteResponse(quote, { allowedSlippage });
    } catch (error) {
      if (error instanceof InvalidQuoteAmountError) {
        reply.code(400).send({ error: 'Invalid request' });
        return;
      }
      logger.error('Error fetching PulseX quote', { error });
      reply.code(500).send({ error: 'Failed to fetch PulseX quote' });
    }
  }

  async attestQuote(request: FastifyRequest<{ Body: QuoteAttestationRequest }>, reply: FastifyReply) {
    try {
      const { quote, context } = request.body;

      if (!quote || !context) {
        reply.code(400).send({ error: 'Invalid request' });
        return;
      }

      const summary = decodeSwapRouteSummary(quote.calldata);

      const requestedTokenIn = normalizeAddress(context.tokenInAddress);
      const requestedTokenOut = normalizeAddress(context.tokenOutAddress);

      assertCondition(requestedTokenIn.length > 0, 'tokenInAddress is required');
      assertCondition(requestedTokenOut.length > 0, 'tokenOutAddress is required');

      const routerAddress = normalizeAddress(context.routerAddress);
      assertCondition(routerAddress.length > 0, 'routerAddress is required');
      assertCondition(
        routerAddress === normalizeAddress(config.AffiliateRouterAddress),
        'Router address mismatch'
      );

      const allowedChainId = Number(process.env.QUOTE_CHAIN_ID ?? 369);
      assertCondition(context.chainId === allowedChainId, 'Unsupported chainId for attestation');

      assertCondition(
        addressesMatch(quote.tokenInAddress, context.tokenInAddress),
        'Quote tokenIn mismatch'
      );
      assertCondition(
        addressesMatch(quote.tokenOutAddress, context.tokenOutAddress),
        'Quote tokenOut mismatch'
      );

      assertCondition(
        addressesMatch(summary.tokenIn, context.tokenInAddress),
        'Calldata tokenIn mismatch'
      );
      assertCondition(
        addressesMatch(summary.tokenOut, context.tokenOutAddress),
        'Calldata tokenOut mismatch'
      );

      const amountInWei = BigInt(summary.amountIn).toString();
      assertCondition(
        amountInWei === context.amountInWei,
        'Calldata amountIn does not match UI amount'
      );

      const minAmountOutWei = BigInt(summary.amountOutMin).toString();
      assertCondition(
        BigInt(minAmountOutWei) >= BigInt(context.minAmountOutWei),
        'Calldata minAmountOut is below UI tolerance'
      );

      assertCondition(
        BigInt(quote.outputAmount) >= BigInt(minAmountOutWei),
        'Quote output is below enforced minimum'
      );

      const deadline = Number(summary.deadline);
      const now = Math.floor(Date.now() / 1000);
      assertCondition(deadline > now, 'Quote deadline already expired');
      const maxHorizon = Number(process.env.QUOTE_MAX_DEADLINE_SECONDS ?? 600);
      assertCondition(deadline - now <= maxHorizon, 'Quote deadline exceeds policy window');

      const normalizedQuote: QuoteResponse = {
        ...quote,
        amountIn: amountInWei,
        minAmountOut: minAmountOutWei,
        deadline,
        gasAmountEstimated: quote.gasAmountEstimated ?? 0,
        gasUSDEstimated: quote.gasUSDEstimated ?? 0,
      };

      const signedQuote = await signQuoteResponse(normalizedQuote, {
        allowedSlippage: context.slippageBps / 100,
      });

      reply.send({ integrity: signedQuote.integrity });
    } catch (error) {
      const err =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) };

      logger.error('Quote attestation failed', err);

      reply.code(400).send({
        error: 'Quote attestation failed',
        reason: error instanceof Error ? error.message : undefined,
      });
    }
  }

  private normalizeAmount(amount: string): string {
    const trimmed = (amount ?? '').trim();
    if (!trimmed || !QUOTE_AMOUNT_REGEX.test(trimmed)) {
      throw new InvalidQuoteAmountError();
    }
    return trimmed;
  }
}
