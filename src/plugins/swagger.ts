import type { FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

type SwaggerOptions = {
  enabled: boolean;
  routePrefix?: string;
};

const DEFAULT_ROUTE_PREFIX = '/docs';

export function setupSwagger(app: FastifyInstance, options: SwaggerOptions): void {
  if (!options.enabled) {
    app.log.info({ routePrefix: options.routePrefix ?? DEFAULT_ROUTE_PREFIX }, 'Swagger disabled');
    return;
  }

  const routePrefix = options.routePrefix ?? DEFAULT_ROUTE_PREFIX;

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Admin Service API',
        description: 'API Documentation for Admin Service',
        version: '1.0.0',
      },
    },
  });

  app.register(fastifySwaggerUi, {
    routePrefix,
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false,
    },
  });

  app.log.info({ routePrefix }, 'Swagger enabled');
}
