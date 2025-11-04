import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { OmniBridgeService } from '../../services/OmniBridgeService';
import { ADDRESS } from '../../schemas/common';

interface CurrenciesRequest {
  Querystring: {
    chainId?: number;
    verified?: boolean;
  };
}

interface EstimateRequest {
  Querystring: {
    tokenAddress: string;
    networkId: number;
    amount?: string;
  };
}

interface RatePluginOptions extends FastifyPluginOptions {
  omniBridgeService: OmniBridgeService;
}

export async function rateRoutes(fastify: FastifyInstance, options: RatePluginOptions) {
  const { omniBridgeService } = options;

  // Get supported currencies
  fastify.get('/currencies', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          chainId: { 
            type: 'number',
            enum: [1, 369] // Only Ethereum (1) and PulseChain (369)
          },
          verified: { type: 'boolean' }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<CurrenciesRequest>, reply: FastifyReply) => {
    try {
      const { chainId, verified } = request.query;

      let currencies = await omniBridgeService.getSupportedCurrencies();

      // Filter by chainId if provided
      if (chainId) {
        currencies = currencies.filter(currency => currency.chainId === chainId);
      }

      // Filter by verified status if provided
      if (verified !== undefined) {
        currencies = currencies.filter(currency => 
          verified ? currency.tags.includes('verified') : !currency.tags.includes('verified')
        );
      }

      return reply.send({
        success: true,
        data: currencies
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Currencies error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get currencies'
      });
    }
  });

  // Get estimated amount
  fastify.get('/estimate', {
    schema: {
      querystring: {
        type: 'object',
        required: ['tokenAddress', 'networkId'],
        properties: {
          tokenAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          },
          networkId: { 
            type: 'number',
            enum: [1, 369] // Only Ethereum (1) and PulseChain (369)
          },
          amount: { 
            type: 'string',
          }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<EstimateRequest>, reply: FastifyReply) => {
    try {
      const { tokenAddress, networkId, amount = '0' } = request.query;

      const estimate = await omniBridgeService.getEstimatedAmount({
        tokenAddress,
        networkId,
        amount
      });

      return reply.send({
        success: true,
        data: estimate
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Estimate error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get estimate'
      });
    }
  });
} 
