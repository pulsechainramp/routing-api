import { FastifyInstance } from "fastify";
import geoRoutes from "./geo";
import providersRoutes from "./providers";

export default async function onrampsRoutes(fastify: FastifyInstance) {
  await geoRoutes(fastify);
  await providersRoutes(fastify);
}
