import { FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../utils/logger';
import { PiteasService } from '../services/PiteasService';

const logger = new Logger('QuoteController');

interface QuoteQuery {
  tokenInAddress: string;
  tokenOutAddress: string;
  amount: string;
  allowedSlippage?: number;
  account?: string;
  allowedDexes?: string;   // CSV
  blockedDexes?: string;   // CSV
  policy?: 'strict' | 'soft'; // default: 'strict'
}

export class QuoteController {
  constructor(private piteasService: PiteasService) {}

  async getQuote(request: FastifyRequest<{ Querystring: QuoteQuery }>, reply: FastifyReply) {
    try {
      const { tokenInAddress, tokenOutAddress, amount, allowedSlippage = 0.5, account,
              allowedDexes, blockedDexes, policy } = request.query;

      const quote = await this.piteasService.getQuote({
        tokenInAddress, tokenOutAddress, amount, allowedSlippage, account,
        allowedDexes, blockedDexes, policy
      });

      return quote;
    } catch (error: any) {
      logger.error('Error fetching quote', { error });
      const code = error?.statusCode ?? 500;
      reply.code(code).send({ error: error?.message || 'Failed to fetch quote', details: error?.details });
    }
  }
}