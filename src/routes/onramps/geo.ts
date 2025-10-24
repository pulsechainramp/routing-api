// routing/src/routes/onramps/geo.ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import geoip from "geoip-lite";

const BAD = new Set(["XX", "T1", "ZZ"]); // unknown/Tor/user-assigned

function pickCountry(req: FastifyRequest): string | null {
  const h = req.headers as Record<string, string | undefined>;
  const candidates = [
    h["cf-ipcountry"],                  // Cloudflare
    h["x-vercel-ip-country"],           // Vercel Functions
    h["cloudfront-viewer-country"],     // AWS CloudFront
    h["x-appengine-country"],           // GAE / some proxies
  ].filter(Boolean).map(v => v!.trim().toUpperCase());

  for (const c of candidates) {
    if (/^[A-Z]{2}$/.test(c) && !BAD.has(c)) return c;
  }

  // Fallback: IP database
  const ip = req.ip;               // trustProxy: true is already set on the server
  const info = ip ? geoip.lookup(ip) : null;
  return info?.country ?? null;
}

export default async function geoRoutes(fastify: FastifyInstance) {
  const handler = async (req: FastifyRequest, reply: any) => {
    const ip = req.ip;
    const country = pickCountry(req);
    const ipInfo = ip ? geoip.lookup(ip) : null;

    // Prevent cross-user caching and key responses on geo inputs
    reply.header("Cache-Control", "private, no-store, max-age=0");
    reply.header(
      "Vary",
      [
        "CF-IPCountry",
        "X-Vercel-IP-Country",
        "CloudFront-Viewer-Country",
        "X-AppEngine-Country",
        "CF-Connecting-IP",
        "X-Forwarded-For",
        "X-Real-IP",
      ].join(", ")
    );

    return {
      ip,
      country: country ?? null,
      region: ipInfo?.region ?? null,
      city: ipInfo?.city ?? null,
    };
  };

  // exposes /onramps/geo due to the plugin prefix
  fastify.get("/geo", { schema: { response: { 200: { type: "object", properties: {
    ip: { type: ["string","null"] }, country: { type: ["string","null"] },
    region: { type: ["string","null"] }, city: { type: ["string","null"] }
  }}}}}, handler);
}
