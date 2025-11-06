import { getClientIp } from "./network";
import type { FastifyRequest } from "fastify";

const mockRequest = (options: {
  remoteAddress?: string | null;
  ip?: string;
}): FastifyRequest =>
  ({
    raw: {
      socket: {
        remoteAddress: options.remoteAddress ?? null,
      },
    },
    ip: options.ip ?? "",
  } as unknown as FastifyRequest);

describe("getClientIp", () => {
  it("prefers raw socket address when available", () => {
    const req = mockRequest({ remoteAddress: "203.0.113.5", ip: "10.0.0.1" });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  it("normalizes IPv6 mapped IPv4 addresses", () => {
    const req = mockRequest({ remoteAddress: "::ffff:198.51.100.9" });
    expect(getClientIp(req)).toBe("198.51.100.9");
  });

  it("falls back to request.ip when socket address missing", () => {
    const req = mockRequest({ remoteAddress: undefined, ip: "192.0.2.1" });
    expect(getClientIp(req)).toBe("192.0.2.1");
  });
});
