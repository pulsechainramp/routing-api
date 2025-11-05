import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SiweMessage } from 'siwe';
import { getAddress } from 'ethers';
import { AuthService } from '../services/AuthService';
import { ADDRESS } from '../schemas/common';

const siweStatement = process.env.SIWE_STATEMENT ?? 'Sign in to manage your PulseChain referral code';
const siweUri = process.env.SIWE_URI ?? 'https://pulsechainramp.com';
const siweDomainFromEnv = process.env.SIWE_DOMAIN;
const siweChainId = Number(process.env.SIWE_CHAIN_ID ?? 369);
const challengeRateLimit = Number(process.env.SIWE_CHALLENGE_RATE_LIMIT_MAX ?? 20);
const challengeRateWindow = process.env.SIWE_CHALLENGE_RATE_LIMIT_WINDOW ?? '1 minute';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN ?? '1h';

interface ChallengeQuery {
  address: string;
}

interface VerifyBody {
  message: string;
  signature: string;
}

export default async function authRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions & { authService: AuthService }
) {
  const { authService } = options;

  fastify.get<{ Querystring: ChallengeQuery }>(
    '/challenge',
    {
      config: {
        rateLimit: {
          max: challengeRateLimit,
          timeWindow: challengeRateWindow
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
              nonce: { type: 'string' },
              message: { type: 'string' }
            }
          }
        }
      }
    },
    async (request, reply) => {
      try {
        const { address } = request.query;
        let normalizedAddress: string;
        try {
          normalizedAddress = getAddress(address);
        } catch (addrErr) {
          request.log.warn({ err: addrErr, address }, 'Invalid address for SIWE challenge');
          return reply.status(400).send({ error: 'Invalid wallet address' });
        }

        const nonce = authService.generateNonce(normalizedAddress);
        const domain = siweDomainFromEnv ?? request.hostname;

        const message = new SiweMessage({
          domain,
          address: normalizedAddress,
          statement: siweStatement,
          uri: siweUri,
          version: '1',
          chainId: siweChainId,
          nonce,
          issuedAt: new Date().toISOString()
        });

        return reply.send({ nonce, message: message.prepareMessage() });
      } catch (error) {
        request.log.error({ err: error }, 'Error generating SIWE challenge');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  fastify.post<{ Body: VerifyBody }>(
    '/verify',
    {
      config: {
        rateLimit: {
          max: challengeRateLimit,
          timeWindow: challengeRateWindow
        }
      },
      schema: {
        body: {
          type: 'object',
          required: ['message', 'signature'],
          properties: {
            message: { type: 'string', minLength: 1 },
            signature: { type: 'string', minLength: 1 }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              address: { type: 'string' }
            }
          },
          401: {
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
        const { message, signature } = request.body;
        const siweMessage = new SiweMessage(message);
        const domain = siweDomainFromEnv ?? request.hostname;

        const verification = await siweMessage.verify({
          signature,
          domain,
          nonce: siweMessage.nonce
        });

        if (!verification.success) {
          return reply.status(401).send({ error: 'Invalid SIWE signature' });
        }

        const address = verification.data.address.toLowerCase();
        const nonceValid = authService.consumeNonce(siweMessage.nonce, address);
        if (!nonceValid) {
          return reply.status(401).send({ error: 'Challenge expired or already used' });
        }

        const token = await fastify.jwt.sign(
          { sub: address },
          { expiresIn: jwtExpiresIn }
        );

        return reply.send({ token, address });
      } catch (error) {
        request.log.error({ err: error }, 'Error verifying SIWE signature');
        return reply.status(401).send({ error: 'Authentication failed' });
      }
    }
  );
}
