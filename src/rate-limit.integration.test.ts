import fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { getClientIp } from "./utils/network";

describe("rate limit key generation", () => {
  it("uses raw socket IP so spoofed X-Forwarded-For headers do not bypass limits", async () => {
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

    // Initial request should succeed
    const first = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.10",
      },
    });
    expect(first.statusCode).toBe(200);

    // Second request spoofing a new XFF value should still be limited
    const second = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.5",
      headers: {
        "x-forwarded-for": "198.51.100.11",
      },
    });
    expect(second.statusCode).toBe(429);

    // Different socket IP should have its own quota
    const third = await app.inject({
      method: "GET",
      url: "/test",
      remoteAddress: "203.0.113.99",
      headers: {
        "x-forwarded-for": "198.51.100.12",
      },
    });
    expect(third.statusCode).toBe(200);

    await app.close();
  });
});
