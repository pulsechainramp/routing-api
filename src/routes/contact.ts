import { FastifyInstance } from 'fastify';
import { ContactController } from '../controllers/ContactController';

export default async function contactRoutes(fastify: FastifyInstance) {
  const controller = new ContactController();

  fastify.post('/contact', {
    config: {
      rateLimit: {
        max: Number(process.env.CONTACT_RATE_LIMIT_MAX ?? 20),
        timeWindow: process.env.CONTACT_RATE_LIMIT_WINDOW ?? '1 minute',
      },
    },
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 256 },
          email: { type: 'string', minLength: 3, maxLength: 320 },
          subject: { type: 'string', maxLength: 256 },
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          source: { type: 'string', maxLength: 128 },
          website: { type: 'string', maxLength: 256 },
        },
        required: ['name', 'email', 'message'],
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        405: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        503: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
    handler: controller.submit.bind(controller),
  });
}
