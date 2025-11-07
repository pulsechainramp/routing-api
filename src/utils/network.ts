import type { FastifyRequest } from "fastify";

/**
 * Return the end-user IP that Fastify resolved (proxy-aware when trustProxy is set),
 * falling back to the raw socket address when proxy details are unavailable.
 */
export function getClientIp(request: FastifyRequest): string {
  const fastifyIp = normalizeIp(request.ip);
  if (fastifyIp) {
    return fastifyIp;
  }

  const rawSocket = request.raw?.socket ?? (request.raw as any)?.connection;
  const remoteAddress: string | undefined = rawSocket?.remoteAddress;

  if (remoteAddress && typeof remoteAddress === "string") {
    return normalizeIp(remoteAddress);
  }

  return "";
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
