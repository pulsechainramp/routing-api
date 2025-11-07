import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { SiweMessage } from 'siwe';
import { getAddress } from 'ethers';
import { AuthService } from '../services/AuthService';
import { ADDRESS } from '../schemas/common';

const siweStatement = process.env.SIWE_STATEMENT ?? 'Sign in to manage your PulseChain referral code';
const siweUri = process.env.SIWE_URI ?? 'https://pulsechainramp.com';
const siweChainId = Number(process.env.SIWE_CHAIN_ID ?? 369);
const challengeRateLimit = Number(process.env.SIWE_CHALLENGE_RATE_LIMIT_MAX ?? 20);
const challengeRateWindow = process.env.SIWE_CHALLENGE_RATE_LIMIT_WINDOW ?? '1 minute';
const jwtExpiresIn = process.env.JWT_EXPIRES_IN ?? '1h';

type SiweDomainConfig = {
  allowlist: string[];
  allowlistSet: Set<string>;
};

let cachedSiweDomainConfig: SiweDomainConfig | null = null;

function getSiweDomainConfig(): SiweDomainConfig {
  if (cachedSiweDomainConfig) {
    return cachedSiweDomainConfig;
  }

  const allowlist = parseDomainAllowlist(process.env.SIWE_DOMAIN);
  if (allowlist.length === 0) {
    throw new Error(
      'SIWE_DOMAIN environment variable is required. Provide a hostname or comma-separated list of trusted hostnames.'
    );
  }

  cachedSiweDomainConfig = {
    allowlist,
    allowlistSet: new Set(allowlist)
  };

  return cachedSiweDomainConfig;
}

function parseDomainAllowlist(value?: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(part => normalizeDomainCandidate(part))
    .filter((domain): domain is string => Boolean(domain));
}

function normalizeDomainCandidate(candidate?: string | string[] | null): string | undefined {
  if (Array.isArray(candidate)) {
    candidate = candidate[0];
  }

  if (!candidate) {
    return undefined;
  }

  let value = candidate.trim();
  if (!value) {
    return undefined;
  }

  if (value.includes('://')) {
    try {
      const parsed = new URL(value);
      value = parsed.host;
    } catch {
      // fall through to manual parsing
    }
  }

  if (value.startsWith('//')) {
    value = value.slice(2);
  }

  // Drop any path fragments
  const slashIndex = value.indexOf('/');
  if (slashIndex >= 0) {
    value = value.slice(0, slashIndex);
  }

  value = value.toLowerCase();

  if (value.startsWith('[')) {
    const closingIndex = value.indexOf(']');
    if (closingIndex >= 0) {
      return value.slice(0, closingIndex + 1);
    }
    return value;
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex >= 0) {
    value = value.slice(0, colonIndex);
  }

  return value || undefined;
}

function getAllowedRequestDomain(
  request: FastifyRequest,
  allowlistSet: Set<string>
): string | undefined {
  const hostFromFastify = request.hostname;
  const hostFromHeader = request.headers.host;
  const normalizedHost =
    normalizeDomainCandidate(hostFromFastify) ?? normalizeDomainCandidate(hostFromHeader);

  if (!normalizedHost) {
    return undefined;
  }

  if (!allowlistSet.has(normalizedHost)) {
    return undefined;
  }

  return normalizedHost;
}

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
  const { allowlistSet } = getSiweDomainConfig();

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

        const requestDomain = getAllowedRequestDomain(request, allowlistSet);
        if (!requestDomain) {
          request.log.warn(
            { host: request.headers.host },
            'SIWE challenge blocked due to untrusted Host header'
          );
          return reply.status(400).send({ error: 'Host header is not allowed' });
        }

        const nonce = authService.generateNonce(normalizedAddress);

        const message = new SiweMessage({
          domain: requestDomain,
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
        const requestDomain = getAllowedRequestDomain(request, allowlistSet);
        if (!requestDomain) {
          request.log.warn(
            { host: request.headers.host },
            'SIWE verify blocked due to untrusted Host header'
          );
          return reply.status(401).send({ error: 'Host header is not allowed' });
        }

        const messageDomain = normalizeDomainCandidate(siweMessage.domain);
        if (!messageDomain || messageDomain !== requestDomain) {
          request.log.warn(
            { host: request.headers.host, messageDomain: siweMessage.domain },
            'SIWE domain mismatch between request and signed message'
          );
          return reply.status(401).send({ error: 'Invalid SIWE domain' });
        }

        const verification = await siweMessage.verify({
          signature,
          domain: siweMessage.domain,
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
