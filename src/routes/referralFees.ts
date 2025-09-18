import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ReferralFeeService } from '../services/ReferralFeeService';

export default async function referralFeeRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { referralFeeService: ReferralFeeService }
) {
  const { referralFeeService } = options;

  // Get referral fee for specific referrer and token
  fastify.get<{ Querystring: { referrer: string; token: string } }>(
    '/fee',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['referrer', 'token'],
          properties: {
            referrer: { type: 'string' },
            token: { type: 'string' }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              referrer: { type: 'string' },
              token: { type: 'string' },
              amount: { type: 'string' },
              lastUpdated: { type: 'string' },
              createdAt: { type: 'string' }
            }
          },
          404: {
            type: 'object',
            properties: {
              error: { type: 'string' }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { referrer, token } = request.query;
        const result = await referralFeeService.getReferralFee(referrer, token);
        
        if (!result) {
          return reply.status(404).send({ error: 'Referral fee not found' });
        }
        
        return reply.send(result);
      } catch (error) {
        fastify.log.error('Error getting referral fee:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get all referral fees for a specific referrer
  fastify.get<{ Querystring: { referrer: string } }>(
    '/referrer/:referrer',
    {
      schema: {
        params: {
          type: 'object',
          required: ['referrer'],
          properties: {
            referrer: { type: 'string' }
          }
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                referrer: { type: 'string' },
                token: { type: 'string' },
                amount: { type: 'string' },
                lastUpdated: { type: 'string' },
                createdAt: { type: 'string' }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { referrer } = request.params as { referrer: string };
        const result = await referralFeeService.getReferralFeesByReferrer(referrer);
        return reply.send(result);
      } catch (error) {
        fastify.log.error('Error getting referral fees by referrer:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get all referral fees for a specific token
  fastify.get<{ Querystring: { token: string } }>(
    '/token/:token',
    {
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string' }
          }
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                referrer: { type: 'string' },
                token: { type: 'string' },
                amount: { type: 'string' },
                lastUpdated: { type: 'string' },
                createdAt: { type: 'string' }
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { token } = request.params as { token: string };
        const result = await referralFeeService.getReferralFeesByToken(token);
        return reply.send(result);
      } catch (error) {
        fastify.log.error('Error getting referral fees by token:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get total referral fees statistics
  fastify.get(
    '/totals',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              totalAmount: { type: 'string' },
              totalReferrers: { type: 'number' },
              totalTokens: { type: 'number' }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const result = await referralFeeService.getTotalReferralFees();
        return reply.send(result);
      } catch (error) {
        fastify.log.error('Error getting total referral fees:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );








} 