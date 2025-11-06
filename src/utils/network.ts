import type { FastifyRequest } from "fastify";

/**
 * Return the actual remote socket address without trusting XFF headers.
 * Falls back to Fastify's request.ip when socket information is unavailable.
 */
export function getClientIp(request: FastifyRequest): string {
  const rawSocket = request.raw?.socket ?? (request.raw as any)?.connection;
  const remoteAddress: string | undefined = rawSocket?.remoteAddress;

  if (remoteAddress && typeof remoteAddress === "string") {
    return normalizeIp(remoteAddress);
  }

  return normalizeIp(request.ip);
}

function normalizeIp(ip: string): string {
  if (!ip) {
    return "";
  }

  // Collapse IPv6-mapped IPv4 (e.g. ::ffff:127.0.0.1)
  if (ip.startsWith("::ffff:")) {
    return ip.slice(7);
  }

  return ip;
}
