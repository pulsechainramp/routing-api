import { FastifyInstance, FastifyReply, FastifyPluginOptions } from 'fastify';
import { ReferralFeeService } from '../services/ReferralFeeService';

const feeReadRateLimit = Number(process.env.REFERRAL_FEES_RATE_LIMIT_MAX ?? 120);
const feeReadRateWindow = process.env.REFERRAL_FEES_RATE_LIMIT_WINDOW ?? '1 minute';
const referralFeeAdminAddresses = new Set(
  (process.env.REFERRAL_FEES_ADMIN_ADDRESSES ?? '')
    .split(',')
    .map(address => address.trim().toLowerCase())
    .filter(Boolean)
);

function getUserSub(request: any): string | undefined {
  return request?.user?.sub?.toLowerCase?.();
}

function verifyReferrerAccess(referrer: string, request: any, reply: FastifyReply) {
  const userSub = getUserSub(request);
  if (!userSub || userSub !== referrer.toLowerCase()) {
    reply.status(401).send({
      success: false,
      error: 'Wallet authentication mismatch'
    });
    return false;
  }
  return true;
}

function verifyAdminAccess(request: any, reply: FastifyReply) {
  const userSub = getUserSub(request);
  if (!userSub) {
    reply.status(401).send({
      success: false,
      error: 'Unauthorized'
    });
    return false;
  }

  if (!referralFeeAdminAddresses.has(userSub)) {
    reply.status(403).send({
      success: false,
      error: 'Forbidden'
    });
    return false;
  }

  return true;
}

export default async function referralFeeRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { referralFeeService: ReferralFeeService }
) {
  const { referralFeeService } = options;

  // Get referral fee for specific referrer and token
  fastify.get<{ Querystring: { referrer: string; token: string } }>(
    '/fee',
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (!verifyReferrerAccess(request.query.referrer, request, reply)) {
            return reply;
          }
        }
      ],
      config: {
        rateLimit: {
          max: feeReadRateLimit,
          timeWindow: feeReadRateWindow,
          keyGenerator: (req: any) => req.user?.sub?.toLowerCase()
        }
      },
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
        fastify.log.error({ err: error }, 'Error getting referral fee');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get all referral fees for a specific referrer
  fastify.get<{ Params: { referrer: string } }>(
    '/referrer/:referrer',
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (!verifyReferrerAccess(request.params.referrer, request, reply)) {
            return reply;
          }
        }
      ],
      config: {
        rateLimit: {
          max: feeReadRateLimit,
          timeWindow: feeReadRateWindow,
          keyGenerator: (req: any) => req.user?.sub?.toLowerCase()
        }
      },
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
        fastify.log.error({ err: error }, 'Error getting referral fees by referrer');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get all referral fees for a specific token
  fastify.get<{ Params: { token: string } }>(
    '/token/:token',
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (!verifyAdminAccess(request, reply)) {
            return reply;
          }
        }
      ],
      config: {
        rateLimit: {
          max: feeReadRateLimit,
          timeWindow: feeReadRateWindow,
          keyGenerator: (req: any) => req.user?.sub?.toLowerCase()
        }
      },
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
        fastify.log.error({ err: error }, 'Error getting referral fees by token');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get total referral fees statistics
  fastify.get(
    '/totals',
    {
      preHandler: [
        fastify.authenticate,
        async (request, reply) => {
          if (!verifyAdminAccess(request, reply)) {
            return reply;
          }
        }
      ],
      config: {
        rateLimit: {
          max: feeReadRateLimit,
          timeWindow: feeReadRateWindow,
          keyGenerator: (req: any) => req.user?.sub?.toLowerCase()
        }
      },
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
        fastify.log.error({ err: error }, 'Error getting total referral fees');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );








} 
