import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { OmniBridgeTransactionService } from '../../services/OmniBridgeTransactionService';
import { ADDRESS, TX_HASH } from '../../schemas/common';

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
      fastify.log.error('Get transaction error:', error);
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
      fastify.log.error('Get user transactions error:', error);
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get user transactions'
      });
    }
  });

  // Sync user transactions (fetch from GraphQL and update database)
  fastify.post('/sync', {
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
  }, async (request: FastifyRequest<SyncUserTransactionsRequest>, reply: FastifyReply) => {
    try {
      const { userAddress } = request.query;

      const transactions = await omniBridgeTransactionService.syncUserTransactions(userAddress);

      return reply.send({
        success: true,
        message: 'User transactions synced successfully',
        data: transactions
      });
    } catch (error) {
      fastify.log.error('Sync user transactions error:', error);
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync user transactions'
      });
    }
  });

  // Create new transaction from transaction hash and network ID
  fastify.post('/transaction', {
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
  }, async (request: FastifyRequest<CreateTransactionRequest>, reply: FastifyReply) => {
    try {
      const { txHash, networkId, userAddress } = request.body;

      const transaction = await omniBridgeTransactionService.createTransactionFromTxHash(txHash, networkId, userAddress);

      return reply.send({
        success: true,
        data: transaction
      });
    } catch (error) {
      fastify.log.error('Create transaction error:', error);
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create transaction'
      });
    }
  });
} 