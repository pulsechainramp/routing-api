import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { ChangeNowService } from '../../services/ChangeNowService';
import { TransactionService } from '../../services/TransactionService';

interface CreateTradeRequest {
  Body: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: number;
    userAddress: string;
    fromNetwork?: string;
    toNetwork?: string;
    refundAddress?: string;
  };
}

interface SwapPluginOptions extends FastifyPluginOptions {
  changeNowService: ChangeNowService;
  transactionService: TransactionService;
}

export async function swapRoutes(fastify: FastifyInstance, options: SwapPluginOptions) {
  const { changeNowService, transactionService } = options;

  fastify.post('/trade', {
    schema: {
      body: {
        type: 'object',
        required: ['fromCurrency', 'toCurrency', 'fromAmount', 'userAddress', 'fromNetwork', 'toNetwork'],
        properties: {
          fromCurrency: { type: 'string' },
          toCurrency: { type: 'string' },
          fromAmount: { type: 'number', minimum: 0 },
          userAddress: { type: 'string' },
          fromNetwork: { type: 'string' },
          toNetwork: { type: 'string' },
          refundAddress: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<CreateTradeRequest>, reply: FastifyReply) => {
    try {
      const swapResult = await transactionService.createSwap(request.body);

      return reply.send({
        success: true,
        data: swapResult
      });
    } catch (error) {
      fastify.log.error('Trade error:', error);
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create trade'
      });
    }
  });
} 