import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ReferralService } from '../services/ReferralService';
import { ReferralCodeRequest, ReferralCodeByCodeRequest } from '../types/referral';
import { ADDRESS, REFERRAL_CODE } from '../schemas/common';

export default async function referralRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { referralService: ReferralService }
) {
  const { referralService } = options;

  // Get or create referral code for an address
  fastify.get<{ Querystring: ReferralCodeRequest }>(
    '/code',
    {
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
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { address } = request.query;
        const result = await referralService.getOrCreateReferralCode(address);
        return reply.send(result);
      } catch (error) {
        fastify.log.error('Error getting referral code:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // Get address by referral code
  fastify.get<{ Querystring: ReferralCodeByCodeRequest }>(
    '/address',
    {
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
        fastify.log.error('Error getting address by referral code:', error);
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );
} 