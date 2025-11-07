import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { OmniBridgeTransactionService } from '../../services/OmniBridgeTransactionService';
import { ADDRESS, TX_HASH } from '../../schemas/common';
import { getClientIp } from '../../utils/network';

interface GetTransactionRequest {
  Params: {
    messageId: string;
  };
}

interface GetUserTransactionsRequest {
  Querystring: {
    userAddress: string;
    limit?: number;
    offset?: number;
  };
}

interface SyncUserTransactionsRequest {
  Querystring: {
    userAddress: string;
  };
}

interface CreateTransactionRequest {
  Body: {
    txHash: string;
    networkId: number;
    userAddress: string;
  };
}

interface TransactionPluginOptions extends FastifyPluginOptions {
  omniBridgeTransactionService: OmniBridgeTransactionService;
}

type AuthenticatedCreateRequest = FastifyRequest<CreateTransactionRequest> & { user?: { sub?: string } };
type AuthenticatedSyncRequest = FastifyRequest<SyncUserTransactionsRequest> & { user?: { sub?: string } };

const createRateLimitMax = Number(process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_MAX ?? 5);
const createRateLimitWindow = process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_WINDOW ?? '1 minute';
const createRateLimitBan = Number(process.env.OMNIBRIDGE_CREATE_RATE_LIMIT_BAN ?? 0);
const syncRateLimitMax = Number(process.env.OMNIBRIDGE_SYNC_RATE_LIMIT_MAX ?? 2);
const syncRateLimitWindow = process.env.OMNIBRIDGE_SYNC_RATE_LIMIT_WINDOW ?? '10 minutes';
const syncRateLimitBan = Number(process.env.OMNIBRIDGE_SYNC_RATE_LIMIT_BAN ?? 0);

function isCreateEnabled(): boolean {
  const flag = process.env.OMNIBRIDGE_CREATE_ENABLED ?? 'true';
  return flag.toLowerCase() !== 'false';
}

export async function transactionRoutes(fastify: FastifyInstance, options: TransactionPluginOptions) {
  const { omniBridgeTransactionService } = options;

  // Get transaction by message ID
  fastify.get('/transaction/:messageId', {
    schema: {
      params: {
        type: 'object',
        required: ['messageId'],
        properties: {
          messageId: { 
            type: 'string',
          }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<GetTransactionRequest>, reply: FastifyReply) => {
    try {
      const { messageId } = request.params;

      const transaction = await omniBridgeTransactionService.getTransactionStatus(messageId);

      return reply.send({
        success: true,
        data: transaction
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Get transaction error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get transaction'
      });
    }
  });

  // Get user transactions
  fastify.get('/transactions', {
    schema: {
      querystring: {
        type: 'object',
        required: ['userAddress'],
        properties: {
          userAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          },
          limit: { 
            type: 'number', 
            minimum: 1, 
            maximum: 100,
            default: 50
          },
          offset: { 
            type: 'number', 
            minimum: 0,
            maximum: 10000,
            default: 0
          }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<GetUserTransactionsRequest>, reply: FastifyReply) => {
    try {
      const { userAddress, limit = 50, offset = 0 } = request.query;

      const transactions = await omniBridgeTransactionService.getUserTransactions(userAddress, limit, offset);

      return reply.send({
        success: true,
        data: transactions
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Get user transactions error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user transactions'
      });
    }
  });

  // Sync user transactions (fetch from GraphQL and update database)
  fastify.post<{ Querystring: SyncUserTransactionsRequest['Querystring'] }>('/sync', {
    preHandler: [
      fastify.authenticate,
      async (request: AuthenticatedSyncRequest, reply: FastifyReply) => {
        const userSub = request.user?.sub?.toLowerCase();
        const queryAddress = request.query.userAddress.toLowerCase();

        if (!userSub || userSub !== queryAddress) {
          return reply.status(401).send({
            success: false,
            error: 'Wallet authentication mismatch'
          });
        }
      }
    ],
    config: {
      rateLimit: (() => {
        const rateLimitConfig: any = {
          max: syncRateLimitMax,
          timeWindow: syncRateLimitWindow,
          keyGenerator: (req: any) => (req.user?.sub?.toLowerCase()) || getClientIp(req)
        };

        if (syncRateLimitBan > 0) {
          rateLimitConfig.ban = syncRateLimitBan;
        }

        return rateLimitConfig;
      })()
    },
    schema: {
      querystring: {
        type: 'object',
        required: ['userAddress'],
        properties: {
          userAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply: FastifyReply) => {
    try {
      const { userAddress } = request.query;

      const transactions = await omniBridgeTransactionService.syncUserTransactions(userAddress);

      return reply.send({
        success: true,
        message: 'User transactions synced successfully',
        data: transactions
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Sync user transactions error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync user transactions'
      });
    }
  });

  // Create new transaction from transaction hash and network ID
  fastify.post('/transaction', {
    preHandler: [
      fastify.authenticate,
      async (request: AuthenticatedCreateRequest, reply: FastifyReply) => {
        const userSub = request.user?.sub?.toLowerCase();
        const bodyAddress = request.body.userAddress.toLowerCase();

        if (!userSub || userSub !== bodyAddress) {
          return reply.status(401).send({
            success: false,
            error: 'Wallet authentication mismatch'
          });
        }
      }
    ],
    config: {
      rateLimit: (() => {
        const rateLimitConfig: any = {
          max: createRateLimitMax,
          timeWindow: createRateLimitWindow,
          keyGenerator: (req: any) => (req.user?.sub?.toLowerCase()) || getClientIp(req)
        };

        if (createRateLimitBan > 0) {
          rateLimitConfig.ban = createRateLimitBan;
        }

        return rateLimitConfig;
      })()
    },
    schema: {
      body: {
        type: 'object',
        required: ['txHash', 'networkId', 'userAddress'],
        properties: {
          txHash: { 
            type: 'string',
            pattern: TX_HASH,
            maxLength: 66
          },
          networkId: { 
            type: 'number',
            enum: [1, 369] // Only Ethereum (1) and PulseChain (369)
          },
          userAddress: { 
            type: 'string',
            pattern: ADDRESS,
            maxLength: 42
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply: FastifyReply) => {
    if (!isCreateEnabled()) {
      return reply.status(503).send({
        success: false,
        error: 'OmniBridge transaction creation is temporarily disabled'
      });
    }

    try {
      const { txHash, networkId, userAddress } = (request as FastifyRequest<CreateTransactionRequest>).body;

      const transaction = await omniBridgeTransactionService.createTransactionFromTxHash(txHash, networkId, userAddress);

      return reply.send({
        success: true,
        data: transaction
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Create transaction error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create transaction'
      });
    }
  });
} 
