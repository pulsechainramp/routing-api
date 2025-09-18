import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { PiteasService } from '../services/PiteasService';
import { QuoteController } from '../controllers/QuoteController';
import { ADDRESS } from '../schemas/common';

interface QuotePluginOptions extends FastifyPluginOptions {
  piteasService: PiteasService;
}

export default async function quoteRoutes(
  fastify: FastifyInstance,
  options: QuotePluginOptions
) {
  const { piteasService } = options;
  const quoteController = new QuoteController(piteasService);
  
  fastify.get('/', {
    config: {
      rateLimit: {
        max: Number(process.env.QUOTE_RL_POINTS ?? 60),
        timeWindow: `${Number(process.env.QUOTE_RL_DURATION ?? 60)} seconds`,
        errorResponseBuilder: (request: any, context: any) => ({
          error: 'Too Many Requests - Quote endpoint rate limit exceeded',
          requestId: request.id,
          retryAfter: Math.round(context.ttl / 1000),
        }),
      }
    },
    schema: {
      querystring: {
        type: 'object',
        required: ['tokenInAddress', 'tokenOutAddress', 'amount'],
        properties: {
          tokenInAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          },
          tokenOutAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          },
          amount: { 
            type: 'string',
            maxLength: 50
          },
          allowedSlippage: { 
            type: 'number', 
            minimum: 0,
            maximum: 100,
            default: 0.5 
          },
          account: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          }
        },
        additionalProperties: false
      },
    },
    handler: quoteController.getQuote.bind(quoteController)
  });
} 