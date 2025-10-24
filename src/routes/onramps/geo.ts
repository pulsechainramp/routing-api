import { FastifyInstance } from "fastify";
import geoip from "geoip-lite";

export default async function geoRoutes(fastify: FastifyInstance) {
  fastify.get("/geo", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            ip: { type: "string" },
            country: { type: ["string", "null"] },
            region: { type: ["string", "null"] },
            city: { type: ["string", "null"] }
          }
        }
      }
    }
  }, async (req) => {
    const ip = req.ip; // set fastify({ trustProxy: true }) if behind a proxy
    const info = ip ? geoip.lookup(ip) : null;
    return { ip, country: info?.country ?? null, region: info?.region ?? null, city: info?.city ?? null };
  });
}
