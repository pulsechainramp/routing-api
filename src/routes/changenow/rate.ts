import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { ChangeNowService } from '../../services/ChangeNowService';
import { RateService } from '../../services/RateService';

interface RateRequest {
  Querystring: {
    fromCurrency: string;
    toCurrency: string;
    amount: number;
    fromNetwork?: string;
    toNetwork?: string;
    flow?: 'standard' | 'fixed-rate';
  };
}

interface CurrenciesRequest {
  Querystring: {
    active?: boolean;
    flow?: 'standard' | 'fixed-rate';
    buy?: boolean;
    sell?: boolean;
  };
}

interface RatePluginOptions extends FastifyPluginOptions {
  changeNowService: ChangeNowService;
  rateService: RateService;
}

export async function rateRoutes(fastify: FastifyInstance, options: RatePluginOptions) {
  const { changeNowService, rateService } = options;

  fastify.get('/rate', {
    schema: {
      querystring: {
        type: 'object',
        required: ['fromCurrency', 'toCurrency', 'amount'],
        properties: {
          fromCurrency: { type: 'string' },
          toCurrency: { type: 'string' },
          amount: { type: 'number', minimum: 0 },
          fromNetwork: { type: 'string' },
          toNetwork: { type: 'string' },
          flow: { type: 'string', enum: ['standard', 'fixed-rate'] }
        }
      }
    }
  }, async (request: FastifyRequest<RateRequest>, reply: FastifyReply) => {
    try {
      const { fromCurrency, toCurrency, amount, fromNetwork, toNetwork, flow } = request.query;

      const quote = await rateService.getQuote({
        fromCurrency,
        toCurrency,
        amount,
        fromNetwork,
        toNetwork,
        flow
      });

      return reply.send({
        success: true,
        data: quote
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Rate error');
      console.log(error);
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get rate'
      });
    }
  });

  fastify.get('/currencies', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          flow: { type: 'string', enum: ['standard', 'fixed-rate'] },
          buy: { type: 'boolean' },
          sell: { type: 'boolean' }
        }
      }
    }
  }, async (request: FastifyRequest<CurrenciesRequest>, reply: FastifyReply) => {
    try {
      const { active, flow, buy, sell } = request.query;

      const currencies = await changeNowService.getSupportedCurrencies({
        active,
        flow,
        buy,
        sell
      });

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
} 
