import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { ChangeNowService } from '../../services/ChangeNowService';
import { TransactionService } from '../../services/TransactionService';
import { ADDRESS } from '../../schemas/common';

interface GetTransactionRequest {
  Params: {
    id: string;
  };
}

interface GetUserTransactionsRequest {
  Querystring: {
    userAddress: string;
    limit?: number;
    offset?: number;
  };
}

interface StatusPluginOptions extends FastifyPluginOptions {
  transactionService: TransactionService;
  changeNowService: ChangeNowService;
}

export async function statusRoutes(fastify: FastifyInstance, options: StatusPluginOptions) {
  const { transactionService, changeNowService } = options;

  // Get transaction status
  fastify.get('/order/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<GetTransactionRequest>, reply: FastifyReply) => {
    try {
      const { id } = request.params;

      const transaction = await transactionService.getTransaction(id);
      if (!transaction) {
        return reply.status(404).send({
          success: false,
          error: 'Transaction not found'
        });
      }

      // Get latest status from ChangeNow
      const changenowStatus = await changeNowService.getTransactionStatus(transaction.changenowId);

      // Update local status if different
      if (changenowStatus.status !== transaction.status) {
        await transactionService.updateTransactionStatus(id, changenowStatus.status, {
          payinHash: changenowStatus.payinHash || undefined,
          payoutHash: changenowStatus.payoutHash || undefined,
          toAmount: changenowStatus.amountTo || undefined,
          depositReceivedAt: changenowStatus.depositReceivedAt ? new Date(changenowStatus.depositReceivedAt) : undefined
        });
      }

      return reply.send({
        success: true,
        data: {
          id: transaction.id,
          status: changenowStatus.status,
          fromCurrency: transaction.fromCurrency,
          toCurrency: transaction.toCurrency,
          fromAmount: Number(transaction.fromAmount),
          toAmount: changenowStatus.amountTo || (transaction.toAmount ? Number(transaction.toAmount) : null),
          payinAddress: transaction.payinAddress,
          payinHash: changenowStatus.payinHash,
          payoutHash: changenowStatus.payoutHash,
          createdAt: transaction.createdAt,
          updatedAt: transaction.updatedAt,
          completedAt: transaction.completedAt
        }
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Order status error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get order status'
      });
    }
  });

  // Get user transactions
  fastify.get('/orders', {
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
            default: 20
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
      const { userAddress, limit = 20, offset = 0 } = request.query;

      // Use DB-level pagination instead of fetching all and slicing
      const transactions = await transactionService.getTransactionsByUser(userAddress, limit, offset);

      return reply.send({
        success: true,
        data: transactions.map((tx: any) => ({
          id: tx.id,
          status: tx.status,
          fromCurrency: tx.fromCurrency,
          toCurrency: tx.toCurrency,
          fromAmount: Number(tx.fromAmount),
          toAmount: tx.toAmount ? Number(tx.toAmount) : null,
          createdAt: tx.createdAt,
          completedAt: tx.completedAt
        }))
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Get orders error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get orders'
      });
    }
  });

  // Get transaction stats
  fastify.get('/stats', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await transactionService.getTransactionStats();

      return reply.send({
        success: true,
        data: stats
      });
    } catch (error) {
      fastify.log.error({ err: error }, 'Stats error');
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get stats'
      });
    }
  });
} 
