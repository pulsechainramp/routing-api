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
}

export class QuoteController {
  constructor(private piteasService: PiteasService) {}

  async getQuote(request: FastifyRequest<{ Querystring: QuoteQuery }>, reply: FastifyReply) {
    try {
      const { 
        tokenInAddress, 
        tokenOutAddress, 
        amount, 
        allowedSlippage = 0.5,
        account 
      } = request.query;

      const quote = await this.piteasService.getQuote({
        tokenInAddress,
        tokenOutAddress,
        amount,
        allowedSlippage,
        account
      });

      return quote;
    } catch (error) {
      logger.error('Error fetching quote', { error });
      reply.code(500).send({ error: 'Failed to fetch quote' });
    }
  }
} 