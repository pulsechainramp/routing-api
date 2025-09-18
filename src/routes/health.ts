import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { PrismaClient } from '../generated/prisma-client';

interface HealthPluginOptions extends FastifyPluginOptions {
  prisma: PrismaClient;
}

export default async function healthRoutes(
  fastify: FastifyInstance,
  options: HealthPluginOptions
) {
  const { prisma } = options;

  fastify.get('/', {
    config: {
      rateLimit: false // Health checks should not be rate limited
    }
  }, async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected' };
    } catch (error) {
      return { status: 'error', database: 'disconnected' };
    }
  });
} 