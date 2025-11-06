import fastify from 'fastify';
import { setupSwagger } from './swagger';

describe('setupSwagger', () => {
  it('does not expose /docs when disabled', async () => {
    const app = fastify({ logger: false });

    setupSwagger(app, { enabled: false, routePrefix: '/docs' });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('exposes /docs when explicitly enabled', async () => {
    const app = fastify({ logger: false });

    setupSwagger(app, { enabled: true, routePrefix: '/docs' });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');

    await app.close();
  });
});
