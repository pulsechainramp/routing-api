import { getClientIp } from "./network";
import type { FastifyRequest } from "fastify";

const mockRequest = (options: {
  remoteAddress?: string | null;
  ip?: string | null;
}): FastifyRequest =>
  ({
    raw: {
      socket: {
        remoteAddress: options.remoteAddress ?? null,
      },
    },
    ip: (options.ip ?? "") as string,
  } as unknown as FastifyRequest);

describe("getClientIp", () => {
  it("prefers Fastify-resolved request.ip when available", () => {
    const req = mockRequest({ remoteAddress: "203.0.113.5", ip: "198.51.100.8" });
    expect(getClientIp(req)).toBe("198.51.100.8");
  });

  it("falls back to raw socket address when Fastify ip missing", () => {
    const req = mockRequest({ remoteAddress: "203.0.113.5", ip: "" });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("normalizes IPv6 mapped IPv4 addresses", () => {
    const req = mockRequest({ remoteAddress: null, ip: "::ffff:198.51.100.9" });
    expect(getClientIp(req)).toBe("198.51.100.9");
  });
});
