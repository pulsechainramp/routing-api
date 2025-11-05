import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ReferralService } from '../services/ReferralService';
import {
  ReferralCodeRequest,
  ReferralCodeByCodeRequest,
  ReferralCodeCreateBody,
  ReferralCreationFeeResponse
} from '../types/referral';
import { ADDRESS, REFERRAL_CODE } from '../schemas/common';
import { ReferralPaymentService } from '../services/ReferralPaymentService';
import config from '../config';

const creationRateLimit = Number(process.env.REFERRAL_CREATION_RATE_LIMIT_MAX ?? 3);
const creationRateWindow = process.env.REFERRAL_CREATION_RATE_LIMIT_WINDOW ?? '1 minute';
const readRateLimit = Number(process.env.REFERRAL_READ_RATE_LIMIT_MAX ?? 60);
const readRateWindow = process.env.REFERRAL_READ_RATE_LIMIT_WINDOW ?? '1 minute';

export default async function referralRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & {
    referralService: ReferralService;
    referralPaymentService: ReferralPaymentService;
  }
) {
  const { referralService, referralPaymentService } = options;

  fastify.get<{ Querystring: ReferralCodeRequest }>(
    '/code',
    {
      config: {
        rateLimit: {
          max: readRateLimit,
          timeWindow: readRateWindow
        }
      },
      schema: {
        querystring: {
          type: 'object',
          required: ['address'],
          properties: {
            address: {
              type: 'string',
              pattern: ADDRESS,
              maxLength: 42
            }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              address: { type: 'string' },
              referralCode: { type: 'string' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' }
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
        const { address } = request.query;
        const result = await referralService.getReferralCodeByAddress(address);
        if (!result) {
          return reply.status(404).send({ error: 'Referral code not found' });
        }
        return reply.send(result);
      } catch (error) {
        fastify.log.error({ err: error }, 'Error retrieving referral code');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.post<{ Body: ReferralCodeCreateBody; Headers: { 'x-idempotency-key'?: string } }>(
    '/code',
    {
      preHandler: fastify.authenticate,
      config: {
        rateLimit: {
          max: creationRateLimit,
          timeWindow: creationRateWindow
        }
      },
      schema: {
        headers: {
          type: 'object',
          required: ['x-idempotency-key'],
          properties: {
            'x-idempotency-key': { type: 'string', minLength: 8, maxLength: 128 }
          },
          additionalProperties: true
        },
        body: {
          type: 'object',
          required: ['address'],
          properties: {
            address: {
              type: 'string',
              pattern: ADDRESS,
              maxLength: 42
            }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              address: { type: 'string' },
              referralCode: { type: 'string' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' }
            }
          },
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              address: { type: 'string' },
              referralCode: { type: 'string' },
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' }
            }
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } }
          },
          401: {
            type: 'object',
            properties: { error: { type: 'string' } }
          },
          402: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              fee: { type: 'string' },
              contractAddress: { type: 'string' }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const userPayload = request.user as { sub?: string } | undefined;
        const userSub = userPayload?.sub;
        const { address } = request.body;
        const normalizedAddress = address.toLowerCase();

        const idempotencyKey = request.headers['x-idempotency-key'];
        if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
          return reply.status(400).send({ error: 'Missing X-Idempotency-Key header' });
        }

        if (!userSub || userSub.toLowerCase() !== normalizedAddress) {
          return reply.status(401).send({ error: 'Wallet authentication mismatch' });
        }

        const fee = await referralPaymentService.getReferralCreationFee();

        if (fee > 0n) {
          const hasPaid = await referralPaymentService.hasPaidReferralCreationFee(address);
          if (!hasPaid) {
            return reply.status(402).send({
              error: 'Referral creation fee required',
              fee: fee.toString(),
              contractAddress: config.AffiliateRouterAddress
            });
          }
        }

        const result = await referralService.createReferralCode(address);

        return reply.status(result.created ? 201 : 200).send(result.user);
      } catch (error) {
        fastify.log.error({ err: error }, 'Error creating referral code');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.get<{ Querystring: ReferralCodeByCodeRequest }>(
    '/address',
    {
      config: {
        rateLimit: {
          max: readRateLimit,
          timeWindow: readRateWindow
        }
      },
      schema: {
        querystring: {
          type: 'object',
          required: ['referralCode'],
          properties: {
            referralCode: {
              type: 'string',
              pattern: REFERRAL_CODE,
              maxLength: 8
            }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: {
              address: { type: 'string' },
              referralCode: { type: 'string' },
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
        const { referralCode } = request.query;
        const result = await referralService.getAddressByReferralCode(referralCode);

        if (!result) {
          return reply.status(404).send({ error: 'Referral code not found' });
        }

        return reply.send(result);
      } catch (error) {
        fastify.log.error({ err: error }, 'Error getting address by referral code');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.get(
    '/creation-fee',
    {
      config: {
        rateLimit: {
          max: readRateLimit,
          timeWindow: readRateWindow
        }
      },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              fee: { type: 'string' },
              contractAddress: { type: 'string' }
            }
          }
        }
      }
    },
    async (_request, reply) => {
      try {
        const fee = await referralPaymentService.getReferralCreationFee();
        const payload: ReferralCreationFeeResponse = {
          fee: fee.toString(),
          contractAddress: config.AffiliateRouterAddress
        };
        return reply.send(payload);
      } catch (error) {
        fastify.log.error({ err: error }, 'Error fetching referral creation fee');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
}
