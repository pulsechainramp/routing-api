import fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { getClientIp } from "./utils/network";

describe("rate limit key generation", () => {
  it("keys by Fastify's client IP when trustProxy is enabled", async () => {
    const app = fastify({ trustProxy: true });

    await app.register(rateLimit, {
      global: true,
      max: 1,
      timeWindow: "1 minute",
      keyGenerator: (request) => getClientIp(request),
    });

    app.get("/test", {
      config: {
        rateLimit: {
          max: 1,
          timeWindow: "1 minute",
          keyGenerator: (request: any) => getClientIp(request),
        },
      },
      handler: async () => ({ ok: true }),
    });

    await app.ready();

    const clientAFirst = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.10",
      },
    });
    expect(clientAFirst.statusCode).toBe(200);

    const clientASecond = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.10",
      },
    });
    expect(clientASecond.statusCode).toBe(429);

    const clientB = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.11",
      },
    });
    expect(clientB.statusCode).toBe(200);

    await app.close();
  });

  it("falls back to socket IPs when trustProxy is disabled", async () => {
    const app = fastify({ trustProxy: false });

    await app.register(rateLimit, {
      global: true,
      max: 1,
      timeWindow: "1 minute",
      keyGenerator: (request) => getClientIp(request),
    });

    app.get("/test", {
      config: {
        rateLimit: {
          max: 1,
          timeWindow: "1 minute",
          keyGenerator: (request: any) => getClientIp(request),
        },
      },
      handler: async () => ({ ok: true }),
    });

    await app.ready();

    const first = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.10",
      },
    });
    expect(first.statusCode).toBe(200);

    const spoofed = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.11",
      },
    });
    expect(spoofed.statusCode).toBe(429);

    const differentSocket = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.99",
      headers: {
        "x-forwarded-for": "198.51.100.12",
      },
    });
    expect(differentSocket.statusCode).toBe(200);

    await app.close();
  });
});
