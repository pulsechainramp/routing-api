import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { PiteasService } from '../services/PiteasService';
import { QuoteController } from '../controllers/QuoteController';
import { ADDRESS } from '../schemas/common';
import { PulseXQuoteService } from '@/services/PulseXQuoteService';
import { getClientIp } from '../utils/network';
import { QUOTE_AMOUNT_MAX_DIGITS, QUOTE_AMOUNT_REGEX } from '../constants/quote';

interface QuotePluginOptions extends FastifyPluginOptions {
  piteasService: PiteasService;
  pulseXQuoteService: PulseXQuoteService;
}

export default async function quoteRoutes(
  fastify: FastifyInstance,
  options: QuotePluginOptions
) {
  const { piteasService, pulseXQuoteService } = options;
  const quoteController = new QuoteController(piteasService, pulseXQuoteService);
  

  fastify.get('/pulsex', {
    config: {
      rateLimit: {
        max: Number(process.env.QUOTE_RL_POINTS ?? 60),
        timeWindow: `${Number(process.env.QUOTE_RL_DURATION ?? 60)} seconds`,
        keyGenerator: (request: any) => getClientIp(request),
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
            pattern: QUOTE_AMOUNT_REGEX.source,
            maxLength: QUOTE_AMOUNT_MAX_DIGITS
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
    handler: quoteController.getPulseXQuote.bind(quoteController)
  });
  
  fastify.get('/', {
    config: {
      rateLimit: {
        max: Number(process.env.QUOTE_RL_POINTS ?? 60),
        timeWindow: `${Number(process.env.QUOTE_RL_DURATION ?? 60)} seconds`,
        keyGenerator: (request: any) => getClientIp(request),
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
            pattern: QUOTE_AMOUNT_REGEX.source,
            maxLength: QUOTE_AMOUNT_MAX_DIGITS
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
  
  fastify.post('/attest', {
    schema: {
      body: {
        type: 'object',
        required: ['quote', 'context'],
        properties: {
          quote: {
            type: 'object',
            required: ['calldata', 'tokenInAddress', 'tokenOutAddress', 'outputAmount', 'gasUSDEstimated', 'route'],
            properties: {
              calldata: { type: 'string' },
              tokenInAddress: { type: 'string', pattern: ADDRESS },
              tokenOutAddress: { type: 'string', pattern: ADDRESS },
              outputAmount: { type: 'string' },
              gasUSDEstimated: { type: 'number' },
              gasAmountEstimated: { type: 'number' },
              route: { type: 'array' },
            },
          },
          context: {
            type: 'object',
            required: [
              'tokenInAddress',
              'tokenOutAddress',
              'amountInWei',
              'minAmountOutWei',
              'slippageBps',
              'recipient',
              'routerAddress',
              'chainId',
            ],
            properties: {
              tokenInAddress: { type: 'string', pattern: ADDRESS },
              tokenOutAddress: { type: 'string', pattern: ADDRESS },
              amountInWei: { type: 'string' },
              minAmountOutWei: { type: 'string' },
              slippageBps: { type: 'integer', minimum: 0, maximum: 10000 },
              recipient: { type: 'string', pattern: ADDRESS },
              routerAddress: { type: 'string', pattern: ADDRESS },
              chainId: { type: 'integer', minimum: 0 },
              referrerAddress: { type: 'string', pattern: ADDRESS },
            },
          },
        },
      },
    },
    handler: quoteController.attestQuote.bind(quoteController),
  });
}
