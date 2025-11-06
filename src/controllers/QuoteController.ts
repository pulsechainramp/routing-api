import { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../utils/logger';
import { PiteasService } from '../services/PiteasService';
import { PulseXQuoteService } from '@/services/PulseXQuoteService';
import { QUOTE_AMOUNT_REGEX } from '../constants/quote';

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

      return quote;
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

      return quote;
    } catch (error) {
      if (error instanceof InvalidQuoteAmountError) {
        reply.code(400).send({ error: 'Invalid request' });
        return;
      }
      logger.error('Error fetching PulseX quote', { error });
      reply.code(500).send({ error: 'Failed to fetch PulseX quote' });
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
